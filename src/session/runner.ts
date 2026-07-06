// SessionRunner — event を受けて session を主語に処理するオーケストレーション (Step 4)
//
// docs/design/architecture.md §1 (event は「きっかけ係」、session が「処理の担い手」)、
// §6 (起動と steering のフロー)、docs/design/session-runtime.md §1 (kick シーケンス)、
// §3 (tmpfs + 境界 flush)、docs/design/persistence.md §1 (Store 群)、§3 (flush → ack の順序)。
//
// Step 4 のスコープ: lease による多重起動の排他、drain/ack 分離 (drain は非破壊。
// プロンプト済み item の記憶と重複除外は runner のインメモリ責務)、agent_end 後の
// linger による追いメッセージ拾い直し、WorkdirStorage による境界退避 (未指定なら
// Step 3 相当のローカル置きっぱなし)。turn timeout (Step 6) もここで実装する
// (session-runtime.md §6「ターンにタイムアウトを設け、超過したら pi を kill」)。

import {
	chmod,
	chown,
	lstat,
	mkdir,
	readdir,
	realpath,
	rename,
	stat,
} from "node:fs/promises";
import { hostname } from "node:os";
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
import type { ChannelDoc, GateConfig } from "../store/channel-doc.js";
import { type ConfigSource, DM_CHANNEL } from "../store/config-source.js";
import { inboxItemId } from "../store/inbox-item.js";
import type { InboxItem, Lease, StateStore } from "../store/interfaces.js";
import type { WorkdirStorage } from "../store/workdir-storage.js";
import {
	extractReply,
	extractTurnErrors,
	extractUsageTotals,
	isAgentEnd,
	isToolExecutionEnd,
	piEventLogFields,
	type UsageTotals,
} from "./rpc.js";
import { buildPiPermissionOptions, PiProcess } from "./runtime.js";

/** app 共通プロンプト。ChannelDoc.systemPrompt はこれへの追記分 (architecture.md §2) */
const APP_SYSTEM_PROMPT = [
	"You are an assistant running inside a Slack thread.",
	"Your response reaches the user ONLY through the reply(thread_key, text) tool;",
	"plain assistant text is never delivered.",
	"If no response is needed, simply do not call reply.",
	"Users appear as `name (USER_ID)`; to @-mention one in a reply,",
	"write `<@USER_ID>` (e.g. `<@U12345>`), not the plain name.",
].join(" ");

/** Node Permission Model 有効化の静的パラメタ (session-runtime.md §6)。
 * workdir / home はセッションごとに決まるため kick 時に buildPiPermissionOptions
 * へ都度渡す — ここに載るのはイメージ内で固定のパスだけ */
export interface PiPermissionConfig {
	/** pi 本体のエントリポイント JS の絶対パス (npm -g 実体。docker で
	 * `readlink -f $(which pi)` して確定させる) */
	entrypoint: string;
	/** pi 本体・依存が入る npm global の node_modules ルート (`npm root -g`) */
	nodeModulesDir: string;
	/** `/app` 相当 (extension・skill 焼き込み先) */
	appDir: string;
	/** 追加で write を許可したいパス (例 "/tmp/*")。既定なし */
	extraWrite?: string[];
	/** 追加で read を許可したいパス (例 GOOGLE_APPLICATION_CREDENTIALS のファイル
	 * パス。HOME を agentHome に固定するとローカルのユーザー ADC は HOME 経由で
	 * 見えなくなるため、明示指定されたファイルだけ個別に許可する)。既定なし */
	extraRead?: string[];
}

export interface SessionRunnerOptions {
	configSource: ConfigSource;
	/** 永続化 Store 群 (inbox / sessions / leases)。persistence.md §1 */
	store: StateStore;
	router: ReplyRouter;
	reactions: Reactions;
	/** workdir の境界退避。未指定なら restore/flush をスキップ (Step 3 相当) */
	workdirStorage?: WorkdirStorage;
	/** pi の `--extension` に渡す extension の絶対パス群 (reply + permission-gate 等)。
	 * すべて常時注入する (permission-gate は事故防止層なので無効化オプションは持たない) */
	extensionPaths: string[];
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
	/** pi 子プロセスの実行 uid/gid (session-runtime.md §6: UID 分離)。両方指定時のみ有効。
	 * 有効な場合のみ workdir の chown/chmod を行う (無効時は現状動作を維持) */
	agentUid?: number;
	agentGid?: number;
	/** pi 子プロセスへ常に HOME として渡すディレクトリ (既定 "/home/agent")。
	 * UID 分離の有無に関わらず常にこれを HOME にする — コンテナ側で設定・skill を
	 * 固定パスに配置できるようにするため、また Node Permission Model の allow パス
	 * (`${home}/*`) と実際の HOME をズレなく一致させるため (session-runtime.md §6) */
	agentHome?: string;
	/** Node Permission Model 経由での起動を有効にする設定 (opt-in。未指定なら
	 * 現状動作 = pi をそのまま spawn する。pi-tools-and-sandbox.md 「リーズナブルな
	 * sandbox レイヤ案」、Cloud Run 実イメージでのみ有効化する想定) */
	piPermission?: PiPermissionConfig;
	/** lease の TTL。既定 60_000ms。renew は ttl/3 間隔 */
	leaseTtlMs?: number;
	/** agent_end 後に追いメッセージを待つ時間。既定 3_000ms */
	lingerMs?: number;
	/** 1 ターン (prompt/steer 送信から agent_end まで) の上限。既定 600_000ms (10 分)。
	 * 超過したら pi を kill してセッションを異常終了として畳む
	 * (session-runtime.md §6: 「ターンにタイムアウトを設け、超過したら pi を kill」) */
	turnTimeoutMs?: number;
	/** lease の owner 識別子。既定 `hostname:pid` */
	owner?: string;
	logger?: Logger;
}

