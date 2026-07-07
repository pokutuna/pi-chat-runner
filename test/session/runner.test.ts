// SessionRunner の統合テスト。実 Slack・実 LLM の代わりに:
// - pi     → test/fixtures/fake-pi.mjs (stdin の JSONL を記録し、reply/agent_end を吐く)
// - Slack  → FakePoster / FakeReactionClient
// - config → インメモリの ConfigSource
// - store  → InMemoryStateStore (Step 4: lease / drain-ack / linger の検証もここで行う)
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { describe, expect, it } from "vitest";
import type { ChannelDoc } from "../../src/config/channel-doc.js";
import type { ConfigSource } from "../../src/config/config-source.js";
import type { InboundMessage } from "../../src/ingress/chat-event.js";
import { Reactions } from "../../src/reply/reactions.js";
import { type ChatPoster, ReplyRouter } from "../../src/reply/router.js";
import type {
	MentionFormat,
	PiPermissionConfig,
} from "../../src/session/runner.js";
import {
	computeKickDelayMs,
	hasSkillEntries,
	isIdleExpired,
	renderEvent,
	replyThreadKeyOf,
	resolveSessionPolicy,
	type SessionPolicy,
	SessionRunner,
	sessionKeyOf,
	toGateSpecs,
} from "../../src/session/runner.js";
import { InMemoryStateStore } from "../../src/store/state/backends/memory.js";
import { inboxItemId } from "../../src/store/state/inbox-item.js";
import type { StateStore } from "../../src/store/state/interfaces.js";
import {
	NoopWorkdirStorage,
	type WorkdirStorage,
} from "../../src/store/workdir.js";

const FAKE_PI = fileURLToPath(
	new URL("../fixtures/fake-pi.mjs", import.meta.url),
);
const EXTENSION = fileURLToPath(
	new URL("../../extensions/reply.ts", import.meta.url),
);
const PERMISSION_GATE_EXTENSION = fileURLToPath(
	new URL("../../extensions/permission-gate.ts", import.meta.url),
);

class FakePoster implements ChatPoster {
	calls: { channelId: string; threadTs?: string; text: string }[] = [];
	async postMessage(channelId: string, text: string, threadTs?: string) {
		this.calls.push({
			channelId,
			text,
			...(threadTs !== undefined ? { threadTs } : {}),
		});
	}
}

class FakeConfigSource implements ConfigSource {
	constructor(private readonly docs: Record<string, ChannelDoc>) {}
	async channel(id: string): Promise<ChannelDoc | null> {
		return this.docs[id] ?? null;
	}
}

/** 既存テストの大半は既定ポリシー (thread/thread) を前提に書かれているため、
 * sessionKeyOf の呼び出しをこの既定ポリシーで束ねる薄いヘルパーを用意する
 * (旧 threadKeyOf と同じ値を返す) */
const THREAD_POLICY: SessionPolicy = {
	sessionMode: "thread",
	replyMode: "thread",
};
function threadKeyOf(event: InboundMessage): string {
	return sessionKeyOf(event, THREAD_POLICY);
}

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
	return {
		kind: "message",
		id: "1700000000.000100",
		conversation: { channelId: "C01" },
		sender: { id: "U01", isBot: false },
		text: "hello",
		mentionsBot: false,
		attachments: [],
		timestamp: new Date("2026-07-05T00:00:00Z"),
		metadata: { eventId: `Ev-${Math.random().toString(36).slice(2)}` },
		...overrides,
	};
}

async function waitFor(
	condition: () => boolean | Promise<boolean>,
	label: string,
	timeoutMs = 5000,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`timed out waiting for: ${label}`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** pino のログ 1 行 (JSON) を配列に集めるテスト用ロガー */
function collectingLogger(): {
	logger: pino.Logger;
	lines: () => Record<string, unknown>[];
} {
	const chunks: string[] = [];
	const stream = {
		write(chunk: string) {
			chunks.push(chunk);
			return true;
		},
	};
	const logger = pino({ level: "debug" }, stream);
	return {
		logger,
		lines: () =>
			chunks
				.join("")
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line)),
	};
}

interface Harness {
	runner: SessionRunner;
	poster: FakePoster;
	store: StateStore;
	reactions: { channel: string; timestamp: string; name: string }[];
	workdirRoot: string;
	logLines: () => Record<string, unknown>[];
	commandsLog(channelId: string, threadTs: string): Promise<string[]>;
	envSeen(channelId: string, threadTs: string): Promise<Record<string, string>>;
	argvSeen(channelId: string, threadTs: string): Promise<string[]>;
}

interface HarnessOptions {
	extraEnv?: Record<string, string>;
	store?: StateStore;
	workdirStorage?: WorkdirStorage;
	/** テストの実待ちを短くするため既定 30ms (本番既定は 3000ms) */
	lingerMs?: number;
	leaseTtlMs?: number;
	owner?: string;
	piBinary?: string;
	agentUid?: number;
	agentGid?: number;
	agentHome?: string;
	piPermission?: PiPermissionConfig;
	turnTimeoutMs?: number;
	skillsDir?: string;
	mentionFormat?: MentionFormat;
}

async function harness(
	docs: Record<string, ChannelDoc> = {},
	options: HarnessOptions = {},
): Promise<Harness> {
	const workdirRoot = await mkdtemp(join(tmpdir(), "pi-chat-runner-test-"));
	// SessionRunner の既定 agentHome ("/home/agent") はテスト実行者に書き込み権限が
	// ないため、テストでは常に書き込み可能な一時ディレクトリへ差し替える
	// (実プロダクション既定を検証したいテストは agentHome を明示指定する)
	const agentHome =
		options.agentHome ??
		join(
			await mkdtemp(join(tmpdir(), "pi-chat-runner-test-home-")),
			"agent-home",
		);
	const poster = new FakePoster();
	const store = options.store ?? new InMemoryStateStore();
	const reactionCalls: { channel: string; timestamp: string; name: string }[] =
		[];
	const { logger, lines } = collectingLogger();
	const runner = new SessionRunner({
		configSource: new FakeConfigSource(docs),
		store,
		router: new ReplyRouter({ poster }),
		reactions: new Reactions({
			add: async (args) => {
				reactionCalls.push(args);
				return {};
			},
		}),
		extensionPaths: [EXTENSION, PERMISSION_GATE_EXTENSION],
		workdirRoot,
		piBinary: options.piBinary ?? FAKE_PI,
		lingerMs: options.lingerMs ?? 30,
		logger,
		...(options.extraEnv !== undefined ? { extraEnv: options.extraEnv } : {}),
		workdirStorage: options.workdirStorage ?? new NoopWorkdirStorage(),
		...(options.leaseTtlMs !== undefined
			? { leaseTtlMs: options.leaseTtlMs }
			: {}),
		...(options.owner !== undefined ? { owner: options.owner } : {}),
		...(options.agentUid !== undefined ? { agentUid: options.agentUid } : {}),
		...(options.agentGid !== undefined ? { agentGid: options.agentGid } : {}),
		agentHome,
		...(options.piPermission !== undefined
			? { piPermission: options.piPermission }
			: {}),
		...(options.turnTimeoutMs !== undefined
			? { turnTimeoutMs: options.turnTimeoutMs }
			: {}),
		...(options.skillsDir !== undefined
			? { skillsDir: options.skillsDir }
			: {}),
		// SessionRunner では必須パラメータ。テストでは既定として Slack の
		// `<@USER_ID>` 記法を使う (個々のテストが上書きしない限り)
		mentionFormat: options.mentionFormat ?? ((id) => `<@${id}>`),
	});
	return {
		runner,
		poster,
		store,
		reactions: reactionCalls,
		workdirRoot,
		logLines: lines,
		commandsLog: async (channelId, threadTs) => {
			const raw = await readFile(
				join(workdirRoot, channelId, threadTs, "commands.jsonl"),
				"utf-8",
			);
			return raw.trim().split("\n");
		},
		envSeen: async (channelId, threadTs) => {
			const raw = await readFile(
				join(workdirRoot, channelId, threadTs, "env-seen.json"),
				"utf-8",
			);
			return JSON.parse(raw);
		},
		argvSeen: async (channelId, threadTs) => {
			const raw = await readFile(
				join(workdirRoot, channelId, threadTs, "argv-seen.json"),
				"utf-8",
			);
			return JSON.parse(raw);
		},
	};
}

