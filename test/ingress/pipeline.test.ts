// Ingress ステージ (src/ingress/pipeline.ts) の単体テスト。
//
// ack → kind フィルタ → isSelf 除外 → enrichEvent → sink の順序と、それぞれで
// 止まること (docs/design/architecture.md §5, docs/design/ingress-egress.md §3)。
// チャット固有の二重配送吸収は codec 側 (test/ingress/slack/adapter.test.ts) の担当。

import pino from "pino";
import { describe, expect, it } from "vitest";

import type {
  ChatEvent,
  InboundMessage,
  ReactionEvent,
} from "../../src/ingress/chat-event.js";
import type { Ack, Ingress } from "../../src/ingress/ingress.js";
import {
  type IngressSink,
  startIngressPipeline,
} from "../../src/ingress/pipeline.js";
import type { UserResolver } from "../../src/ingress/user-resolver.js";

const silent = pino({ level: "silent" });

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    kind: "message",
    id: "1720000000.000100",
    conversation: { channelId: "C123" },
    sender: { id: "U123", isBot: false, isSelf: false },
    text: "hello",
    mentionsBot: true,
    attachments: [],
    timestamp: new Date("2026-07-06T00:00:00Z"),
    metadata: {},
    ...overrides,
  };
}

function reaction(overrides: Partial<ReactionEvent> = {}): ReactionEvent {
  return {
    kind: "reaction",
    emoji: "eyes",
    targetMessageId: "1720000000.000100",
    targetIsOwnMessage: false,
    conversation: { channelId: "C123" },
    sender: { id: "U123", isBot: false, isSelf: false },
    added: true,
    timestamp: new Date("2026-07-06T00:00:00Z"),
    ...overrides,
  };
}

/** start() 時に渡された events を順に流すスタブ Ingress。ack 回数を記録する。 */
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

function collectingSink(): IngressSink & {
  messages: InboundMessage[];
  reactions: ReactionEvent[];
} {
  const messages: InboundMessage[] = [];
  const reactions: ReactionEvent[] = [];
  return {
    messages,
    reactions,
    async message(event) {
      messages.push(event);
    },
    async reaction(event) {
      reactions.push(event);
    },
  };
}

function stubResolver(names: Record<string, string> = {}): UserResolver {
  return {
    async resolve(userId: string) {
      return names[userId] ?? null;
    },
    mentionPattern: /@(U[A-Z0-9]+)/g,
  };
}

async function run(
  events: ChatEvent[],
  resolver: UserResolver = stubResolver(),
): Promise<{
  ingress: StubIngress;
  sink: ReturnType<typeof collectingSink>;
}> {
  const ingress = new StubIngress(events);
  const sink = collectingSink();
  await startIngressPipeline({
    ingress,
    userResolver: resolver,
    sink,
    logger: silent,
  });
  return { ingress, sink };
}

describe("startIngressPipeline", () => {
  it("acks every event before handing it to the sink", async () => {
    const { ingress, sink } = await run([message(), reaction()]);
    expect(ingress.acked).toBe(2);
    expect(sink.messages).toHaveLength(1);
    expect(sink.reactions).toHaveLength(1);
  });

  it("acks events it drops as well (unsupported kinds)", async () => {
    const { ingress, sink } = await run([
      { kind: "system", subtype: "channel_joined" },
      { kind: "message_edited", id: "1", conversation: { channelId: "C123" } },
    ]);
    expect(ingress.acked).toBe(2);
    expect(sink.messages).toHaveLength(0);
    expect(sink.reactions).toHaveLength(0);
  });

  it("drops self-echo messages", async () => {
    const { ingress, sink } = await run([
      message({ sender: { id: "UBOT", isBot: true, isSelf: true } }),
    ]);
    expect(ingress.acked).toBe(1);
    expect(sink.messages).toHaveLength(0);
  });

  it("drops self-echo reactions", async () => {
    const { ingress, sink } = await run([
      reaction({ sender: { id: "UBOT", isBot: true, isSelf: true } }),
    ]);
    expect(ingress.acked).toBe(1);
    expect(sink.reactions).toHaveLength(0);
  });

  it("delivers other bots' messages (isBot=true, isSelf=false) — allowBots is the Gate's call", async () => {
    const { sink } = await run([
      message({ sender: { id: "UOTHERBOT", isBot: true, isSelf: false } }),
    ]);
    expect(sink.messages).toHaveLength(1);
    expect(sink.messages[0]?.sender.id).toBe("UOTHERBOT");
  });

  it("enriches the message before the sink sees it (sender name and mentions)", async () => {
    const { sink } = await run(
      [message({ text: "@U111 よろしく" })],
      stubResolver({ U123: "たなか", U111: "アリス" }),
    );
    expect(sink.messages[0]?.sender.displayName).toBe("たなか");
    expect(sink.messages[0]?.text).toBe("@アリス (U111) よろしく");
  });

  it("enriches the reaction sender before the sink sees it", async () => {
    const { sink } = await run([reaction()], stubResolver({ U123: "たなか" }));
    expect(sink.reactions[0]?.sender.displayName).toBe("たなか");
  });

  it("keeps processing later events when the sink throws", async () => {
    const ingress = new StubIngress([
      message({ id: "1" }),
      message({ id: "2" }),
    ]);
    const seen: string[] = [];
    await startIngressPipeline({
      ingress,
      userResolver: stubResolver(),
      sink: {
        async message(event) {
          seen.push(event.id);
          if (event.id === "1") throw new Error("boom");
        },
        async reaction() {},
      },
      logger: silent,
    });
    expect(seen).toEqual(["1", "2"]);
    expect(ingress.acked).toBe(2);
  });
});