interface SessionRecord {
	/** starting = spawn 準備中 (多重起動防止のため Map 登録済み)、
	 * running = PiProcess 稼働中、stopping = 終了処理中 (exit を異常扱いしない) */
	state: "starting" | "running" | "stopping";
	process?: PiProcess;
	/** トリガーメッセージの ts (👀 / ✅ の対象) */
	triggerTs: string;
	channelId: string;
	threadTs: string;
	workdir: string;
	/** kick 時に導出した session.mode / reply.mode。promptPending / kick から
	 * 参照して宛先登録・フォールバック登録に使う (session-model.md §3) */
	policy: SessionPolicy;
	/** kick 開始時刻 (finished ログの durationMs 算出用) */
	startedAt: number;
	/** このプロセスが保持する実行ロック。renew に失敗したら排他を失っている */
	lease: Lease;
	/** このセッションで prompt/steer 済みの item id。drain は非破壊 (未 ack 全件を
	 * 返す) なので、重複除外はこのインメモリ記憶で行う (persistence.md §1) */
	promptedIds: Set<string>;
	/** prompt/steer を送るたびに増える世代。agent_end 処理中に増えていたら
	 * 新しいターンが走り出しているので、終了判定をそのターンの agent_end に譲る */
	turnEpoch: number;
	renewTimer: NodeJS.Timeout | undefined;
	/** 現ターンの timeout タイマー。prompt/steer 送信 (turnEpoch 増加箇所) ごとに
	 * リセットし、agent_end 冒頭でクリアする。セッション終了パスでも必ずクリアする
	 * (session-runtime.md §6 の turn timeout) */
	turnTimeoutTimer: NodeJS.Timeout | undefined;
	/** 直近の agent_end から集計した usage の累計 (agent_end.messages は毎回全履歴
	 * を返すため、ターンごとの増分ではなくセッション累計になる) */
	usageTotals?: UsageTotals;
}

/** debounce 待機中のレーンの状態 (trigger.debounceSec。design 「連投バーストの途中で
 * 不完全な入力のままセッションを起動しないよう、静まるまで kick を遅らせる」)。
 * item は kick 前から inbox に enqueue 済みなので、この状態自体はプロセス死からの
 * 復旧対象ではない (拾い直しは既存の inbox 経路に乗る) */
interface PendingKick {
	timer: NodeJS.Timeout;
	/** hard cap 算出の基準 (最初に滞留させたメッセージの到着時刻) */
	firstPendingAtMs: number;
	debounceSec: number;
	/** タイマー発火時に kick する対象。直近のイベントで都度更新する */
	triggerEvent: InboundMessage;
	doc: ChannelDoc | null;
	channelId: string;
}

/** session.mode / reply.mode の実効値 (doc 未設定時の既定込み。session-model.md §3) */
export interface SessionPolicy {
	sessionMode: "thread" | "channel";
	replyMode: "thread" | "flat";
}

/** ChannelDoc.session / ChannelDoc.reply からポリシーを導出する。DM は既定
 * session: channel, reply: flat (session-model.md §3 「DM は予約名 dm の既定」) */
export function resolveSessionPolicy(
	doc: ChannelDoc | null,
	isDm: boolean,
): SessionPolicy {
	return {
		sessionMode: doc?.session?.mode ?? (isDm ? "channel" : "thread"),
		replyMode: doc?.reply?.mode ?? (isDm ? "flat" : "thread"),
	};
}

/** セッション (文脈) キーの導出。sessionMode "thread" は現行 threadKeyOf と同じ
 * (channelId:threadTs ?? メッセージ ts)、"channel" は channelId のみ
 * (session-model.md §3) */
export function sessionKeyOf(
	event: InboundMessage,
	policy: SessionPolicy,
): string {
	if (policy.sessionMode === "channel") {
		return event.conversation.channelId;
	}
	return `${event.conversation.channelId}:${event.conversation.threadTs ?? event.id}`;
}

/** 返信宛先キーの導出。メッセージごとに発行し、sessionKey とは独立に
 * トリガーメッセージの位置を指す (session-model.md §3) */
export function replyThreadKeyOf(event: InboundMessage): string {
	return `${event.conversation.channelId}:${event.conversation.threadTs ?? event.id}`;
}

/** イベント 1 件のプロンプト描画 (session-runtime.md §4 の renderEvent)。
 * threadKey 指定時はヘッダに thread_key を注記し、エージェントが reply 時に
 * どの宛先へ返すべきかを判別できるようにする (session-model.md §3) */
// 表示名だけにすると pi が mention (`<@U123>`) を組み立てられなくなるため、
// UserID は常に併記する
export function renderEvent(event: InboundMessage, threadKey?: string): string {
	const sender =
		event.sender.displayName !== undefined
			? `${event.sender.displayName} (${event.sender.id})`
			: event.sender.id;
	const header =
		threadKey !== undefined
			? `<${sender}> のメッセージ (thread_key: ${threadKey}):`
			: `<${sender}> のメッセージ:`;
	return `${header}\n${event.text}`;
}

function renderItems(items: InboxItem[]): string {
	return items
		.map((item) => renderEvent(item.event, replyThreadKeyOf(item.event)))
		.join("\n\n");
}

/**
 * ChannelDoc.trigger.gates (kind に classifier/cooldown も含む広い型) を
 * Step 3 で実装済みの GateSpec へ narrowing する。未対応 kind は warn してスキップ
 * (YAML に classifier を書いても動き続ける。fail-loud にはしない)。
 */
export function toGateSpecs(
	gates: GateConfig[],
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
					warn("keyword gate without pattern; skipped");
					break;
				}
				specs.push({ kind: "keyword", pattern: gate.pattern });
				break;
			case "passthrough":
				specs.push({ kind: "passthrough" });
				break;
			default:
				warn(`unsupported gate kind "${gate.kind}"; skipped`);
		}
	}
	return specs;
}

/** workdir の transcript.jsonl が既に存在するか (pi が既存 transcript を読んで
 * 文脈継続するかどうかの判定。restore 後に評価すれば保存棚からの復元も拾える)。 */
async function transcriptExists(sessionPath: string): Promise<boolean> {
	try {
		await stat(sessionPath);
		return true;
	} catch {
		return false;
	}
}

/** 前回活動時刻から idleResetMinutes を超えたかどうかの判定 (session-model.md §3:
 * 時間はキーに入れず、リセットポリシーとして updated_at に対して評価する)。
 * 純関数として export しテストする */
export function isIdleExpired(
	lastUpdatedAt: Date,
	idleResetMinutes: number,
	now: number,
): boolean {
	return now - lastUpdatedAt.getTime() > idleResetMinutes * 60_000;
}

/** debounce の kick までの残り ms を求める (連投バーストの間、静まるまで kick を
 * 遅らせるための純関数)。「最後のメッセージ + debounceSec」まで延ばすが、
 * 「最初の滞留メッセージ + debounceSec*3」(hard cap) を超えない — 早い方を採用し、
 * 負なら 0 (即 kick) を返す */
export function computeKickDelayMs(args: {
	nowMs: number;
	firstPendingAtMs: number;
	debounceSec: number;
}): number {
	const { nowMs, firstPendingAtMs, debounceSec } = args;
	const slideUntil = nowMs + debounceSec * 1000;
	const hardCapUntil = firstPendingAtMs + debounceSec * 3 * 1000;
	const until = Math.min(slideUntil, hardCapUntil);
	return Math.max(0, until - nowMs);
}