describe("SessionRunner (fake-pi integration)", () => {
	it("mention → gate → spawn → reply reaches the poster → check reaction", async () => {
		const h = await harness();
		const trigger = message({ mentionsBot: true, text: "question here" });

		await h.runner.handle(trigger);

		await waitFor(() => h.poster.calls.length === 1, "reply posted");
		expect(h.poster.calls[0]).toEqual({
			channelId: "C01",
			threadTs: trigger.id,
			text: `echo: ${renderEvent(trigger, replyThreadKeyOf(trigger))}`,
		});

		await waitFor(
			() => h.reactions.some((r) => r.name === "white_check_mark"),
			"check reaction",
		);
		expect(h.reactions.map((r) => r.name)).toEqual([
			"eyes",
			"white_check_mark",
		]);
		expect(h.reactions[0]?.timestamp).toBe(trigger.id);

		await waitFor(() => h.runner.activeSessionCount === 0, "session removed");
		const commands = await h.commandsLog("C01", trigger.id);
		expect(JSON.parse(commands[0] ?? "{}").type).toBe("prompt");

		// 終了処理で lease が解放され、inbox は ack 済みで空
		const threadKey = threadKeyOf(trigger);
		expect(await h.store.inbox.drain(threadKey)).toEqual([]);
		expect(
			await h.store.leases.acquire(threadKey, "probe", 1000),
		).not.toBeNull();
		expect((await h.store.sessions.get(threadKey))?.status).toBe("finished");
	});

	it("mentionFormat に Slack の記法を渡すと、system prompt にその記法の説明が含まれる", async () => {
		const h = await harness({}, { mentionFormat: (id) => `<@${id}>` });
		const trigger = message({
			mentionsBot: true,
			text: "mention format default",
		});

		await h.runner.handle(trigger);
		await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

		const argv = await h.argvSeen("C01", trigger.id);
		const idx = argv.indexOf("--append-system-prompt");
		expect(idx).toBeGreaterThanOrEqual(0);
		const systemPrompt = argv[idx + 1] ?? "";
		expect(systemPrompt).toContain("<@USER_ID>");
	});

	it("mentionFormat を注入すると、system prompt にその記法が反映される", async () => {
		const h = await harness({}, { mentionFormat: (id) => `@${id}` });
		const trigger = message({
			mentionsBot: true,
			text: "mention format custom",
		});

		await h.runner.handle(trigger);
		await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

		const argv = await h.argvSeen("C01", trigger.id);
		const idx = argv.indexOf("--append-system-prompt");
		expect(idx).toBeGreaterThanOrEqual(0);
		const systemPrompt = argv[idx + 1] ?? "";
		expect(systemPrompt).toContain("@USER_ID");
		expect(systemPrompt).not.toContain("<@USER_ID>");
	});

	it("logs turn usage aggregated from agent_end.messages", async () => {
		const h = await harness();
		const trigger = message({ mentionsBot: true, text: "usage please" });

		await h.runner.handle(trigger);
		await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

		const usageLogs = h.logLines().filter((line) => line.msg === "turn usage");
		expect(usageLogs).toHaveLength(1);
		expect(usageLogs[0]).toMatchObject({
			input: 100,
			output: 50,
			cacheRead: 10,
			cacheWrite: 5,
			totalTokens: 150,
			costTotal: 0.01,
		});

		// session finished ログにも累計 usage の一部が載る
		const finishedLogs = h
			.logLines()
			.filter((line) => line.msg === "session finished");
		expect(finishedLogs).toHaveLength(1);
		expect(finishedLogs[0]).toMatchObject({
			totalTokens: 150,
			costTotal: 0.01,
			cacheRead: 10,
		});
	});

	it("does not react nor spawn when the gate rejects (default = mention only)", async () => {
		const h = await harness();
		await h.runner.handle(message({ text: "no mention here" }));

		expect(h.runner.activeSessionCount).toBe(0);
		expect(h.poster.calls).toEqual([]);
		expect(h.reactions).toEqual([]);
	});

	it("keyword gate from ChannelDoc triggers without a mention", async () => {
		const h = await harness({
			C01: {
				trigger: {
					combinator: "any",
					gates: [{ kind: "keyword", pattern: "[Hh]elp" }],
				},
			},
		});
		const trigger = message({ text: "help me please" });

		await h.runner.handle(trigger);

		await waitFor(() => h.poster.calls.length === 1, "reply posted");
		await waitFor(() => h.runner.activeSessionCount === 0, "session removed");
	});

	it("DM without mention spawns a session (default = passthrough)", async () => {
		const h = await harness();
		const trigger = message({
			conversation: { channelId: "D01", isDm: true },
			text: "hi there, no mention",
		});

		await h.runner.handle(trigger);

		await waitFor(() => h.poster.calls.length === 1, "reply posted");
		// DM は既定 session: channel, reply: flat (session-model.md §3) なので、
		// スレッド外トリガーの返信先はチャンネル直下 (threadTs 無し) になる
		expect(h.poster.calls[0]).toEqual({
			channelId: "D01",
			text: `echo: ${renderEvent(trigger, replyThreadKeyOf(trigger))}`,
		});
		await waitFor(() => h.runner.activeSessionCount === 0, "session removed");
	});

	it("reserved 'dm' ChannelDoc overrides the DM default (mention-only trigger)", async () => {
		const h = await harness({
			dm: {
				trigger: { combinator: "any", gates: [{ kind: "mention" }] },
			},
		});
		const trigger = message({
			conversation: { channelId: "D01", isDm: true },
			text: "hi there, no mention",
		});

		await h.runner.handle(trigger);

		expect(h.runner.activeSessionCount).toBe(0);
		expect(h.poster.calls).toEqual([]);
	});

	it("injects ChannelDoc.context into the first prompt only", async () => {
		const h = await harness({
			C01: { context: ["CONTEXT-NOTE"] },
		});
		const trigger = message({ mentionsBot: true, text: "with context" });

		await h.runner.handle(trigger);
		await waitFor(() => h.poster.calls.length === 1, "reply posted");
		await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

		const commands = await h.commandsLog("C01", trigger.id);
		const prompt = JSON.parse(commands[0] ?? "{}");
		expect(prompt.message).toContain("CONTEXT-NOTE");
		expect(prompt.message).toContain(trigger.text);
	});

	it("delivers follow-up messages to the running pi as a steer command", async () => {
		const h = await harness();
		const trigger = message({ mentionsBot: true, text: "WAIT_FOR_STEER" });
		const threadTs = trigger.id;

		await h.runner.handle(trigger);
		await waitFor(async () => {
			try {
				return (await h.commandsLog("C01", threadTs)).length >= 1;
			} catch {
				return false;
			}
		}, "initial prompt recorded");

		// スレッド内の追いメッセージ。mention なしでも gate を通さず同じ inbox へ
		const followUp = message({
			id: "1700000000.000200",
			conversation: { channelId: "C01", threadTs },
			text: "追加の指示です",
		});
		await h.runner.handle(followUp);

		await waitFor(() => h.poster.calls.length === 1, "steered reply posted");
		expect(h.poster.calls[0]?.text).toBe(
			`steered: ${renderEvent(followUp, replyThreadKeyOf(followUp))}`,
		);
		expect(h.poster.calls[0]?.threadTs).toBe(threadTs);

		await waitFor(() => h.runner.activeSessionCount === 0, "session removed");
		const commands = (await h.commandsLog("C01", threadTs)).map((line) =>
			JSON.parse(line),
		);
		expect(commands.map((c) => c.type)).toEqual(["prompt", "steer"]);
		expect(commands[1]?.message).toBe(
			renderEvent(followUp, replyThreadKeyOf(followUp)),
		);

		// steer 済み item も flush → ack でまとめて確定される
		expect(await h.store.inbox.drain(threadKeyOf(trigger))).toEqual([]);
	});

	it("channel モード (session.mode: channel) では、スレッド外の 2 つ目のメッセージが新セッションでなく同一セッションへの steer になる", async () => {
		const h = await harness({
			C01: { session: { mode: "channel" } },
		});
		const trigger = message({ mentionsBot: true, text: "WAIT_FOR_STEER" });

		await h.runner.handle(trigger);
		await waitFor(async () => {
			try {
				return (await h.commandsLog("C01", "channel")).length >= 1;
			} catch {
				return false;
			}
		}, "initial prompt recorded");
		expect(h.runner.activeSessionCount).toBe(1);

		// トリガーと同じスレッド外 (threadTs 無し) の 2 件目。session.mode: channel
		// なので sessionKey は channelId のみで揃い、同一セッションへの steer になる
		// (session-model.md §3)
		const second = message({
			id: "1700000000.000250",
			conversation: { channelId: "C01" },
			text: "追加の指示です (channel モード)",
		});
		await h.runner.handle(second);

		// 新規セッションが増えていない (同一セッションへの steer)
		expect(h.runner.activeSessionCount).toBe(1);

		await waitFor(() => h.poster.calls.length === 1, "steered reply posted");
		// reply.mode の既定は thread なので、スレッド外トリガーの返信は
		// メッセージごとに新しいスレッドを起こす (thread_key = channelId:second.id)
		expect(h.poster.calls[0]?.threadTs).toBe(second.id);
		expect(h.poster.calls[0]?.text).toBe(
			`steered: ${renderEvent(second, replyThreadKeyOf(second))}`,
		);

		await waitFor(() => h.runner.activeSessionCount === 0, "session removed");
		const commands = (await h.commandsLog("C01", "channel")).map((line) =>
			JSON.parse(line),
		);
		expect(commands.map((c) => c.type)).toEqual(["prompt", "steer"]);
	});

	it("session.idleResetMinutes (channel モード): 前回活動から idle 超過していたら transcript を世代交代する", async () => {
		const h = await harness({
			C01: { session: { mode: "channel", idleResetMinutes: 1 } },
		});
		const sessionKey = "C01";
		const workdir = join(h.workdirRoot, "C01", "channel");

		// 事前に workdir と transcript.jsonl、および 10 分前の SessionDoc を用意する
		// (前回セッションが idle 期間を超えて放置された状態を模す)
		await mkdir(workdir, { recursive: true });
		await writeFile(join(workdir, "transcript.jsonl"), "OLD TRANSCRIPT\n");
		await h.store.sessions.put(sessionKey, {
			channelId: "C01",
			threadTs: "channel",
			triggerTs: "1699999999.000000",
			status: "finished",
			updatedAt: new Date(Date.now() - 10 * 60_000),
		});

		const trigger = message({ mentionsBot: true, text: "idle reset please" });
		await h.runner.handle(trigger);
		await waitFor(() => h.poster.calls.length === 1, "reply posted");
		await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

		const entries = await readdir(workdir);
		expect(entries).toContain("commands.jsonl");
		expect(entries.some((name) => /^transcript-\d+\.jsonl$/.test(name))).toBe(
			true,
		);
		expect(entries).not.toContain("transcript.jsonl");

		expect(
			h
				.logLines()
				.some((line) => line.msg === "idle reset: transcript rotated"),
		).toBe(true);
	});

	it("session.maxTranscriptKb (channel モード): transcript サイズが閾値を超えていたら世代交代する", async () => {
		const h = await harness({
			C01: { session: { mode: "channel", maxTranscriptKb: 1 } },
		});
		const workdir = join(h.workdirRoot, "C01", "channel");

		// 事前に workdir と 2KB 程度の transcript.jsonl を用意する (閾値 1KB 超過)。
		// size 判定は store に依存しないため SessionDoc の事前 put は不要
		await mkdir(workdir, { recursive: true });
		await writeFile(join(workdir, "transcript.jsonl"), "x".repeat(2 * 1024));

		const trigger = message({ mentionsBot: true, text: "size reset please" });
		await h.runner.handle(trigger);
		await waitFor(() => h.poster.calls.length === 1, "reply posted");
		await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

		const entries = await readdir(workdir);
		expect(entries.some((name) => /^transcript-\d+\.jsonl$/.test(name))).toBe(
			true,
		);
		expect(entries).not.toContain("transcript.jsonl");

		expect(
			h
				.logLines()
				.some((line) => line.msg === "size reset: transcript rotated"),
		).toBe(true);
	});

	it("session.maxTranscriptKb (channel モード): transcript サイズが閾値未満なら世代交代しない", async () => {
		const h = await harness({
			C01: { session: { mode: "channel", maxTranscriptKb: 10 } },
		});
		const workdir = join(h.workdirRoot, "C01", "channel");

		await mkdir(workdir, { recursive: true });
		await writeFile(join(workdir, "transcript.jsonl"), "x".repeat(100));

		const trigger = message({ mentionsBot: true, text: "no size reset" });
		await h.runner.handle(trigger);
		await waitFor(() => h.poster.calls.length === 1, "reply posted");
		await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

		const entries = await readdir(workdir);
		expect(entries).toContain("transcript.jsonl");
		expect(entries.some((name) => /^transcript-\d+\.jsonl$/.test(name))).toBe(
			false,
		);
	});

	it("stays silent but still adds the check reaction when reply is never called", async () => {
		const h = await harness();
		const trigger = message({ mentionsBot: true, text: "NO_REPLY please" });

		await h.runner.handle(trigger);

		await waitFor(
			() => h.reactions.some((r) => r.name === "white_check_mark"),
			"check reaction",
		);
		expect(h.poster.calls).toEqual([]);
		await waitFor(() => h.runner.activeSessionCount === 0, "session removed");
	});

	it("ignores a duplicate delivery of the same event id while running", async () => {
		const h = await harness();
		const trigger = message({ mentionsBot: true, text: "WAIT_FOR_STEER" });
		await h.runner.handle(trigger);
		expect(h.runner.activeSessionCount).toBe(1);

		// 同じ event_id の再送: セッションは増えず、steer もされない
		await h.runner.handle(trigger);
		expect(h.runner.activeSessionCount).toBe(1);

		// 終了させる
		const followUp = message({
			id: "1700000000.000300",
			conversation: { channelId: "C01", threadTs: trigger.id },
			text: "done",
		});
		await h.runner.handle(followUp);
		await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

		const commands = (await h.commandsLog("C01", trigger.id)).map((line) =>
			JSON.parse(line),
		);
		expect(commands.filter((c) => c.type === "prompt")).toHaveLength(1);
	});

	it("reuses the same workdir when the thread is triggered again", async () => {
		const h = await harness();
		const trigger = message({ mentionsBot: true, text: "first" });
		await h.runner.handle(trigger);
		await waitFor(
			() => h.runner.activeSessionCount === 0,
			"first session done",
		);

		const again = message({
			id: "1700000000.000900",
			conversation: { channelId: "C01", threadTs: trigger.id },
			mentionsBot: true,
			text: "second",
		});
		await h.runner.handle(again);
		await waitFor(() => h.poster.calls.length === 2, "second reply posted");
		await waitFor(
			() => h.runner.activeSessionCount === 0,
			"second session done",
		);

		// 同じ workdir の commands.jsonl に両セッションの prompt が積まれている
		const commands = (await h.commandsLog("C01", trigger.id)).map((line) =>
			JSON.parse(line),
		);
		expect(commands.filter((c) => c.type === "prompt")).toHaveLength(2);
	});

	it("logs resumed: true when transcript.jsonl already exists for the workdir", async () => {
		const h = await harness();
		const trigger = message({ mentionsBot: true, text: "first" });
		await h.runner.handle(trigger);
		await waitFor(
			() => h.runner.activeSessionCount === 0,
			"first session done",
		);

		const startedLogs = h
			.logLines()
			.filter((line) => line.msg === "session started");
		expect(startedLogs).toHaveLength(1);
		expect(startedLogs[0]?.resumed).toBe(false);

		// fake-pi は transcript.jsonl を作らないため、pi が実際に書き出した状態を
		// テスト側で模して置く (session-runtime.md: 再開は同じ --session パスへの
		// 再 spawn だけで実現される)
		await writeFile(
			join(h.workdirRoot, "C01", trigger.id, "transcript.jsonl"),
			"",
		);

		const again = message({
			id: "1700000000.000901",
			conversation: { channelId: "C01", threadTs: trigger.id },
			mentionsBot: true,
			text: "second",
		});
		await h.runner.handle(again);
		await waitFor(() => h.poster.calls.length === 2, "second reply posted");
		await waitFor(
			() => h.runner.activeSessionCount === 0,
			"second session done",
		);

		const startedLogsAfter = h
			.logLines()
			.filter((line) => line.msg === "session started");
		expect(startedLogsAfter).toHaveLength(2);
		expect(startedLogsAfter[1]?.resumed).toBe(true);
	});

	it("passes extraEnv through to the pi child process", async () => {
		const h = await harness(
			{},
			{ extraEnv: { GOOGLE_CLOUD_PROJECT: "my-project" } },
		);
		const trigger = message({ mentionsBot: true, text: "with extra env" });

		await h.runner.handle(trigger);
		await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

		const env = await h.envSeen("C01", trigger.id);
		expect(env.GOOGLE_CLOUD_PROJECT).toBe("my-project");
	});

	it("常に HOME を agentHome に上書きする (UID 分離の有無にかかわらず)", async () => {
		const h = await harness({}, { agentHome: "/tmp/agent-home-no-uid" });
		const trigger = message({ mentionsBot: true, text: "no uid isolation" });

		await h.runner.handle(trigger);
		await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

		const env = await h.envSeen("C01", trigger.id);
		// runner は agentHome を realpath で正規化して渡す (macOS の /tmp symlink 対策)
		expect(env.HOME).toBe(await realpath("/tmp/agent-home-no-uid"));
	});

	it("agentHome が存在しなければ作成する (UID 分離なし)", async () => {
		const agentHome = join(
			await mkdtemp(join(tmpdir(), "pi-chat-runner-test-home-")),
			"nested",
			"home",
		);
		const h = await harness({}, { agentHome });
		const trigger = message({ mentionsBot: true, text: "creates agent home" });

		await h.runner.handle(trigger);
		await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

		const stats = await stat(agentHome);
		expect(stats.isDirectory()).toBe(true);
	});

	it("UID 分離が有効なとき HOME を agentHome に上書きし、workdir と agentHome を chown/chmod する", async () => {
		// root でなくても自分自身の uid/gid への chown は成功するため、実プロセスの
		// uid/gid を使って「UID 分離が有効なコードパスを通す」ことをローカルで検証する
		// (実際に別 uid へ落とす検証は Dockerfile 検証 (docker) で行う)
		const uid = process.getuid?.();
		const gid = process.getgid?.();
		if (uid === undefined || gid === undefined) return; // Windows 等では skip
		const agentHome = join(
			await mkdtemp(join(tmpdir(), "pi-chat-runner-test-home-")),
			"agent-home",
		);
		const h = await harness({}, { agentUid: uid, agentGid: gid, agentHome });
		const trigger = message({ mentionsBot: true, text: "uid isolated" });

		await h.runner.handle(trigger);
		await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

		const env = await h.envSeen("C01", trigger.id);
		expect(env.HOME).toBe(await realpath(agentHome));

		const stats = await stat(join(h.workdirRoot, "C01", trigger.id));
		expect(stats.uid).toBe(uid);
		expect(stats.gid).toBe(gid);
		expect(stats.mode & 0o777).toBe(0o700);

		const homeStats = await stat(agentHome);
		expect(homeStats.uid).toBe(uid);
		expect(homeStats.gid).toBe(gid);
		expect(homeStats.mode & 0o777).toBe(0o700);
	});

	it("Node Permission Model が有効なとき node --permission 経由で pi (fake-pi) を起動する", async () => {
		// permission 指定時は entrypoint を直接 node で起動するため、piBinary は
		// 使われない (buildSpawnCommand の仕様)。fake-pi.mjs 自体を entrypoint に
		// 見立て、workdir/node_modules/appDir への read/write を許可した状態でも
		// 通常のセッションと同じく reply → agent_end まで動くことを確認する
		const h = await harness(
			{},
			{
				piPermission: {
					entrypoint: FAKE_PI,
					nodeModulesDir: join(process.cwd(), "node_modules"),
					appDir: process.cwd(),
				},
			},
		);
		const trigger = message({
			mentionsBot: true,
			text: "permission model isolated",
		});

		await h.runner.handle(trigger);

		await waitFor(() => h.poster.calls.length === 1, "reply posted");
		expect(h.poster.calls[0]?.text).toBe(
			`echo: ${renderEvent(trigger, replyThreadKeyOf(trigger))}`,
		);
		await waitFor(() => h.runner.activeSessionCount === 0, "session removed");
	});

	it("skillsDir に実体のあるエントリがあれば --skill <dir> を渡す", async () => {
		const skillsDir = await mkdtemp(join(tmpdir(), "pi-chat-runner-skills-"));
		await mkdir(join(skillsDir, "example-skill"), { recursive: true });
		await writeFile(
			join(skillsDir, "example-skill", "SKILL.md"),
			"# example\n",
		);
		const h = await harness({}, { skillsDir });
		const trigger = message({ mentionsBot: true, text: "with skill" });

		await h.runner.handle(trigger);

		await waitFor(() => h.poster.calls.length === 1, "reply posted");
		const argv = await h.argvSeen("C01", trigger.id);
		const skillIndex = argv.indexOf("--skill");
		expect(skillIndex).toBeGreaterThanOrEqual(0);
		expect(argv[skillIndex + 1]).toBe(skillsDir);

		await waitFor(() => h.runner.activeSessionCount === 0, "session removed");
	});

	it("skillsDir が空 (.gitkeep のみ) のときは --skill を渡さない", async () => {
		const skillsDir = await mkdtemp(join(tmpdir(), "pi-chat-runner-skills-"));
		await writeFile(join(skillsDir, ".gitkeep"), "");
		const h = await harness({}, { skillsDir });
		const trigger = message({ mentionsBot: true, text: "without skill" });

		await h.runner.handle(trigger);

		await waitFor(() => h.poster.calls.length === 1, "reply posted");
		const argv = await h.argvSeen("C01", trigger.id);
		expect(argv).not.toContain("--skill");

		await waitFor(() => h.runner.activeSessionCount === 0, "session removed");
	});

	it("skillsDir が未存在のディレクトリのときも --skill を渡さない", async () => {
		const skillsDir = join(
			await mkdtemp(join(tmpdir(), "pi-chat-runner-skills-")),
			"does-not-exist",
		);
		const h = await harness({}, { skillsDir });
		const trigger = message({ mentionsBot: true, text: "missing skills dir" });

		await h.runner.handle(trigger);

		await waitFor(() => h.poster.calls.length === 1, "reply posted");
		const argv = await h.argvSeen("C01", trigger.id);
		expect(argv).not.toContain("--skill");

		await waitFor(() => h.runner.activeSessionCount === 0, "session removed");
	});
});

