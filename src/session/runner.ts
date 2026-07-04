// SessionRunner — event を受けて session を主語に処理するオーケストレーション (Step 3)
//
// docs/design/architecture.md §1 (event は「きっかけ係」、session が「処理の担い手」)、
// §6 (起動と steering のフロー)、docs/design/session-runtime.md §1 (kick シーケンス)、
// §4 (追加メッセージは配達するだけ。注入タイミングは pi が管理する)。
//
// Step 3 のスコープ: lease/linger/turn timeout/workdir flush は持たない (Step 4-6)。
// 排他はインメモリの Map、永続化は同一パスの transcript.jsonl 再利用のみ。

import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	createGate,
	defaultGates,
	evaluateTrigger,
	type Gate,
	type GateCombinator,
	type GateSpec,
} from "../gate/gate.js";
import type { InboundMessage } from "../ingress/chat-event.js";
import type { Logger } from "../logger.js";
import { rootLogger } from "../logger.js";
import type { Reactions } from "../reply/reactions.js";
import type { ReplyRouter } from "../reply/router.js";
import type {
	ChannelDoc,
	Gate as ChannelGateSpec,
} from "../store/channel-doc.js";
import type { ConfigSource } from "../store/config-source.js";
import { type InboxItem, type InboxStore, inboxItemId } from "./inbox.js";
import { extractReply, isAgentEnd, isToolExecutionEnd } from "./rpc.js";
import { PiProcess } from "./runtime.js";

/** app 共通プロンプト。ChannelDoc.systemPrompt はこれへの追記分 (architecture.md §2) */
const APP_SYSTEM_PROMPT = [
	"You are an assistant running inside a Slack thread.",
	"Your response reaches the user ONLY through the reply(thread_key, text) tool;",
	"plain assistant text is never delivered.",
	"If no response is needed, simply do not call reply.",
].join(" ");

export interface SessionRunnerOptions {
	configSource: ConfigSource;
	inbox: InboxStore;
	router: ReplyRouter;
	reactions: Reactions;
	/** pi の `--extension` に渡す reply extension の絶対パス */
	extensionPath: string;
	/** workdir のルート。既定 /tmp/pi-chat-runner/sessions */
	workdirRoot?: string;
	/** pi バイナリ。省略時は PiProcess の既定 (env PI_BIN → "pi") */
	piBinary?: string;
	/** ChannelDoc.model が無いときのモデル (env PI_MODEL 相当) */
	model?: string;
	/** `--provider` (env PI_PROVIDER 相当) */
	provider?: string;
	/** allowlist (PATH/HOME) に追加で pi 子プロセスへ渡す env (session-runtime.md §2) */
	extraEnv?: Record<string, string>;
	logger?: Logger;
}

interface SessionRecord {
	/** starting = spawn 準備中 (多重起動防止のため Map 登録済み)、running = PiProcess 稼働中 */
	state: "starting" | "running";
	process?: PiProcess;
	/** トリガーメッセージの ts (👀 / ✅ の対象) */
	triggerTs: string;
	channelId: string;
	/** kick 開始時刻 (finished ログの durationMs 算出用) */
	startedAt: number;
}

/** thread_key の導出。スレッド外の発言はそのメッセージ自身が thread root になる */
export function threadKeyOf(event: InboundMessage): string {
	return `${event.conversation.channelId}:${event.conversation.threadTs ?? event.id}`;
}

/** イベント 1 件のプロンプト描画 (session-runtime.md §4 の renderEvent) */
export function renderEvent(event: InboundMessage): string {
	return `<${event.sender.id}> のメッセージ:\n${event.text}`;
}

function renderItems(items: InboxItem[]): string {
	return items.map((item) => renderEvent(item.event)).join("\n\n");
}

/**
 * ChannelDoc.trigger.gates (kind に classifier/cooldown も含む広い型) を
 * Step 3 で実装済みの GateSpec へ narrowing する。未対応 kind は warn してスキップ
 * (YAML に classifier を書いても動き続ける。fail-loud にはしない)。
 */
export function toGateSpecs(
	gates: ChannelGateSpec[],
	warn: (message: string) => void = (message) => console.warn(message),
): GateSpec[] {
	const specs: GateSpec[] = [];
	for (const gate of gates) {
		switch (gate.kind) {
			case "mention":
				specs.push({ kind: "mention" });
				break;
			case "keyword":
				// schema 上 pattern 必須だが、型の narrowing のため明示的に確認する
				if (gate.pattern === undefined) {
					warn(`[gate] keyword gate without pattern; skipped`);
					break;
				}
				specs.push({ kind: "keyword", pattern: gate.pattern });
				break;
			case "passthrough":
				specs.push({ kind: "passthrough" });
				break;
			default:
				warn(`[gate] unsupported gate kind "${gate.kind}" (Step 3); skipped`);
		}
	}
	return specs;
}

/** workdir の transcript.jsonl が既に存在するか (pi が既存 transcript を読んで
 * 文脈継続するかどうかの判定。session-runtime.md の再開は専用フローを持たず、
 * 同じ --session パスへの再 spawn だけで実現される)。 */
