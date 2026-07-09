// startBridge の配線を検証する統合テスト。
//
// eventSource.start() が呼ばれたら ChatEvent を 1 個流すスタブ Ingress +
// InMemoryStateStore + FileConfigSource (test/fixtures/config) + fake-pi
// (test/fixtures/fake-pi.mjs。test/session/runner.test.ts の harness と同じ方法) で、
// mention イベント → 返信が WebClient 相当の poster に届くことを 1 本だけ確認する。
// SessionRunner 自体の詳細な振る舞い (gate/lease/linger 等) は runner.test.ts の担当。

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { WebClient } from "@slack/web-api";
import pino from "pino";
import { describe, expect, it } from "vitest";

import { startBridge } from "../src/bridge.js";
import { FileConfigSource } from "../src/config/config-source.js";
import type { ChatEvent } from "../src/ingress/chat-event.js";
import type { Ack, Ingress } from "../src/ingress/ingress.js";
import { InMemoryStateStore } from "../src/store/state/backends/memory.js";

/** BridgeOptions.web が要求する @slack/web-api の WebClient のうち、bridge が実際に
 * 呼び出す 2 メソッドだけの最小 IF。テストではこれだけ満たすスタブを渡す。 */
type MinimalWebClient = Pick<WebClient, "chat" | "reactions">;

const FAKE_PI = fileURLToPath(
	new URL("./fixtures/fake-pi.mjs", import.meta.url),
);
const CONFIG_DIR = fileURLToPath(new URL("./fixtures/config", import.meta.url));

/** eventSource.start() が呼ばれたら onEvent に渡された events を順に流すだけの
 * スタブ Ingress。ack は呼ばれたことだけ記録する。 */
class StubIngress implements Ingress {
	acked = 0;
	constructor(private readonly events: ChatEvent[]) {}

	async start(
		onEvent: (e: ChatEvent, ack: Ack) => Promise<void>,
	): Promise<void> {
		for (const event of this.events) {
			await onEvent(event, async () => {
				this.acked += 1;
			});
		}
	}

	async stop(): Promise<void> {}
}

/** WebClient 相当のスタブ。postMessage / reactions.add だけ最小のメソッドを持つ。
 * MinimalWebClient (chat/reactions のみ) までは型で保証し、bridge が要求する
 * フルの WebClient への最後の変換だけ型アサーションする (メソッド以外のフィールドは
 * bridge が使わないため untyped キャストの範囲を最小化できる)。 */
function fakeWebClient(): {
	client: WebClient;
	posted: { channel: string; thread_ts?: string; text: string }[];
	reacted: { channel: string; timestamp: string; name: string }[];
} {
	const posted: { channel: string; thread_ts?: string; text: string }[] = [];
	const reacted: { channel: string; timestamp: string; name: string }[] = [];
	const minimal: MinimalWebClient = {
		chat: {
			async postMessage(args: {
				channel: string;
				thread_ts?: string;
				text: string;
			}) {
				posted.push(args);
				return {};
			},
		} as WebClient["chat"],
		reactions: {
			async add(args: { channel: string; timestamp: string; name: string }) {
				reacted.push(args);
				return {};
			},
		} as WebClient["reactions"],
	};
	return { client: minimal as WebClient, posted, reacted };
}

async function waitFor(
	condition: () => boolean,
	label: string,
	timeoutMs = 5000,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`timed out waiting for: ${label}`);
}

describe("startBridge", () => {
	it("wires eventSource → SessionRunner → web client for a mention event", async () => {
		const channelId = "C0000000001";
		const triggerTs = "1700000000.000100";
		const event: ChatEvent = {
			kind: "message",
			id: triggerTs,
			conversation: { channelId },
			sender: { id: "U01", isBot: false },
			text: "hello bridge",
			mentionsBot: true,
			attachments: [],
			timestamp: new Date("2026-07-06T00:00:00Z"),
			metadata: { eventId: "Ev-bridge-test" },
		};

		const eventSource = new StubIngress([event]);
		const web = fakeWebClient();
		const agentHome = await mkdtemp(
			join(tmpdir(), "pi-chat-runner-bridge-home-"),
		);
		const logger = pino({ level: "silent" });

		// BridgeOptions は piBinary/workdirRoot を出していない (SessionRunner の既定に
		// 委ねる)。PiProcess は起動時に env PI_BIN → 既定 "pi" の順で pi バイナリを選ぶ
		// (session/runtime.ts buildSpawnCommand) ため、ここでは process.env で差し込む
		// (test/session/runner.test.ts の harness は piBinary オプションで直接渡せるが、
		// BridgeOptions にはその seam が無いため env 経由になる)
		const previousPiBin = process.env.PI_BIN;
		process.env.PI_BIN = FAKE_PI;
		try {
			await startBridge({
				eventSource,
				web: web.client,
				store: new InMemoryStateStore(),
				configSource: new FileConfigSource(CONFIG_DIR),
				agentHome,
				logger,
			});
		} finally {
			if (previousPiBin === undefined) {
				delete process.env.PI_BIN;
			} else {
				process.env.PI_BIN = previousPiBin;
			}
		}

		expect(eventSource.acked).toBe(1);
		await waitFor(() => web.posted.length === 1, "reply posted to web client");
		expect(web.posted[0]).toMatchObject({
			channel: channelId,
			thread_ts: triggerTs,
			text: expect.stringContaining("hello bridge"),
		});
		await waitFor(
			() => web.reacted.some((r) => r.name === "white_check_mark"),
			"check reaction",
		);
	});

	it("uses an injected poster instead of the web client's chat.postMessage", async () => {
		const channelId = "C0000000002";
		const triggerTs = "1700000000.000200";
		const event: ChatEvent = {
			kind: "message",
			id: triggerTs,
			conversation: { channelId },
			sender: { id: "U01", isBot: false },
			text: "hello injected poster",
			mentionsBot: true,
			attachments: [],
			timestamp: new Date("2026-07-06T00:00:00Z"),
			metadata: { eventId: "Ev-bridge-poster-test" },
		};

		const eventSource = new StubIngress([event]);
		const web = fakeWebClient();
		const posted: { channelId: string; text: string; threadTs?: string }[] = [];
		const injectedPoster = {
			async postMessage(
				postedChannelId: string,
				text: string,
				threadTs?: string,
			) {
				posted.push({
					channelId: postedChannelId,
					text,
					...(threadTs !== undefined ? { threadTs } : {}),
				});
			},
		};
		const agentHome = await mkdtemp(
			join(tmpdir(), "pi-chat-runner-bridge-poster-home-"),
		);
		const logger = pino({ level: "silent" });

		const previousPiBin = process.env.PI_BIN;
		process.env.PI_BIN = FAKE_PI;
		try {
			await startBridge({
				eventSource,
				web: web.client,
				store: new InMemoryStateStore(),
				configSource: new FileConfigSource(CONFIG_DIR),
				agentHome,
				logger,
				poster: injectedPoster,
			});
		} finally {
			if (previousPiBin === undefined) {
				delete process.env.PI_BIN;
			} else {
				process.env.PI_BIN = previousPiBin;
			}
		}

		expect(eventSource.acked).toBe(1);
		await waitFor(() => posted.length === 1, "reply posted to injected poster");
		expect(posted[0]).toMatchObject({
			channelId,
			threadTs: triggerTs,
			text: expect.stringContaining("hello injected poster"),
		});
		expect(web.posted).toHaveLength(0);
	});
});