describe("SessionRunner (Step 4: lease / flush-ack / linger)", () => {
	it("flushes the workdir before acking inbox items (flush → ack order)", async () => {
		const calls: string[] = [];
		class RecordingStorage implements WorkdirStorage {
			async restore(): Promise<boolean> {
				calls.push("restore");
				return false;
			}
			async flush(): Promise<void> {
				calls.push("flush");
			}
		}
		const store = new InMemoryStateStore();
		const originalAck = store.inbox.ack.bind(store.inbox);
		store.inbox.ack = async (threadKey, itemIds) => {
			calls.push(`ack:${itemIds.length}`);
			await originalAck(threadKey, itemIds);
		};

		const h = await harness(
			{},
			{ store, workdirStorage: new RecordingStorage() },
		);
		const trigger = message({ mentionsBot: true, text: "flush order" });
		await h.runner.handle(trigger);
		await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

		// kick で restore、agent_end で flush → ack の順 (persistence.md §3)
		expect(calls).toEqual(["restore", "flush", "ack:1"]);
		expect(await h.store.inbox.drain(threadKeyOf(trigger))).toEqual([]);
	});

	it("re-kicks the same thread after a failed kick (item is not lost)", async () => {
		// restore を 1 回だけ失敗させて kick を落とす (kick 失敗 = ack されないので
		// inbox に残り、次のイベントで拾い直される。persistence.md §4 の穴の解消)
		class FailOnceStorage implements WorkdirStorage {
			private failed = false;
			async restore(): Promise<boolean> {
				if (!this.failed) {
					this.failed = true;
					throw new Error("restore boom");
				}
				return false;
			}
			async flush(): Promise<void> {}
		}
		const h = await harness({}, { workdirStorage: new FailOnceStorage() });
		const trigger = message({ mentionsBot: true, text: "first try" });
		const threadKey = threadKeyOf(trigger);

		await h.runner.handle(trigger);
		expect(h.runner.activeSessionCount).toBe(0);
		expect(
			h.logLines().some((line) => line.msg === "session kick failed"),
		).toBe(true);
		// item は ack されず inbox に残っている
		expect((await h.store.inbox.drain(threadKey)).length).toBe(1);

		// 同スレッドの次のイベントで再 kick され、両方の item が拾い直される
		const retry = message({
			id: "1700000000.000400",
			conversation: { channelId: "C01", threadTs: trigger.id },
			mentionsBot: true,
			text: "second try",
		});
		await h.runner.handle(retry);
		await waitFor(() => h.poster.calls.length === 1, "reply posted");
		expect(h.poster.calls[0]?.text).toContain("first try");
		expect(h.poster.calls[0]?.text).toContain("second try");
		await waitFor(() => h.runner.activeSessionCount === 0, "session removed");
	});

	it("does not kick when the lease is held by another owner", async () => {
		const store = new InMemoryStateStore();
		const trigger = message({ mentionsBot: true, text: "contended" });
		const threadKey = threadKeyOf(trigger);
		const other = await store.leases.acquire(threadKey, "other:999", 60_000);
		expect(other).not.toBeNull();

		const h = await harness({}, { store });
		await h.runner.handle(trigger);

		// kick されない (eyes も付かない) が、item は enqueue 済みで保持者の drain が拾える
		expect(h.runner.activeSessionCount).toBe(0);
		expect(h.reactions).toEqual([]);
		expect((await store.inbox.drain(threadKey)).length).toBe(1);
		expect(
			h
				.logLines()
				.some(
					(line) => line.msg === "lease held by another process; enqueued only",
				),
		).toBe(true);
	});

	it("picks up an item enqueued during linger in the same process, then releases the lease", async () => {
		const h = await harness({}, { lingerMs: 300 });
		const trigger = message({ mentionsBot: true, text: "first turn" });
		const threadKey = threadKeyOf(trigger);

		await h.runner.handle(trigger);
		await waitFor(() => h.poster.calls.length === 1, "first reply posted");

		// agent_end 直後 (linger 窓内) に、handle を経由せず inbox へ直接届いた item を
		// 模す (例: 別インスタンスが enqueue だけした場合)。linger の再 drain が拾う
		await sleep(50);
		const late = message({
			id: "1700000000.000500",
			conversation: { channelId: "C01", threadTs: trigger.id },
			text: "late arrival",
		});
		await h.store.inbox.enqueue(threadKey, {
			id: inboxItemId(late),
			event: late,
			enqueuedAt: new Date(),
		});

		await waitFor(() => h.poster.calls.length === 2, "linger reply posted");
		expect(h.poster.calls[1]?.text).toBe(
			`echo: ${renderEvent(late, replyThreadKeyOf(late))}`,
		);
		await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

		// 同一プロセス (再 spawn なし) で処理されている
		const commands = (await h.commandsLog("C01", trigger.id)).map((line) =>
			JSON.parse(line),
		);
		expect(commands.map((c) => c.type)).toEqual(["prompt", "prompt"]);

		// linger 後に終了し lease が解放されている
		expect(
			await h.store.leases.acquire(threadKey, "probe", 1000),
		).not.toBeNull();
	});

	it("cleans up and releases the lease when pi responds with success:false", async () => {
		const h = await harness();
		const trigger = message({ mentionsBot: true, text: "FAIL_PROMPT please" });
		const threadKey = threadKeyOf(trigger);

		await h.runner.handle(trigger);

		await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

		// pi command failed が異常終了として処理されていること
		expect(h.logLines().some((line) => line.msg === "pi command failed")).toBe(
			true,
		);
		expect(h.logLines().some((line) => line.msg === "session failed")).toBe(
			true,
		);

		// lease は解放されている
		expect(
			await h.store.leases.acquire(threadKey, "probe", 1000),
		).not.toBeNull();

		// エラー通知がスレッドへ投稿されている (router.deliver 経由)
		expect(h.poster.calls).toHaveLength(1);
		expect(h.poster.calls[0]?.channelId).toBe("C01");
		expect(h.poster.calls[0]?.threadTs).toBe(trigger.id);
		expect(h.poster.calls[0]?.text).toContain(
			"No API key found for google-vertex",
		);

		// command failed (認証エラー等) はこのターンの入力を ack して捨てる (retry しない。
		// session-model.md §6)。捨てないと未 ack のまま次の新規イベントの drain が巻き込み、
		// 同じ入力で再び失敗するループになりうる。flush はしない (workdir は退避させない)
		expect((await h.store.inbox.drain(threadKey)).length).toBe(0);

		// 異常終了はトリガーメッセージへの ❌ で見える化する
		expect(
			h.reactions.some((r) => r.name === "x" && r.timestamp === trigger.id),
		).toBe(true);
	});

	it("drops the prompted item when pi crashes (process exit while running)", async () => {
		const h = await harness();
		const trigger = message({ mentionsBot: true, text: "CRASH_NOW please" });
		const threadKey = threadKeyOf(trigger);

		await h.runner.handle(trigger);

		await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

		// running のまま exit したので異常終了として処理されていること
		expect(
			h.logLines().some((line) => line.msg === "pi exited unexpectedly"),
		).toBe(true);

		// lease は解放されている
		expect(
			await h.store.leases.acquire(threadKey, "probe", 1000),
		).not.toBeNull();

		// クラッシュは workdir/transcript の破損を疑うため、このターンの入力は ack して
		// 捨てる (retry しない。session-model.md §6)。捨てないと次の新規イベントの drain が
		// 巻き込んで同じ状態から再 spawn し、決定的に再クラッシュしうる
		expect((await h.store.inbox.drain(threadKey)).length).toBe(0);

		// クラッシュはユーザーから見えないので ❌ で見える化する
		expect(
			h.reactions.some((r) => r.name === "x" && r.timestamp === trigger.id),
		).toBe(true);
	});

	it("kills pi and cleans up the session when a turn exceeds turnTimeoutMs", async () => {
		// fake-pi の HANG_FOREVER は response も agent_end も返さない。runner が
		// turnTimeoutMs (ここでは短く 100ms) 超過を検知して kill し、セッションを
		// 異常終了として畳むことを確認する (session-runtime.md §6)
		const h = await harness({}, { turnTimeoutMs: 100 });
		const trigger = message({ mentionsBot: true, text: "HANG_FOREVER please" });
		const threadKey = threadKeyOf(trigger);

		await h.runner.handle(trigger);

		await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

		expect(h.logLines().some((line) => line.msg === "turn timed out")).toBe(
			true,
		);
		expect(h.logLines().some((line) => line.msg === "session timed out")).toBe(
			true,
		);

		// lease は解放されている
		expect(
			await h.store.leases.acquire(threadKey, "probe", 1000),
		).not.toBeNull();

		// timeout 通知がスレッドへ投稿されている (router.deliver 経由)
		expect(h.poster.calls).toHaveLength(1);
		expect(h.poster.calls[0]?.channelId).toBe("C01");
		expect(h.poster.calls[0]?.threadTs).toBe(trigger.id);
		expect(h.poster.calls[0]?.text).toContain(":warning:");

		// timeout 時は flush も ack もしない — 未 ack の item は inbox に残り、
		// 次の kick で再実行される (session-runtime.md §6 の不変条件)
		expect((await h.store.inbox.drain(threadKey)).length).toBe(1);
	});

	it("does not fire the turn timeout when agent_end arrives before turnTimeoutMs", async () => {
		// 通常のターン (fake-pi は即座に reply → agent_end を返す) では
		// turnTimeoutMs (短く 200ms) が経過してもタイマーは発火しない
		// (onAgentEnd 冒頭でクリアされているため)
		const h = await harness({}, { turnTimeoutMs: 200 });
		const trigger = message({ mentionsBot: true, text: "no timeout here" });

		await h.runner.handle(trigger);
		await waitFor(() => h.poster.calls.length === 1, "reply posted");
		await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

		// タイマーが発火していれば余分に 300ms 待った後もログに残るはずなので、
		// 発火していないことを確認する
		await sleep(300);
		expect(h.logLines().some((line) => line.msg === "turn timed out")).toBe(
			false,
		);
		expect(h.poster.calls).toHaveLength(1);
	});

	it("does not re-prompt items drained at kick when a later drain returns them (promptedIds)", async () => {
		// drain は非破壊なので、kick で prompt 済みの trigger item は ack されるまで
		// (= 最初の agent_end まで) 再 drain に出続ける。steer パスの drain と
		// agent_end の再 drain の両方で、promptedIds による除外が効くことを確認する
		const h = await harness();
		const trigger = message({ mentionsBot: true, text: "WAIT_FOR_STEER" });
		await h.runner.handle(trigger);
		await waitFor(async () => {
			try {
				return (await h.commandsLog("C01", trigger.id)).length >= 1;
			} catch {
				return false;
			}
		}, "initial prompt recorded");

		// この時点で trigger item は prompt 済みだが未 ack (agent_end 前)。
		// 追いメッセージの steer では trigger item を除外して配達する
		const followUp = message({
			id: "1700000000.000600",
			conversation: { channelId: "C01", threadTs: trigger.id },
			text: "follow up only",
		});
		await h.runner.handle(followUp);

		await waitFor(() => h.poster.calls.length === 1, "steered reply posted");
		await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

		const commands = (await h.commandsLog("C01", trigger.id)).map((line) =>
			JSON.parse(line),
		);
		// prompt は kick の 1 回だけ。steer は followUp のみ (trigger の再送なし)
		expect(commands.map((c) => c.type)).toEqual(["prompt", "steer"]);
		expect(commands[1]?.message).toBe(
			renderEvent(followUp, replyThreadKeyOf(followUp)),
		);
		expect(commands[1]?.message).not.toContain("WAIT_FOR_STEER");
	});

	it("trigger.debounceSec: 連投バーストの 2 通が 1 回の kick にまとめられる", async () => {
		const h = await harness({
			C01: {
				trigger: {
					combinator: "any",
					gates: [{ kind: "passthrough" }],
					debounceSec: 0.2,
				},
			},
		});
		const first = message({ text: "first burst message" });
		const threadKey = threadKeyOf(first);

		await h.runner.handle(first);
		// debounce 中はまだ kick されていない
		expect(h.runner.activeSessionCount).toBe(0);

		await sleep(50); // debounceSec (200ms) 未満のうちに 2 通目を送る
		const second = message({
			id: "1700000000.000700",
			conversation: { channelId: "C01", threadTs: first.id },
			text: "second burst message",
		});
		await h.runner.handle(second);
		expect(h.runner.activeSessionCount).toBe(0);

		await waitFor(
			() => h.poster.calls.length === 1,
			"reply posted after debounce",
		);
		await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

		const commands = (await h.commandsLog("C01", first.id)).map((line) =>
			JSON.parse(line),
		);
		// kick は 1 回だけ (prompt 1 件) で、初回 prompt に 2 通とも含まれる
		expect(commands.map((c) => c.type)).toEqual(["prompt"]);
		expect(commands[0]?.message).toContain("first burst message");
		expect(commands[0]?.message).toContain("second burst message");
		expect(await h.store.inbox.drain(threadKey)).toEqual([]);
	});

	it("trigger.debounceSec: mentionsBot のメッセージは debounce をバイパスして即 kick される", async () => {
		const h = await harness({
			C01: {
				trigger: {
					combinator: "any",
					gates: [{ kind: "passthrough" }],
					debounceSec: 5,
				},
			},
		});
		const trigger = message({
			mentionsBot: true,
			text: "mention bypasses debounce",
		});

		await h.runner.handle(trigger);

		// debounceSec = 5s だが mentionsBot なので即座に kick される (待たない)
		await waitFor(
			() => h.poster.calls.length === 1,
			"reply posted immediately",
			2000,
		);
		await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

		const commands = (await h.commandsLog("C01", trigger.id)).map((line) =>
			JSON.parse(line),
		);
		expect(commands.map((c) => c.type)).toEqual(["prompt"]);
	});

	it("trigger.cooldownSec が設定されていたら未実装として warn する", async () => {
		const h = await harness({
			C01: {
				trigger: {
					combinator: "any",
					gates: [{ kind: "mention" }],
					cooldownSec: 30,
				},
			},
		});
		const trigger = message({ mentionsBot: true, text: "cooldown configured" });

		await h.runner.handle(trigger);
		await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

		expect(
			h
				.logLines()
				.some(
					(line) =>
						typeof line.msg === "string" &&
						line.msg.includes("cooldownSec") &&
						line.msg.includes("not implemented"),
				),
		).toBe(true);
	});
});