async function transcriptExists(sessionPath: string): Promise<boolean> {
	try {
		await stat(sessionPath);
		return true;
	} catch {
		return false;
	}
}

export class SessionRunner {
	private readonly sessions = new Map<string, SessionRecord>();
	private readonly configSource: ConfigSource;
	private readonly inbox: InboxStore;
	private readonly router: ReplyRouter;
	private readonly reactions: Reactions;
	private readonly extensionPath: string;
	private readonly workdirRoot: string;
	private readonly piBinary: string | undefined;
	private readonly model: string | undefined;
	private readonly provider: string | undefined;
	private readonly extraEnv: Record<string, string> | undefined;
	private readonly logger: Logger;

	constructor(options: SessionRunnerOptions) {
		this.configSource = options.configSource;
		this.inbox = options.inbox;
		this.router = options.router;
		this.reactions = options.reactions;
		this.extensionPath = options.extensionPath;
		this.workdirRoot = options.workdirRoot ?? "/tmp/pi-chat-runner/sessions";
		this.piBinary = options.piBinary;
		this.model = options.model;
		this.provider = options.provider;
		this.extraEnv = options.extraEnv;
		this.logger = options.logger ?? rootLogger.child({ component: "session" });
	}

	/** 実行中 (起動中含む) のセッション数。テスト・観測用 */
	get activeSessionCount(): number {
		return this.sessions.size;
	}

	async handle(event: InboundMessage): Promise<void> {
		const threadKey = threadKeyOf(event);
		const item: InboxItem = {
			id: inboxItemId(event),
			event,
			enqueuedAt: new Date(),
		};

		// 実行中 (起動中含む) セッションがあるスレッド: gate は通さず同じ inbox へ
		// (architecture.md §6 フロー 6。スレッド内の後続発言は追加指示として扱う)
		const existing = this.sessions.get(threadKey);
		if (existing !== undefined) {
			const fresh = await this.inbox.enqueue(threadKey, item);
			if (!fresh) {
				this.logger.info(
					{ threadKey, itemId: item.id },
					"inbox duplicate skip",
				);
				return;
			}
			// starting 中は初回 prompt の drain が拾う。running なら steer で即配達する
			// (drain してから配達 = agent_end の drain と二重にならない)
			if (existing.state === "running" && existing.process?.running) {
				const items = await this.inbox.drain(threadKey);
				if (items.length > 0) {
					existing.process.steer(renderItems(items));
					this.logger.info(
						{ threadKey, items: items.length },
						"session steered",
					);
				}
			}
			return;
		}

		// 実行中でない: ChannelDoc → gate 評価 → trigger なら enqueue して kick
		const channelId = event.conversation.channelId;
		const doc = await this.loadChannelDoc(channelId);
		const { gates, combinator } = this.resolveGates(doc);
		const decision = await evaluateTrigger(gates, combinator, {
			event,
			recent: [],
		});
		if (!decision.trigger) {
			this.logger.debug(
				{ channelId, threadKey, reason: decision.reason },
				"gate not triggered",
			);
			return;
		}
		this.logger.info(
			{ channelId, threadKey, reason: decision.reason },
			"gate triggered",
		);

		const fresh = await this.inbox.enqueue(threadKey, item);
		if (!fresh) {
			this.logger.info({ threadKey, itemId: item.id }, "inbox duplicate skip");
			return;
		}

		// 多重起動防止: gate 評価の await 中に別イベントが kick 済みかを再確認してから
		// 同期的に Map へ登録する (has → set の間に await を挟まない)。
		// 登録済みなら、上で enqueue した item はそのセッションの drain が拾う
		if (this.sessions.has(threadKey)) return;
		const record: SessionRecord = {
			state: "starting",
			triggerTs: event.id,
			channelId,
			startedAt: Date.now(),
		};
		this.sessions.set(threadKey, record);

		try {
			await this.kick(threadKey, record, event, doc);
		} catch (err) {
			this.sessions.delete(threadKey);
			this.logger.warn({ threadKey, err }, "session kick failed");
		}
	}

