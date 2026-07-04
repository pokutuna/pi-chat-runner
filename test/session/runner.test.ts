// SessionRunner の統合テスト。実 Slack・実 LLM の代わりに:
// - pi     → test/fixtures/fake-pi.mjs (stdin の JSONL を記録し、reply/agent_end を吐く)
// - Slack  → FakePoster / FakeReactionClient
// - config → インメモリの ConfigSource
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { describe, expect, it } from "vitest";
import type { InboundMessage } from "../../src/ingress/chat-event.js";
import { Reactions } from "../../src/reply/reactions.js";
import { type ChatPoster, ReplyRouter } from "../../src/reply/router.js";
import { InMemoryInbox } from "../../src/session/inbox.js";
import {
	renderEvent,
	SessionRunner,
	threadKeyOf,
	toGateSpecs,
} from "../../src/session/runner.js";
import type { ChannelDoc } from "../../src/store/channel-doc.js";
import type { ConfigSource } from "../../src/store/config-source.js";

const FAKE_PI = fileURLToPath(
	new URL("../fixtures/fake-pi.mjs", import.meta.url),
);
const EXTENSION = fileURLToPath(
	new URL("../../extensions/reply.ts", import.meta.url),
);

class FakePoster implements ChatPoster {
	calls: { channelId: string; threadTs: string; text: string }[] = [];
	async postMessage(channelId: string, threadTs: string, text: string) {
		this.calls.push({ channelId, threadTs, text });
	}
}

class FakeConfigSource implements ConfigSource {
	constructor(private readonly docs: Record<string, ChannelDoc>) {}
	async channel(id: string): Promise<ChannelDoc | null> {
		return this.docs[id] ?? null;
	}
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
	reactions: { channel: string; timestamp: string; name: string }[];
	workdirRoot: string;
	logLines: () => Record<string, unknown>[];
	commandsLog(channelId: string, threadTs: string): Promise<string[]>;
	envSeen(channelId: string, threadTs: string): Promise<Record<string, string>>;
}

async function harness(
	docs: Record<string, ChannelDoc> = {},
	options: { extraEnv?: Record<string, string> } = {},
): Promise<Harness> {
	const workdirRoot = await mkdtemp(join(tmpdir(), "pi-chat-runner-test-"));
	const poster = new FakePoster();
	const reactionCalls: { channel: string; timestamp: string; name: string }[] =
		[];
	const { logger, lines } = collectingLogger();
	const runner = new SessionRunner({
		configSource: new FakeConfigSource(docs),
		inbox: new InMemoryInbox(),
		router: new ReplyRouter({ poster }),
		reactions: new Reactions({
			add: async (args) => {
				reactionCalls.push(args);
				return {};
			},
		}),
		extensionPath: EXTENSION,
		workdirRoot,
		piBinary: FAKE_PI,
		logger,
		...(options.extraEnv !== undefined ? { extraEnv: options.extraEnv } : {}),
	});
	return {
		runner,
		poster,
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
			text: `echo: ${renderEvent(trigger)}`,
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
		expect(h.poster.calls[0]?.text).toBe(`steered: ${renderEvent(followUp)}`);
		expect(h.poster.calls[0]?.threadTs).toBe(threadTs);

		await waitFor(() => h.runner.activeSessionCount === 0, "session removed");
		const commands = (await h.commandsLog("C01", threadTs)).map((line) =>
			JSON.parse(line),
		);
		expect(commands.map((c) => c.type)).toEqual(["prompt", "steer"]);
		expect(commands[1]?.message).toBe(renderEvent(followUp));
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
});

describe("threadKeyOf", () => {
	it("uses threadTs when present, message ts otherwise", () => {
		expect(threadKeyOf(message())).toBe("C01:1700000000.000100");
		expect(
			threadKeyOf(
				message({ conversation: { channelId: "C01", threadTs: "1699.5" } }),
			),
		).toBe("C01:1699.5");
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
				],
				() => {},
			),
		).toEqual([
			{ kind: "mention" },
			{ kind: "keyword", pattern: "foo" },
			{ kind: "passthrough" },
		]);
	});

	it("skips unsupported kinds with a warning instead of throwing", () => {
		const warnings: string[] = [];
		const specs = toGateSpecs(
			[
				{ kind: "classifier", criteria: "is it a question?" },
				{ kind: "cooldown" },
				{ kind: "mention" },
			],
			(message) => warnings.push(message),
		);
		expect(specs).toEqual([{ kind: "mention" }]);
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain("classifier");
	});
});