describe("resolveSessionPolicy", () => {
	it("既定はチャンネル: session=thread, reply=thread", () => {
		expect(resolveSessionPolicy(null, false)).toEqual({
			sessionMode: "thread",
			replyMode: "thread",
		});
	});

	it("既定は DM: session=channel, reply=flat", () => {
		expect(resolveSessionPolicy(null, true)).toEqual({
			sessionMode: "channel",
			replyMode: "flat",
		});
	});

	it("doc の指定が isDm の既定より優先される (DM でも doc 指定が勝つ)", () => {
		expect(
			resolveSessionPolicy(
				{ session: { mode: "thread" }, reply: { mode: "thread" } },
				true,
			),
		).toEqual({ sessionMode: "thread", replyMode: "thread" });
	});

	it("doc の一部指定のみ上書きし、残りは isDm の既定に従う", () => {
		expect(
			resolveSessionPolicy({ session: { mode: "channel" } }, false),
		).toEqual({
			sessionMode: "channel",
			replyMode: "thread",
		});
	});
});

describe("sessionKeyOf", () => {
	it("thread モード: threadTs があれば channelId:threadTs", () => {
		expect(
			sessionKeyOf(
				message({ conversation: { channelId: "C01", threadTs: "1699.5" } }),
				THREAD_POLICY,
			),
		).toBe("C01:1699.5");
	});

	it("thread モード: threadTs が無ければメッセージ ts で代替する", () => {
		expect(sessionKeyOf(message(), THREAD_POLICY)).toBe(
			"C01:1700000000.000100",
		);
	});

	it("channel モード: threadTs の有無に関わらず channelId のみ", () => {
		const policy: SessionPolicy = { sessionMode: "channel", replyMode: "flat" };
		expect(sessionKeyOf(message(), policy)).toBe("C01");
		expect(
			sessionKeyOf(
				message({ conversation: { channelId: "C01", threadTs: "1699.5" } }),
				policy,
			),
		).toBe("C01");
	});
});