	/** kick シーケンス (session-runtime.md §1。Step 3 は restore/flush なしの縮退版) */
	private async kick(
		threadKey: string,
		record: SessionRecord,
		triggerEvent: InboundMessage,
		doc: ChannelDoc | null,
	): Promise<void> {
		const channelId = triggerEvent.conversation.channelId;
		const threadTs = triggerEvent.conversation.threadTs ?? triggerEvent.id;

		// 同 thread_key は常に同じ workdir/transcript.jsonl を使う。再 trigger 時は
		// 同じパスで再 spawn され、pi が JSONL を読んで文脈を継続する (再開の専用フローなし)
		const workdir = join(this.workdirRoot, channelId, threadTs);
		await mkdir(workdir, { recursive: true });
		const sessionPath = join(workdir, "transcript.jsonl");
		const resumed = await transcriptExists(sessionPath);

		const model = doc?.model ?? this.model;
		const proc = new PiProcess({
			sessionPath,
			extensionPath: this.extensionPath,
			cwd: workdir,
			appendSystemPrompt: buildSystemPrompt(threadKey, doc),
			...(this.piBinary !== undefined ? { piBinary: this.piBinary } : {}),
			...(model !== undefined ? { model } : {}),
			...(this.provider !== undefined ? { provider: this.provider } : {}),
			...(this.extraEnv !== undefined ? { extraEnv: this.extraEnv } : {}),
			// pi は正常時にも stderr へ出すことがあるため warn ではなく debug
			logger: (line) => this.logger.debug({ threadKey, line }, "pi stderr"),
		});

		proc.on("event", (piEvent) => {
			if (isToolExecutionEnd(piEvent)) {
				const payload = extractReply(piEvent);
				if (payload !== null) {
					this.router.deliver(payload).catch((err) => {
						this.logger.warn(
							{ threadKey, threadKeyPayload: payload.thread_key, err },
							"reply delivery failed",
						);
					});
				}
				return;
			}
			if (isAgentEnd(piEvent)) {
				void this.onAgentEnd(threadKey, proc).catch((err) => {
					this.logger.warn({ threadKey, err }, "agent_end handling failed");
				});
			}
		});
		proc.on("exit", (code, signal) => {
			// 正常終了パス (onAgentEnd) では Map から除去済み。ここに残っていたら異常終了
			const current = this.sessions.get(threadKey);
			if (current !== undefined && current.process === proc) {
				this.sessions.delete(threadKey);
				this.logger.warn({ threadKey, code, signal }, "pi exited unexpectedly");
			}
		});

		proc.start();
		record.state = "running";
		record.process = proc;

		this.router.register(threadKey, { channelId, threadTs });
		await this.safeReact(
			() => this.reactions.addEyes(channelId, record.triggerTs),
			threadKey,
			"eyes",
		);

		// enqueue 済みの入力 (spawn 準備中に積まれた分を含む) を束ねて初回 prompt にする。
		// ChannelDoc.context は初回のみ先頭に注入する (config.md §4)
		const items = await this.inbox.drain(threadKey);
		const body =
			items.length > 0 ? renderItems(items) : renderEvent(triggerEvent);
		proc.prompt(prependContext(body, doc));
		this.logger.info(
			{
				threadKey,
				workdir,
				resumed,
				model,
				provider: this.provider,
				items: items.length,
			},
			"session started",
		);
	}

	/** agent_end: 残り入力があれば次の prompt (連投の取りこぼし防止)、無ければ ✅ で終了 */
	private async onAgentEnd(threadKey: string, proc: PiProcess): Promise<void> {
		const record = this.sessions.get(threadKey);
		if (record === undefined || record.process !== proc) return;

		const items = await this.inbox.drain(threadKey);
		if (items.length > 0) {
			proc.prompt(renderItems(items));
			this.logger.info({ threadKey, items: items.length }, "session continued");
			return;
		}

		// reply が 1 度も呼ばれなくても沈黙のまま ✅ を付けて終える (build-plan Step 3)
		this.sessions.delete(threadKey);
		await this.safeReact(
			() => this.reactions.addCheck(record.channelId, record.triggerTs),
			threadKey,
			"check",
		);
		await proc.stop();
		this.logger.info(
			{ threadKey, durationMs: Date.now() - record.startedAt },
			"session finished",
		);
	}

	private async loadChannelDoc(channelId: string): Promise<ChannelDoc | null> {
		try {
			return await this.configSource.channel(channelId);
		} catch (err) {
			// YAML の壊れで受信ループを止めない。既定動作 (mention 起動) に落とす
			this.logger.warn({ channelId, err }, "failed to load channel doc");
			return null;
		}
	}

	private resolveGates(doc: ChannelDoc | null): {
		gates: Gate[];
		combinator: GateCombinator;
	} {
		if (doc?.trigger === undefined) {
			// doc なし / trigger 未設定は既定 = mention のみ (session-model.md §5)
			return { gates: defaultGates(), combinator: "any" };
		}
		const specs = toGateSpecs(doc.trigger.gates, (message) =>
			this.logger.warn(message),
		);
		return {
			gates: specs.map((spec) => createGate(spec)),
			combinator: doc.trigger.combinator,
		};
	}

	/** リアクションは装飾なので、失敗してもセッションを止めない */
	private async safeReact(
		fn: () => Promise<void>,
		threadKey: string,
		label: string,
	): Promise<void> {
		try {
			await fn();
		} catch (err) {
			this.logger.warn({ threadKey, label, err }, "failed to add reaction");
		}
	}
}

/** app 共通 + ChannelDoc.systemPrompt + thread_key の指示 (session-runtime.md §2) */
function buildSystemPrompt(threadKey: string, doc: ChannelDoc | null): string {
	const parts = [APP_SYSTEM_PROMPT];
	if (doc?.systemPrompt !== undefined) parts.push(doc.systemPrompt.trim());
	parts.push(
		`When calling the reply tool, use exactly this thread_key: ${threadKey}`,
	);
	return parts.join("\n\n");
}

function prependContext(body: string, doc: ChannelDoc | null): string {
	const context = doc?.context;
	if (context === undefined || context.length === 0) return body;
	return `参考情報:\n${context.map((c) => c.trim()).join("\n\n")}\n\n${body}`;
}
