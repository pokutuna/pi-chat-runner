import { describe, expect, it } from "vitest";

import type {
  ChatEvent,
  InboundMessage,
  ReactionEvent,
} from "../../src/ingress/chat-event.js";
import {
  enrichEvent,
  type UserResolver,
} from "../../src/ingress/user-resolver.js";

function baseMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    kind: "message",
    id: "1720000000.000100",
    conversation: { channelId: "C123" },
    sender: { id: "U123", isBot: false },
    text: "hello",
    mentionsBot: false,
    attachments: [],
    timestamp: new Date("2026-07-06T00:00:00Z"),
    metadata: {},
    ...overrides,
  };
}

describe("enrichEvent", () => {
  function stubResolver(names: Record<string, string>): UserResolver {
    return {
      async resolve(userId: string) {
        return names[userId] ?? null;
      },
    };
  }

  it("sets sender.displayName when the sender id resolves", async () => {
    const event = baseMessage({ sender: { id: "U123", isBot: false } });
    const resolver = stubResolver({ U123: "たなか" });
    const result = (await enrichEvent(event, resolver)) as InboundMessage;
    expect(result.sender).toEqual({
      id: "U123",
      isBot: false,
      displayName: "たなか",
    });
  });

  it("replaces all @U... mentions in text with resolved names", async () => {
    const event = baseMessage({
      text: "@U111 と @U222 によろしくと @U111 にも伝えて",
    });
    const resolver = stubResolver({
      U111: "アリス",
      U222: "ボブ",
      U123: "たなか",
    });
    const result = (await enrichEvent(event, resolver)) as InboundMessage;
    expect(result.text).toBe(
      "@アリス (U111) と @ボブ (U222) によろしくと @アリス (U111) にも伝えて",
    );
  });

  it("leaves unresolved mention ids untouched", async () => {
    const event = baseMessage({ text: "@U999 さんへ" });
    const resolver = stubResolver({ U123: "たなか" });
    const result = (await enrichEvent(event, resolver)) as InboundMessage;
    expect(result.text).toBe("@U999 さんへ");
  });

  it("passes through non-message events unchanged", async () => {
    const event: ReactionEvent = {
      kind: "reaction",
      emoji: "eyes",
      targetMessageId: "1720000000.000100",
      targetIsOwnMessage: false,
      conversation: { channelId: "C123" },
      sender: { id: "U123", isBot: false },
      added: true,
      timestamp: new Date("2026-07-06T00:00:00Z"),
    };
    const resolver = stubResolver({ U123: "たなか" });
    const result = await enrichEvent(event, resolver);
    expect(result).toBe(event);
  });

  it("does not mutate the original event object", async () => {
    const event = baseMessage({
      sender: { id: "U123", isBot: false },
      text: "@U999 さんへ",
    });
    const resolver = stubResolver({ U123: "たなか" });
    await enrichEvent(event as ChatEvent, resolver);
    expect(event.sender.displayName).toBeUndefined();
    expect(event.text).toBe("@U999 さんへ");
  });
});