describe("replyThreadKeyOf", () => {
	it("常に channelId:threadTs ?? メッセージ ts を返す (sessionMode に関わらない)", () => {
		expect(replyThreadKeyOf(message())).toBe("C01:1700000000.000100");
		expect(
			replyThreadKeyOf(
				message({ conversation: { channelId: "C01", threadTs: "1699.5" } }),
			),
		).toBe("C01:1699.5");
	});
});

describe("renderEvent", () => {
	it("shows displayName with the user id when resolved", () => {
		const event = message({
			sender: { id: "U123", isBot: false, displayName: "pokutuna" },
			text: "hello",
		});
		expect(renderEvent(event)).toBe("<pokutuna (U123)> のメッセージ:\nhello");
	});

	it("falls back to the bare user id when unresolved", () => {
		const event = message({
			sender: { id: "U123", isBot: false },
			text: "hello",
		});
		expect(renderEvent(event)).toBe("<U123> のメッセージ:\nhello");
	});

	it("thread_key 指定時はヘッダに thread_key を注記する", () => {
		const event = message({
			sender: { id: "U123", isBot: false },
			text: "hello",
		});
		expect(renderEvent(event, "C01:1700000000.000100")).toBe(
			"<U123> のメッセージ (thread_key: C01:1700000000.000100):\nhello",
		);
	});
});