/** channel モードの idle リセット (session-model.md §3): workdir 直下の
 * transcript.jsonl が存在すれば transcript-<epoch ms>.jsonl にリネームして世代交代する。
 * pi は transcript が無ければ新規会話として開始する。workdir の他のファイルは残す */
async function rotateTranscript(workdir: string, now: number): Promise<void> {
	const from = join(workdir, "transcript.jsonl");
	const to = join(workdir, `transcript-${now}.jsonl`);
	try {
		await rename(from, to);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
		throw err;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** dir 配下 (dir 自身含む) を再帰的に chown する。UID 分離時、restore で
 * root 所有のままコピーされたファイルを agent 所有に揃えるための最小実装
 * (エントリ数が少ない workdir 前提。fs.cp に uid/gid オプションは無いため
 * コピー後にここで chown する)。
 * シンボリックリンクは辿らずスキップする: pi が workdir 内に /data 等への
 * リンクを仕込み、次の restore 後に root の Runner がリンク先を chown して
 * 所有権を奪われる経路を防ぐ (リンク自体の所有者は挙動に影響しない) */
async function chownRecursive(
	dir: string,
	uid: number,
	gid: number,
): Promise<void> {
	await chown(dir, uid, gid);
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
		throw err;
	}
	for (const entry of entries) {
		const path = join(dir, entry);
		const info = await lstat(path).catch(() => null);
		if (info === null || info.isSymbolicLink()) continue;
		if (info.isDirectory()) {
			await chownRecursive(path, uid, gid);
		} else {
			await chown(path, uid, gid);
		}
	}
}

export class SessionRunner {
	private readonly sessions = new Map<string, SessionRecord>();
	/** debounceSec 待機中のレーン (sessionKey → 保留状態)。design 「セッション非稼働
	 * レーンで gate 通過 → inbox enqueue した後、即 kick する代わりにレーンごとの
	 * タイマーで kick を遅らせる」 */
	private readonly pendingKicks = new Map<string, PendingKick>();
	private readonly configSource: ConfigSource;
	private readonly store: StateStore;
	private readonly router: ReplyRouter;
	private readonly reactions: Reactions;
	private readonly workdirStorage: WorkdirStorage | undefined;
	private readonly extensionPaths: string[];
	private readonly workdirRoot: string;
	private readonly piBinary: string | undefined;
	private readonly model: string | undefined;
	private readonly provider: string | undefined;
	private readonly extraEnv: Record<string, string> | undefined;
	private readonly agentUid: number | undefined;
	private readonly agentGid: number | undefined;
	private readonly agentHome: string;
	private readonly piPermission: PiPermissionConfig | undefined;
	private readonly leaseTtlMs: number;
	private readonly lingerMs: number;
	private readonly turnTimeoutMs: number;
	private readonly owner: string;
	private readonly logger: Logger;

	constructor(options: SessionRunnerOptions) {
		this.configSource = options.configSource;
		this.store = options.store;
		this.router = options.router;
		this.reactions = options.reactions;
		this.workdirStorage = options.workdirStorage;
		this.extensionPaths = options.extensionPaths;
		this.workdirRoot = options.workdirRoot ?? "/tmp/pi-chat-runner/sessions";
		this.piBinary = options.piBinary;
		this.model = options.model;
		this.provider = options.provider;
		this.extraEnv = options.extraEnv;
		this.agentUid = options.agentUid;
		this.agentGid = options.agentGid;
		this.agentHome = options.agentHome ?? "/home/agent";
		this.piPermission = options.piPermission;
		this.leaseTtlMs = options.leaseTtlMs ?? 60_000;
		this.lingerMs = options.lingerMs ?? 3_000;
		this.turnTimeoutMs = options.turnTimeoutMs ?? 600_000;
		this.owner = options.owner ?? `${hostname()}:${process.pid}`;
		this.logger = options.logger ?? rootLogger.child({ component: "session" });
	}

	/** 実行中 (起動中含む) のセッション数。テスト・観測用 */
	get activeSessionCount(): number {
		return this.sessions.size;
	}

	async handle(event: InboundMessage): Promise<void> {
		const channelId = event.conversation.channelId;
		const isDm = event.conversation.isDm === true;
		// DM は channelId 個別の doc ではなく予約名 "dm" の doc を全 DM 共通で参照する
		// (config.md §1, §2)。セッション自体は実 channelId (D...) で管理する
		const doc = await this.loadChannelDoc(isDm ? DM_CHANNEL : channelId);
		const policy = resolveSessionPolicy(doc, isDm);
		const sessionKey = sessionKeyOf(event, policy);
		const item: InboxItem = {
			id: inboxItemId(event),
			event,
			enqueuedAt: new Date(),
		};

		// 実行中 (起動中含む) セッションがあるレーン: gate は通さず enqueue して
		// steer で配達 (architecture.md §6 フロー 6。後続発言は追加指示として扱う)。
		// enqueue は「セッションあり or gate 通過」のときだけ行う — gate 非通過の
		// 全メッセージを永続 store に溜め込まない (dedupe は enqueue 時に効く)
		const existing = this.sessions.get(sessionKey);
		if (existing !== undefined) {
			const fresh = await this.store.inbox.enqueue(sessionKey, item);
			if (!fresh) {
				this.logger.debug(
					{ sessionKey, itemId: item.id },
					"inbox duplicate skip",
				);
				return;
			}
			// starting 中は初回 prompt の drain が拾う。running なら steer で即配達する
			if (existing.state === "running" && existing.process?.running) {
				const items = await this.store.inbox.drain(sessionKey);
				const pending = items.filter((i) => !existing.promptedIds.has(i.id));
				if (pending.length > 0) {
					// steer 前に宛先登録 (session-model.md §3 の境界規則)
					for (const p of pending) {
						this.registerReplyDestination(p.event, existing.policy);
					}
					for (const p of pending) existing.promptedIds.add(p.id);
					existing.turnEpoch += 1;
					this.resetTurnTimeout(sessionKey, existing);
					existing.process.steer(renderItems(pending));
					this.logger.info(
						{ sessionKey, items: pending.length },
						"session steered",
					);
				}
			}
			return;
		}

		// 実行中でない: gate 評価 → trigger なら enqueue して kick (即 or debounce)
		const { gates, combinator } = this.resolveGates(doc, isDm);
		const decision = await evaluateTrigger(gates, combinator, {
			event,
			recent: [],
		});
		if (!decision.trigger) {
			this.logger.debug(
				{ channelId, sessionKey, reason: decision.reason },
				"gate not triggered",
			);
			return;
		}
		this.logger.info(
			{ channelId, sessionKey, reason: decision.reason },
			"gate triggered",
		);
		this.warnCooldownIfUnsupported(doc, sessionKey);

		// gate 通過が確定してから耐久キューへ積む (dedupe = at-least-once の再送吸収)。
		// item はここで既に永続化されるため、この後 debounce タイマーで kick を遅らせても
		// プロセス死で消えない (拾い直しは既存の inbox 経路に乗る)
		const fresh = await this.store.inbox.enqueue(sessionKey, item);
		if (!fresh) {
			this.logger.debug(
				{ sessionKey, itemId: item.id },
				"inbox duplicate skip",
			);
			return;
		}

		// 多重起動防止: gate 評価の await 中に別イベントが kick 済みなら、
		// 上で enqueue した item はそのセッションの drain が拾う
		if (this.sessions.has(sessionKey)) return;

		const debounceSec = doc?.trigger?.debounceSec;
		if (debounceSec !== undefined && event.mentionsBot !== true) {
			this.scheduleDebouncedKick(
				sessionKey,
				channelId,
				policy,
				event,
				doc,
				debounceSec,
			);
			return;
		}

		// mentionsBot による即 kick バイパス: 同レーンの保留タイマーがあれば
		// キャンセルする (item は inbox にあるので初回 prompt の drain がまとめて拾う)
		this.clearPendingKick(sessionKey);
		await this.acquireLeaseAndKick(sessionKey, channelId, policy, event, doc);
	}

	/** debounceSec のスライディングタイマーを (再)セットする。既存タイマーがあれば
	 * firstPendingAtMs を維持したまま張り直し、無ければ新規に開始する
	 * (design: 「後続メッセージが来るたび『最後のメッセージ + debounceSec』に延長。
	 * ただし hard cap を超えては延ばさない」) */
	private scheduleDebouncedKick(
		sessionKey: string,
		channelId: string,
		policy: SessionPolicy,
		event: InboundMessage,
		doc: ChannelDoc | null,
		debounceSec: number,
	): void {
		const existing = this.pendingKicks.get(sessionKey);
		const nowMs = Date.now();
		const firstPendingAtMs = existing?.firstPendingAtMs ?? nowMs;
		if (existing !== undefined) clearTimeout(existing.timer);

		const delayMs = computeKickDelayMs({
			nowMs,
			firstPendingAtMs,
			debounceSec,
		});
		const timer = setTimeout(() => {
			this.pendingKicks.delete(sessionKey);
			void this.fireDebouncedKick(
				sessionKey,
				channelId,
				policy,
				event,
				doc,
			).catch((err) => {
				this.logger.warn({ sessionKey, err }, "debounced kick failed");
			});
		}, delayMs);
		timer.unref();
		this.pendingKicks.set(sessionKey, {
			timer,
			firstPendingAtMs,
			debounceSec,
			triggerEvent: event,
			doc,
			channelId,
		});
		this.logger.debug(
			{ sessionKey, delayMs, firstPendingAtMs },
			"kick debounced",
		);
	}

	/** debounce タイマー発火時の kick 試行。発火までの間に別経路 (mentionsBot バイパス
	 * 等) で既にセッションが起動していたら何もしない — item は既存の drain が拾う */
	private async fireDebouncedKick(
		sessionKey: string,
		channelId: string,
		policy: SessionPolicy,
		event: InboundMessage,
		doc: ChannelDoc | null,
	): Promise<void> {
		if (this.sessions.has(sessionKey)) return;
		await this.acquireLeaseAndKick(sessionKey, channelId, policy, event, doc);
	}

	/** 保留中の debounce タイマーがあればキャンセルして Map から消す (mentionsBot の
	 * 即 kick バイパス、または debounce 前提が崩れた場合の後始末) */
	private clearPendingKick(sessionKey: string): void {
		const pending = this.pendingKicks.get(sessionKey);
		if (pending === undefined) return;
		clearTimeout(pending.timer);
		this.pendingKicks.delete(sessionKey);
	}

	/** 実行ロックを取って kick する (即時 kick と debounce タイマー発火の両方から共有)。
	 * lease が取れない・二重 kick になりそうなケースはログのみで戻る — item は
	 * enqueue 済みなので保持者側の drain (steer / agent_end / linger) が拾う */
	private async acquireLeaseAndKick(
		sessionKey: string,
		channelId: string,
		policy: SessionPolicy,
		event: InboundMessage,
		doc: ChannelDoc | null,
	): Promise<void> {
		// 実行ロック。取れなければ別プロセスが保持中 — enqueue 済みなので
		// 保持者側の drain (steer / agent_end / linger) が拾う
		const lease = await this.store.leases.acquire(
			sessionKey,
			this.owner,
			this.leaseTtlMs,
		);
		if (lease === null) {
			this.logger.info(
				{ sessionKey, itemId: inboxItemId(event) },
				"lease held by another process; enqueued only",
			);
			return;
		}
		if (this.sessions.has(sessionKey)) {
			// acquire の await 中にローカルの別イベントが kick した (そちらが lease を
			// 取れているはずなので通常到達しないが、二重 kick だけは防ぐ)
			await this.store.leases.release(lease);
			return;
		}

		const threadTs = event.conversation.threadTs ?? event.id;
		const record: SessionRecord = {
			state: "starting",
			triggerTs: event.id,
			channelId,
			threadTs,
			workdir: join(
				this.workdirRoot,
				channelId,
				policy.sessionMode === "channel" ? "channel" : threadTs,
			),
			policy,
			startedAt: Date.now(),
			lease,
			promptedIds: new Set(),
			turnEpoch: 0,
			renewTimer: undefined,
			turnTimeoutTimer: undefined,
		};
		this.sessions.set(sessionKey, record);

		try {
			await this.kick(sessionKey, record, event, doc);
		} catch (err) {
			// enqueue 済み item は ack されていないので、同レーンの次のイベント
			// (または再送) で再 kick され拾い直される (persistence.md §4)
			this.sessions.delete(sessionKey);
			this.stopRenewTimer(record);
			this.clearTurnTimeout(record);
			try {
				await record.process?.stop();
			} catch {
				// spawn 途中の失敗など。stop は best-effort でよい
			}
			await this.store.leases.release(lease);
			this.logger.warn({ sessionKey, err }, "session kick failed");
		}
	}

	/** reply 宛先の登録 (メッセージごと。session-model.md §3)。境界規則:
	 * スレッド内のトリガーは reply.mode に関わらずそのスレッドへ返す。
	 * reply.mode が効くのはチャンネル直下トリガーの返信先だけ */
	private registerReplyDestination(
		event: InboundMessage,
		policy: SessionPolicy,
	): string {
		const channelId = event.conversation.channelId;
		const key = replyThreadKeyOf(event);
		if (event.conversation.threadTs !== undefined) {
			this.router.register(key, {
				channelId,
				threadTs: event.conversation.threadTs,
			});
		} else if (policy.replyMode === "thread") {
			// 新スレッドを起こす (トリガーメッセージ自身を thread root にする)
			this.router.register(key, { channelId, threadTs: event.id });
		} else {
			// フラット (チャンネル直下)
			this.router.register(key, { channelId });
		}
		return key;
	}

	/** kick シーケンス (session-runtime.md §1: restore → spawn → prompt) */
	private async kick(
		sessionKey: string,
		record: SessionRecord,
		triggerEvent: InboundMessage,
		doc: ChannelDoc | null,
	): Promise<void> {
		const { channelId, threadTs, workdir, policy } = record;

		// session.mode=thread かつ reply.mode=flat は文脈が切れるのに返事だけ散らばる
		// 非推奨な組み合わせ。動作は許可するので warn のみ (session-model.md §3)
		if (policy.sessionMode === "thread" && policy.replyMode === "flat") {
			this.logger.warn(
				{ sessionKey, channelId },
				"session.mode=thread with reply.mode=flat is discouraged (session-model.md §3)",
			);
		}
		// idleResetMinutes / maxTranscriptKb は channel モード専用 (session-model.md §3)。
		// thread モードで設定されていても効果がないため warn して無視する
		if (
			policy.sessionMode === "thread" &&
			(doc?.session?.idleResetMinutes !== undefined ||
				doc?.session?.maxTranscriptKb !== undefined)
		) {
			this.logger.warn(
				{ sessionKey, channelId },
				"session.idleResetMinutes / maxTranscriptKb are only effective with session.mode=channel; ignored",
			);
		}

		// 同 sessionKey は常に同じ workdir/transcript.jsonl を使う。再 trigger 時は
		// 同じパスで再 spawn され、pi が JSONL を読んで文脈を継続する (再開の専用フローなし)
		await mkdir(workdir, { recursive: true });
		if (this.workdirStorage !== undefined) {
			await this.workdirStorage.restore(sessionKey, workdir);
		}
		// channel モードの世代交代 (session-model.md §3): idle 超過 または transcript
		// サイズ超過のいずれかで transcript を世代交代する。rotate は chown より前
		// (rotate されたファイルの所有権も chown で揃うため)。判定は idle → size の順で
		// 独立に行うが、rotate 自体は最大 1 回 (idle が発動したら size 判定は省略する)
		if (policy.sessionMode === "channel") {
			let rotated = false;
			const idleResetMinutes = doc?.session?.idleResetMinutes;
			if (idleResetMinutes !== undefined) {
				const previous = await this.store.sessions.get(sessionKey);
				if (previous !== null) {
					const now = Date.now();
					if (isIdleExpired(previous.updatedAt, idleResetMinutes, now)) {
						await rotateTranscript(workdir, now);
						rotated = true;
						this.logger.info(
							{
								sessionKey,
								idleResetMinutes,
								idleMs: now - previous.updatedAt.getTime(),
							},
							"idle reset: transcript rotated",
						);
					}
				}
			}
			const maxTranscriptKb = doc?.session?.maxTranscriptKb;
			if (!rotated && maxTranscriptKb !== undefined) {
				const info = await stat(join(workdir, "transcript.jsonl")).catch(
					(err) => {
						if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
						throw err;
					},
				);
				if (info !== null && info.size > maxTranscriptKb * 1024) {
					const now = Date.now();
					await rotateTranscript(workdir, now);
					this.logger.info(
						{ sessionKey, maxTranscriptKb, sizeBytes: info.size },
						"size reset: transcript rotated",
					);
				}
			}
		}
		// UID 分離 (session-runtime.md §6) が有効なら、workdir を agent 所有 0700 に
		// する。mkdir は Runner (root) 実行なので root 所有で作られ、restore で
		// コピーされたファイルも root 所有になる — agent uid で書き込めるよう
		// restore 後に再帰的に chown する (root だけが chown できるので、この処理は
		// uid オプションが設定されているときだけ行う)
		if (this.agentUid !== undefined && this.agentGid !== undefined) {
			await chownRecursive(workdir, this.agentUid, this.agentGid);
			await chmod(workdir, 0o700);
		}
		// agentHome は常に pi の HOME になるため、存在しなければここで作る
		// (Dockerfile の useradd --create-home で作成済みならほぼ no-op だが、
		// PI_AGENT_HOME で既定と異なるパスを指定した場合に備える)。UID 分離が
		// 有効なら workdir と同様に agent 所有 0700 に揃える
		await mkdir(this.agentHome, { recursive: true });
		if (this.agentUid !== undefined && this.agentGid !== undefined) {
			await chownRecursive(this.agentHome, this.agentUid, this.agentGid);
			await chmod(this.agentHome, 0o700);
		}
		// pi は cwd を canonicalize してから trust probe / migration の existsSync を
		// 行う (dist/core/trust-manager.js の normalizeCwd)。macOS では /tmp が
		// /private/tmp への symlink のため、allow パス・cwd・HOME も realpath で
		// 正規化して渡さないと Permission Model の判定と食い違い pi が即死する
		// (Linux では通常 no-op)
		const workdirReal = await realpath(workdir);
		const agentHomeReal = await realpath(this.agentHome);
		const sessionPath = join(workdirReal, "transcript.jsonl");
		const resumed = await transcriptExists(sessionPath);

		const model = doc?.model ?? this.model;
		// 常に HOME を agentHome に上書きする (Runner 自身の HOME は継承しない)。
		// extraEnv で HOME を上書きする (buildPiEnv は extraEnv が PATH/HOME を
		// 上書きできる実装になっている)
		const extraEnv = { ...this.extraEnv, HOME: agentHomeReal };
		// Node Permission Model (session-runtime.md §6, pi-tools-and-sandbox.md
		// 「リーズナブルな sandbox レイヤ案」) が opt-in で有効なら、pi 本体の
		// JS 実装ツール (read/write/edit/grep) の fs アクセスをこのセッションの
		// workdir/home に閉じ込める。home は pi 子プロセスに渡す HOME (常に agentHome)
		// と揃える — ズレると pi 起動時の ~/.pi probe (auth.json migration 等) が
		// ERR_ACCESS_DENIED になり pi が exit 1 で即死する
		const home = agentHomeReal;
		const permission =
			this.piPermission !== undefined
				? buildPiPermissionOptions({
						entrypoint: this.piPermission.entrypoint,
						nodeModulesDir: this.piPermission.nodeModulesDir,
						appDir: this.piPermission.appDir,
						workdir: workdirReal,
						home,
						...(this.piPermission.extraWrite !== undefined
							? { extraWrite: this.piPermission.extraWrite }
							: {}),
						...(this.piPermission.extraRead !== undefined
							? { extraRead: this.piPermission.extraRead }
							: {}),
					})
				: undefined;
		const proc = new PiProcess({
			sessionPath,
			extensionPaths: this.extensionPaths,
			cwd: workdirReal,
			appendSystemPrompt: buildSystemPrompt(sessionKey, doc),
			...(this.piBinary !== undefined ? { piBinary: this.piBinary } : {}),
			...(model !== undefined ? { model } : {}),
			...(this.provider !== undefined ? { provider: this.provider } : {}),
			...(doc?.tools !== undefined ? { tools: doc.tools } : {}),
			...(doc?.excludeTools !== undefined
				? { excludeTools: doc.excludeTools }
				: {}),
			...(extraEnv !== undefined ? { extraEnv } : {}),
			...(this.agentUid !== undefined ? { uid: this.agentUid } : {}),
			...(this.agentGid !== undefined ? { gid: this.agentGid } : {}),
			...(permission !== undefined ? { permission } : {}),
			// pi は正常時にも stderr へ出すことがあるため warn ではなく debug
			logger: (line) => this.logger.debug({ sessionKey, line }, "pi stderr"),
		});

		proc.on("event", (piEvent) => {
			// ペイロード全体はログに残さない (大きい・機微を含みうる)。イベント種別ごとの
			// 概要フィールドだけ出す。ストリーミング差分は null が返るのでログしない
			const logFields = piEventLogFields(piEvent);
			if (logFields !== null) {
				this.logger.debug(
					{ sessionKey, eventType: piEvent.type, ...logFields },
					"pi event",
				);
			}
			if (isToolExecutionEnd(piEvent)) {
				const payload = extractReply(piEvent);
				if (payload !== null) {
					this.router.deliver(payload).catch((err) => {
						this.logger.warn(
							{ sessionKey, threadKeyPayload: payload.thread_key, err },
							"reply delivery failed",
						);
					});
				}
				return;
			}
			if (isAgentEnd(piEvent)) {
				// ターン内の LLM 呼び出し失敗は agent_end としては正常終了になるので、
				// ここで拾わないとログに一切残らない (rpc.ts extractTurnErrors)
				for (const errorMessage of extractTurnErrors(piEvent)) {
					this.logger.error(
						{ sessionKey, errorMessage },
						"assistant turn ended with error",
					);
				}
				// agent_end.messages は毎回全履歴を返すため、この totals はターンの増分では
				// なくセッション累計 (rpc.ts extractUsageTotals)
				const totals = extractUsageTotals(piEvent);
				record.usageTotals = totals;
				this.logger.info({ sessionKey, ...totals }, "turn usage");
				void this.onAgentEnd(sessionKey, proc).catch((err) => {
					this.logger.warn({ sessionKey, err }, "agent_end handling failed");
				});
			}
		});
		proc.on("response", (response) => {
			// success: true は prompt/steer の受理応答に過ぎない (agent_end が本当の
			// 終端)。debug ログのみで十分
			if (response.success) {
				this.logger.debug(
					{ sessionKey, command: response.command },
					"pi command accepted",
				);
				return;
			}
			// success: false は pi 側が「動けない」と判断したケース (認証エラー等)。
			// pi は生きたまま次コマンドを待つが、agent_end が来ないので何もしなければ
			// runner は永久に無音ハングする → ここで異常終了として扱いプロセスを止める
			this.logger.error(
				{ sessionKey, command: response.command, error: response.error },
				"pi command failed",
			);
			void this.failSession(sessionKey, proc, response.error).catch((err) => {
				this.logger.warn({ sessionKey, err }, "failSession handling failed");
			});
		});
		proc.on("invalid", (raw, error) => {
			this.logger.debug(
				{ sessionKey, raw: raw.slice(0, 500), error },
				"pi stdout line invalid",
			);
		});
		proc.on("exit", (code, signal) => {
			// 正常終了パス (onAgentEnd) では state を stopping にしてから stop している。
			// running のまま exit したら異常終了: 未 ack の item は inbox に残っているので、
			// lease を解いて次のイベントで拾い直せるようにする (flush はしない)
			const current = this.sessions.get(sessionKey);
			if (
				current !== undefined &&
				current.process === proc &&
				current.state !== "stopping"
			) {
				this.sessions.delete(sessionKey);
				this.stopRenewTimer(current);
				this.clearTurnTimeout(current);
				void this.store.leases.release(current.lease).catch((err) => {
					this.logger.warn({ sessionKey, err }, "lease release failed");
				});
				this.logger.warn(
					{ sessionKey, code, signal },
					"pi exited unexpectedly",
				);
				// pi のクラッシュはユーザーから見えない (返信なしで無音になる) ので、
				// トリガーメッセージに ❌ を付けて失敗を伝える
				void this.safeReact(
					() => this.reactions.addX(current.channelId, current.triggerTs),
					sessionKey,
					"x",
				);
			}
		});

		proc.start();
		record.state = "running";
		record.process = proc;
		this.startRenewTimer(sessionKey, record);

		// sessionKey でのフォールバック登録 (abnormalShutdown が thread_key: sessionKey で
		// 通知を送るために必要)。sessionMode "channel" かつ replyMode "flat" ならチャンネル
		// 直下、それ以外はトリガーのスレッドへ (session-model.md §3)
		if (policy.sessionMode === "channel" && policy.replyMode === "flat") {
			this.router.register(sessionKey, { channelId });
		} else {
			this.router.register(sessionKey, { channelId, threadTs });
		}
		await this.safeReact(
			() => this.reactions.addEyes(channelId, record.triggerTs),
			sessionKey,
			"eyes",
		);

		// enqueue 済みの入力 (spawn 準備中に積まれた分を含む) を束ねて初回 prompt にする。
		// トリガーイベント自身も enqueue 済みなので通常 drain 経由で届く。
		// ChannelDoc.context は初回のみ先頭に注入する (config.md §4)
		const items = (await this.store.inbox.drain(sessionKey)).filter(
			(i) => !record.promptedIds.has(i.id),
		);
		let body: string;
		if (items.length > 0) {
			for (const i of items) {
				this.registerReplyDestination(i.event, policy);
				record.promptedIds.add(i.id);
			}
			body = renderItems(items);
		} else {
			// drain が空 (Store 実装の遅延など)。トリガーイベントに直接フォールバック
			// するが、ack 対象には含める (二重 prompt を防ぐ)
			const triggerKey = this.registerReplyDestination(triggerEvent, policy);
			record.promptedIds.add(inboxItemId(triggerEvent));
			body = renderEvent(triggerEvent, triggerKey);
		}
		record.turnEpoch += 1;
		this.resetTurnTimeout(sessionKey, record);
		proc.prompt(prependContext(body, doc));

		await this.store.sessions.put(sessionKey, {
			channelId,
			threadTs,
			triggerTs: record.triggerTs,
			status: "active",
			updatedAt: new Date(),
		});
		this.logger.info(
			{
				sessionKey,
				workdir,
				resumed,
				model,
				provider: this.provider,
				items: items.length,
			},
			"session started",
		);
	}

	/**
	 * agent_end: flush → ack (この順序が正。逆にするとクラッシュで入力が消える) →
	 * 残り入力があれば次の prompt、無ければ linger して再確認、それでも無ければ ✅ で終了
	 * (persistence.md §3, session-model.md §4 の linger)
	 */
	private async onAgentEnd(sessionKey: string, proc: PiProcess): Promise<void> {
		const record = this.sessions.get(sessionKey);
		if (record === undefined || record.process !== proc) return;
		const epoch = record.turnEpoch;
		// ターンが正常に終わったので timeout タイマーをクリア (リークさせない)。
		// 以降 promptPending で継続する場合は都度リセットされる
		this.clearTurnTimeout(record);

		// 1. ターン境界の flush → 2. flush 成功後に ack (persistence.md §3)。
		// ack 対象は flush 前のスナップショット — flush の await 中に steer が
		// promptedIds へ追加した item を「そのターンの flush 前」に ack しない
		const toAck = [...record.promptedIds];
		if (this.workdirStorage !== undefined) {
			await this.workdirStorage.flush(sessionKey, record.workdir);
		}
		if (toAck.length > 0) {
			await this.store.inbox.ack(sessionKey, toAck);
			for (const id of toAck) record.promptedIds.delete(id);
		}

		// 3. 新規入力があれば同一プロセスで継続 (flush/ack は次の agent_end で行う)
		if (await this.promptPending(sessionKey, record, proc)) return;
		// flush/ack の await 中に steer 済みなら、そのターンの agent_end に終了判定を譲る
		if (record.turnEpoch !== epoch) return;

		// 4. linger: agent_end 直後に届いた追いメッセージを拾ってから終える。
		// この間レコードは Map に残す (新イベントは steer パスに入りうる)
		await sleep(this.lingerMs);
		if (this.sessions.get(sessionKey) !== record || record.process !== proc)
			return;
		if (await this.promptPending(sessionKey, record, proc)) return;
		if (record.turnEpoch !== epoch) return;

		// 5. 終了処理。reply が 1 度も呼ばれなくても沈黙のまま ✅ を付けて終える
		record.state = "stopping";
		await this.safeReact(
			() => this.reactions.addCheck(record.channelId, record.triggerTs),
			sessionKey,
			"check",
		);
		await this.store.sessions.put(sessionKey, {
			channelId: record.channelId,
			threadTs: record.threadTs,
			triggerTs: record.triggerTs,
			status: "finished",
			updatedAt: new Date(),
		});
		await proc.stop();
		this.stopRenewTimer(record);
		this.clearTurnTimeout(record);
		await this.store.leases.release(record.lease);
		this.sessions.delete(sessionKey);
		this.logger.info(
			{
				sessionKey,
				durationMs: Date.now() - record.startedAt,
				...(record.usageTotals !== undefined
					? {
							totalTokens: record.usageTotals.totalTokens,
							costTotal: record.usageTotals.costTotal,
							cacheRead: record.usageTotals.cacheRead,
						}
					: {}),
			},
			"session finished",
		);
	}

	/**
	 * pi が response.success=false を返したときの異常終了処理 (例: Cloud Run で
	 * ADC が見つからず認証エラーになるケース)。agent_end が来ない見込みなので
	 * ここで能動的にセッションを畳む。pi は生きたまま次コマンドを待っているだけなので
	 * graceful stop (proc.stop()) で十分止まる。クリーンアップの中身は abnormalShutdown
	 * に共通化している (timeoutSession と共有)
	 */
	private async failSession(
		sessionKey: string,
		proc: PiProcess,
		error: string | undefined,
	): Promise<void> {
		await this.abnormalShutdown(sessionKey, proc, {
			noticeText: `:warning: セッションが異常終了しました: ${error ?? "unknown error"}`,
			logMessage: "session failed",
			stop: () => proc.stop(),
		});
	}

	/**
	 * ターンタイムアウト (turnTimeoutMs 超過) の異常終了処理。pi が応答しない可能性がある
	 * ため graceful stop ではなく強制 kill する (session-runtime.md §6:
	 * 「プロセスは使い捨て設計なので kill してよい。inbox の入力は残るため再実行可能」)。
	 * クリーンアップの中身は failSession と共通 (abnormalShutdown)
	 */
	private async timeoutSession(
		sessionKey: string,
		proc: PiProcess,
	): Promise<void> {
		this.logger.error(
			{ sessionKey, turnTimeoutMs: this.turnTimeoutMs },
			"turn timed out",
		);
		await this.abnormalShutdown(sessionKey, proc, {
			noticeText: `:warning: ターンがタイムアウトしました (${this.turnTimeoutMs}ms)。セッションを終了します`,
			logMessage: "session timed out",
			stop: () => {
				proc.kill();
				return Promise.resolve();
			},
		});
	}

	/**
	 * 異常終了の共通クリーンアップ (failSession / timeoutSession から呼ばれる)。
	 * exit ハンドラの「running のまま exit したら異常終了」と同じ後始末 (lease 解放 /
	 * renew・timeout タイマー停止 / Map から削除) を行うが、flush はしない (このターンの
	 * 入力は inbox に残したまま次回に再実行させる)。state を先に "stopping" にしておくことで、
	 * stop() が引き起こす exit イベントが二重にクリーンアップを走らせない
	 * (exit ハンドラは state !== "stopping" のときだけ動く)
	 */
	private async abnormalShutdown(
		sessionKey: string,
		proc: PiProcess,
		options: {
			noticeText: string;
			logMessage: string;
			stop: () => Promise<void>;
		},
	): Promise<void> {
		const record = this.sessions.get(sessionKey);
		if (record === undefined || record.process !== proc) return;

		record.state = "stopping";
		this.stopRenewTimer(record);
		this.clearTurnTimeout(record);

		// register 済み (kick で必ず register している) なので deliver できる。
		// Slack への通知が失敗してもセッションの畳み込みは続ける
		await this.router
			.deliver({ thread_key: sessionKey, text: options.noticeText })
			.catch((err) => {
				this.logger.warn({ sessionKey, err }, "failure notice delivery failed");
			});
		await this.safeReact(
			() => this.reactions.addX(record.channelId, record.triggerTs),
			sessionKey,
			"x",
		);

		await this.store.leases.release(record.lease).catch((err) => {
			this.logger.warn({ sessionKey, err }, "lease release failed");
		});
		await options.stop();
		this.logger.warn(
			{ sessionKey, durationMs: Date.now() - record.startedAt },
			options.logMessage,
		);
		// activeSessionCount (テストの waitFor 等) がこのログの後で 0 になるよう、
		// Map からの削除はクリーンアップ完了後に行う
		this.sessions.delete(sessionKey);
	}

	/** 未 prompt の item があれば prompt して true (drain は非破壊なので
	 * promptedIds で除外する)。無ければ false */
	private async promptPending(
		sessionKey: string,
		record: SessionRecord,
		proc: PiProcess,
	): Promise<boolean> {
		const items = (await this.store.inbox.drain(sessionKey)).filter(
			(i) => !record.promptedIds.has(i.id),
		);
		if (items.length === 0) return false;
		for (const i of items) {
			this.registerReplyDestination(i.event, record.policy);
			record.promptedIds.add(i.id);
		}
		record.turnEpoch += 1;
		this.resetTurnTimeout(sessionKey, record);
		proc.prompt(renderItems(items));
		this.logger.info({ sessionKey, items: items.length }, "session continued");
		return true;
	}

	/** lease の renew を ttl/3 間隔で回す。false は排他喪失 = 別の保持者が動いて
	 * いる可能性があるため、flush せずプロセスを止める (書き戻さない) */
	private startRenewTimer(sessionKey: string, record: SessionRecord): void {
		const intervalMs = Math.max(1, Math.floor(this.leaseTtlMs / 3));
		const timer = setInterval(() => {
			void (async () => {
				if (this.sessions.get(sessionKey) !== record) return;
				const ok = await this.store.leases.renew(record.lease, this.leaseTtlMs);
				if (ok) return;
				if (this.sessions.get(sessionKey) !== record) return;
				this.logger.error(
					{ sessionKey, owner: this.owner },
					"lease renew failed; stopping session without flush",
				);
				record.state = "stopping";
				this.sessions.delete(sessionKey);
				this.stopRenewTimer(record);
				this.clearTurnTimeout(record);
				await record.process?.stop();
			})().catch((err) => {
				this.logger.error({ sessionKey, err }, "lease renew handling failed");
			});
		}, intervalMs);
		timer.unref();
		record.renewTimer = timer;
	}

	private stopRenewTimer(record: SessionRecord): void {
		if (record.renewTimer !== undefined) {
			clearInterval(record.renewTimer);
			record.renewTimer = undefined;
		}
	}

	/** turn timeout タイマーをリセットする (prompt/steer 送信ごとに呼ぶ。既存タイマーが
	 * あれば止めて張り直す)。発火したら timeoutSession でセッションを異常終了させる */
	private resetTurnTimeout(sessionKey: string, record: SessionRecord): void {
		this.clearTurnTimeout(record);
		const timer = setTimeout(() => {
			const proc = record.process;
			if (proc === undefined) return;
			void this.timeoutSession(sessionKey, proc).catch((err) => {
				this.logger.warn({ sessionKey, err }, "timeoutSession handling failed");
			});
		}, this.turnTimeoutMs);
		timer.unref();
		record.turnTimeoutTimer = timer;
	}

	private clearTurnTimeout(record: SessionRecord): void {
		if (record.turnTimeoutTimer !== undefined) {
			clearTimeout(record.turnTimeoutTimer);
			record.turnTimeoutTimer = undefined;
		}
	}

	private async loadChannelDoc(channelId: string): Promise<ChannelDoc | null> {
		try {
			return await this.configSource.channel(channelId);
		} catch (err) {
			// YAML の壊れで受信ループを止めない。既定動作 (mention 起動 / DM は passthrough) に落とす
			this.logger.warn({ channelId, err }, "failed to load channel doc");
			return null;
		}
	}

	private resolveGates(
		doc: ChannelDoc | null,
		isDm: boolean,
	): {
		gates: Gate[];
		combinator: GateCombinator;
	} {
		if (doc?.trigger === undefined) {
			// doc なし / trigger 未設定は既定 = mention のみ、DM は passthrough
			// (session-model.md §5, config.md §1)
			return { gates: defaultGates(isDm), combinator: "any" };
		}
		const specs = toGateSpecs(doc.trigger.gates, (message) =>
			this.logger.warn(message),
		);
		return {
			gates: specs.map((spec) => createGate(spec)),
			combinator: doc.trigger.combinator,
		};
	}

	/** trigger.cooldownSec は未実装。設定されていたら無視する旨を warn する
	 * (toGateSpecs の unsupported gate kind の warn と同じ流儀。kick ごとに出て構わない) */
	private warnCooldownIfUnsupported(
		doc: ChannelDoc | null,
		sessionKey: string,
	): void {
		if (doc?.trigger?.cooldownSec === undefined) return;
		this.logger.warn(
			{ sessionKey, cooldownSec: doc.trigger.cooldownSec },
			"trigger.cooldownSec is not implemented; ignored",
		);
	}

	/** リアクションは装飾なので、失敗してもセッションを止めない */
	private async safeReact(
		fn: () => Promise<void>,
		sessionKey: string,
		label: string,
	): Promise<void> {
		try {
			await fn();
		} catch (err) {
			this.logger.warn({ sessionKey, label, err }, "failed to add reaction");
		}
	}
}

/** app 共通 + ChannelDoc.systemPrompt + thread_key の指示 (session-runtime.md §2) */
function buildSystemPrompt(sessionKey: string, doc: ChannelDoc | null): string {
	const parts = [APP_SYSTEM_PROMPT];
	if (doc?.systemPrompt !== undefined) parts.push(doc.systemPrompt.trim());
	parts.push(
		"Each incoming message is annotated with its thread_key. When calling " +
			"the reply tool, use the thread_key of the message you are replying to " +
			"(the most recent one if replying generally). " +
			`Fallback thread_key for this session: ${sessionKey}`,
	);
	return parts.join("\n\n");
}

function prependContext(body: string, doc: ChannelDoc | null): string {
	const context = doc?.context;
	if (context === undefined || context.length === 0) return body;
	return `参考情報:\n${context.map((c) => c.trim()).join("\n\n")}\n\n${body}`;
}
