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
const CONFIG_PATH = fileURLToPath(
  new URL("./fixtures/config/channels.yaml", import.meta.url),
);

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

/** pino のログ 1 行 (JSON) を配列に集めるテスト用ロガー
 * (test/session/runner.test.ts の collectingLogger と同じ方法)。 */
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

describe("startBridge", () => {
  it("wires eventSource → SessionRunner → web client for a mention event", async () => {
    const channelId = "C0000000001";
    const triggerTs = "1700000000.000100";
    const event: ChatEvent = {
      kind: "message",
      id: triggerTs,
      conversation: { channelId },
      sender: { id: "U01", isBot: false, isSelf: false },
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

    await startBridge({
      eventSource,
      web: web.client,
      store: new InMemoryStateStore(),
      configSource: new FileConfigSource(CONFIG_PATH),
      piEntrypoint: FAKE_PI,
      agentHome,
      logger,
    });

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
      sender: { id: "U01", isBot: false, isSelf: false },
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
        return { messageId: "msg-1" };
      },
      async updateMessage() {},
    };
    const agentHome = await mkdtemp(
      join(tmpdir(), "pi-chat-runner-bridge-poster-home-"),
    );
    const logger = pino({ level: "silent" });

    await startBridge({
      eventSource,
      web: web.client,
      store: new InMemoryStateStore(),
      configSource: new FileConfigSource(CONFIG_PATH),
      piBinary: FAKE_PI,
      agentHome,
      logger,
      poster: injectedPoster,
    });

    expect(eventSource.acked).toBe(1);
    await waitFor(() => posted.length === 1, "reply posted to injected poster");
    expect(posted[0]).toMatchObject({
      channelId,
      threadTs: triggerTs,
      text: expect.stringContaining("hello injected poster"),
    });
    expect(web.posted).toHaveLength(0);
  });

  it("ignores self-echo messages (sender.isSelf) without reaching the runner", async () => {
    const channelId = "C0000000003";
    const triggerTs = "1700000000.000300";
    const event: ChatEvent = {
      kind: "message",
      id: triggerTs,
      conversation: { channelId },
      sender: { id: "UBOTSELF", isBot: true, isSelf: true },
      text: "hello from myself",
      mentionsBot: true,
      attachments: [],
      timestamp: new Date("2026-07-06T00:00:00Z"),
      metadata: { eventId: "Ev-bridge-self-echo-test" },
    };

    const eventSource = new StubIngress([event]);
    const web = fakeWebClient();
    const agentHome = await mkdtemp(
      join(tmpdir(), "pi-chat-runner-bridge-self-echo-home-"),
    );
    const { logger, lines } = collectingLogger();

    await startBridge({
      eventSource,
      web: web.client,
      store: new InMemoryStateStore(),
      configSource: new FileConfigSource(CONFIG_PATH),
      piEntrypoint: FAKE_PI,
      agentHome,
      logger,
    });

    expect(eventSource.acked).toBe(1);
    expect(
      lines().some(
        (line) => line.msg === "event ignored" && line.reason === "self_echo",
      ),
    ).toBe(true);
    expect(web.posted).toHaveLength(0);
  });

  it("delivers other bots' messages (isBot=true, isSelf=false) to the runner", async () => {
    // allowBots opt-in channel (session-model.md §5) — allowBots なしでは
    // handle() が bot 投稿を既定で捨てるため、bridge がここまで届けることを
    // 検証するにはチャンネル側で明示的に許可する必要がある
    const channelId = "C0000000004";
    const triggerTs = "1700000000.000400";
    const event: ChatEvent = {
      kind: "message",
      id: triggerTs,
      conversation: { channelId },
      sender: { id: "UOTHERBOT", isBot: true, isSelf: false },
      text: "hello from another bot",
      mentionsBot: true,
      attachments: [],
      timestamp: new Date("2026-07-06T00:00:00Z"),
      metadata: { eventId: "Ev-bridge-other-bot-test" },
    };

    const eventSource = new StubIngress([event]);
    const web = fakeWebClient();
    const agentHome = await mkdtemp(
      join(tmpdir(), "pi-chat-runner-bridge-other-bot-home-"),
    );
    const logger = pino({ level: "silent" });

    await startBridge({
      eventSource,
      web: web.client,
      store: new InMemoryStateStore(),
      configSource: new FileConfigSource(CONFIG_PATH),
      piEntrypoint: FAKE_PI,
      agentHome,
      logger,
    });

    expect(eventSource.acked).toBe(1);
    await waitFor(
      () => web.posted.length === 1,
      "reply posted for other bot's message",
    );
    expect(web.posted[0]).toMatchObject({
      channel: channelId,
      thread_ts: triggerTs,
      text: expect.stringContaining("hello from another bot"),
    });
  });

  it("ignores self-echo reactions (sender.isSelf) without reaching the runner", async () => {
    const channelId = "C0000000005";
    const event: ChatEvent = {
      kind: "reaction",
      emoji: "eyes",
      targetMessageId: "1700000000.000500",
      targetIsOwnMessage: false,
      conversation: { channelId },
      sender: { id: "UBOTSELF", isBot: true, isSelf: true },
      added: true,
      timestamp: new Date("2026-07-06T00:00:00Z"),
    };

    const eventSource = new StubIngress([event]);
    const web = fakeWebClient();
    const agentHome = await mkdtemp(
      join(tmpdir(), "pi-chat-runner-bridge-reaction-self-echo-home-"),
    );
    const { logger, lines } = collectingLogger();

    await startBridge({
      eventSource,
      web: web.client,
      store: new InMemoryStateStore(),
      configSource: new FileConfigSource(CONFIG_PATH),
      piEntrypoint: FAKE_PI,
      agentHome,
      logger,
    });

    expect(eventSource.acked).toBe(1);
    expect(
      lines().some(
        (line) =>
          line.msg === "event ignored" &&
          line.reason === "self_echo" &&
          line.kind === "reaction",
      ),
    ).toBe(true);
    expect(web.reacted).toHaveLength(0);
  });
});