describe("isIdleExpired", () => {
	it("ちょうど idleResetMinutes 分では超過していない (false)", () => {
		const lastUpdatedAt = new Date("2026-07-05T00:00:00Z");
		const now = lastUpdatedAt.getTime() + 5 * 60_000;
		expect(isIdleExpired(lastUpdatedAt, 5, now)).toBe(false);
	});

	it("idleResetMinutes 分を 1ms でも超えたら超過している (true)", () => {
		const lastUpdatedAt = new Date("2026-07-05T00:00:00Z");
		const now = lastUpdatedAt.getTime() + 5 * 60_000 + 1;
		expect(isIdleExpired(lastUpdatedAt, 5, now)).toBe(true);
	});

	it("idleResetMinutes 未満なら超過していない (false)", () => {
		const lastUpdatedAt = new Date("2026-07-05T00:00:00Z");
		const now = lastUpdatedAt.getTime() + 4 * 60_000;
		expect(isIdleExpired(lastUpdatedAt, 5, now)).toBe(false);
	});
});

describe("computeKickDelayMs", () => {
	it("通常ケース: 残り debounceSec 分をそのまま返す (hard cap に届かない)", () => {
		const nowMs = 1_000_000;
		expect(
			computeKickDelayMs({ nowMs, firstPendingAtMs: nowMs, debounceSec: 2 }),
		).toBe(2000);
	});

	it("後続メッセージでスライドしても、firstPendingAt からの経過が hard cap 未満なら debounceSec 分を返す", () => {
		const firstPendingAtMs = 1_000_000;
		const nowMs = firstPendingAtMs + 3000; // 3s 経過(次の debounceSec=2s も cap=6s 未満)
		expect(
			computeKickDelayMs({ nowMs, firstPendingAtMs, debounceSec: 2 }),
		).toBe(2000);
	});

	it("hard cap (firstPendingAt + debounceSec*3) を超えて延ばさない", () => {
		const firstPendingAtMs = 1_000_000;
		// cap = firstPendingAtMs + 6000。now が cap の 1000ms 手前なら残りは 1000ms
		// (debounceSec 分の 2000ms を要求しても cap で切られる)
		const nowMs = firstPendingAtMs + 5000;
		expect(
			computeKickDelayMs({ nowMs, firstPendingAtMs, debounceSec: 2 }),
		).toBe(1000);
	});

	it("残りが 0 未満になるケースは 0 を返す (即 kick)", () => {
		const firstPendingAtMs = 1_000_000;
		const nowMs = firstPendingAtMs + 10_000; // hard cap (6000ms) を過ぎている
		expect(
			computeKickDelayMs({ nowMs, firstPendingAtMs, debounceSec: 2 }),
		).toBe(0);
	});

	it("firstPendingAtMs と同時刻 (最初のメッセージ) では debounceSec がそのまま残り ms になる", () => {
		const nowMs = 5000;
		expect(
			computeKickDelayMs({ nowMs, firstPendingAtMs: nowMs, debounceSec: 0.5 }),
		).toBe(500);
	});
});

describe("hasSkillEntries", () => {
	it("SKILL.md 等の実体があれば true を返す", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-chat-runner-skills-"));
		await mkdir(join(dir, "example-skill"), { recursive: true });
		await writeFile(join(dir, "example-skill", "SKILL.md"), "# example\n");
		expect(await hasSkillEntries(dir)).toBe(true);
	});

	it(".gitkeep のみのディレクトリは false を返す", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-chat-runner-skills-"));
		await writeFile(join(dir, ".gitkeep"), "");
		expect(await hasSkillEntries(dir)).toBe(false);
	});

	it("空ディレクトリは false を返す", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-chat-runner-skills-"));
		expect(await hasSkillEntries(dir)).toBe(false);
	});

	it("存在しないディレクトリは false を返す", async () => {
		const dir = join(
			await mkdtemp(join(tmpdir(), "pi-chat-runner-skills-")),
			"does-not-exist",
		);
		expect(await hasSkillEntries(dir)).toBe(false);
	});
});

describe("inboxItemId", () => {
	it("prefers Slack event_id from metadata", () => {
		expect(inboxItemId(message({ metadata: { eventId: "Ev123" } }))).toBe(
			"Ev123",
		);
	});

	it("falls back to message ts when metadata has no eventId", () => {
		expect(inboxItemId(message({ metadata: {} }))).toBe("1700000000.000100");
	});
});

describe("toGateSpecs", () => {
	it("narrows supported kinds and keeps parameters", () => {
		expect(
			toGateSpecs(
				[
					{ kind: "mention" },
					{ kind: "keyword", pattern: "foo" },
					{ kind: "passthrough" },
					{ kind: "classifier", criteria: "is it a question?" },
					{ kind: "classifier", criteria: "urgent?", model: "gemini-x" },
				],
				() => {},
			),
		).toEqual([
			{ kind: "mention" },
			{ kind: "keyword", pattern: "foo" },
			{ kind: "passthrough" },
			{ kind: "classifier", criteria: "is it a question?" },
			{ kind: "classifier", criteria: "urgent?", model: "gemini-x" },
		]);
	});

	it("skips unsupported kinds with a warning instead of throwing", () => {
		const warnings: string[] = [];
		const specs = toGateSpecs(
			[{ kind: "cooldown" }, { kind: "mention" }],
			(message) => warnings.push(message),
		);
		expect(specs).toEqual([{ kind: "mention" }]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("cooldown");
	});

	it("skips a classifier gate missing criteria with a warning", () => {
		const warnings: string[] = [];
		const specs = toGateSpecs(
			[{ kind: "classifier" }, { kind: "mention" }],
			(message) => warnings.push(message),
		);
		expect(specs).toEqual([{ kind: "mention" }]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("classifier");
	});
});
