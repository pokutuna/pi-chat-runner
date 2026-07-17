import { describe, expect, it } from "vitest";

import { SenderGate } from "../../../src/gate/gates/sender.js";
import type {
  InboundMessage,
  ReactionEvent,
} from "../../../src/ingress/chat-event.js";

function makeMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    kind: "message",
    id: "m1",
    conversation: { channelId: "C1" },
    sender: { id: "U1", isBot: false, isSelf: false },
    text: "hello",
    mentionsBot: false,
    attachments: [],
    timestamp: new Date("2026-07-05T00:00:00Z"),
    metadata: {},
    ...overrides,
  };
}

function makeReaction(overrides: Partial<ReactionEvent> = {}): ReactionEvent {
  return {
    kind: "reaction",
    emoji: "eyes",
    targetMessageId: "m1",
    targetIsOwnMessage: false,
    conversation: { channelId: "C1" },
    sender: { id: "U1", isBot: false, isSelf: false },
    added: true,
    timestamp: new Date("2026-07-05T00:00:00Z"),
    ...overrides,
  };
}

describe("SenderGate", () => {
  it("triggers when is=bot and the message sender is a bot", () => {
    const gate = new SenderGate("bot");
    const decision = gate.decide({
      event: makeMessage({ sender: { id: "B1", isBot: true, isSelf: false } }),
    });
    expect(decision.trigger).toBe(true);
  });

  it("does not trigger when is=bot and the message sender is human", () => {
    const gate = new SenderGate("bot");
    const decision = gate.decide({
      event: makeMessage({ sender: { id: "U1", isBot: false, isSelf: false } }),
    });
    expect(decision.trigger).toBe(false);
  });

  it("triggers when is=human and the message sender is human", () => {
    const gate = new SenderGate("human");
    const decision = gate.decide({
      event: makeMessage({ sender: { id: "U1", isBot: false, isSelf: false } }),
    });
    expect(decision.trigger).toBe(true);
  });

  it("does not trigger when is=human and the message sender is a bot", () => {
    const gate = new SenderGate("human");
    const decision = gate.decide({
      event: makeMessage({ sender: { id: "B1", isBot: true, isSelf: false } }),
    });
    expect(decision.trigger).toBe(false);
  });

  it("judges by sender on reaction events too", () => {
    const gate = new SenderGate("bot");
    const decision = gate.decide({
      event: makeReaction({ sender: { id: "B1", isBot: true, isSelf: false } }),
    });
    expect(decision.trigger).toBe(true);
  });

  it("does not trigger for events without a sender", () => {
    const gate = new SenderGate("bot");
    const decision = gate.decide({
      event: { kind: "system", subtype: "channel_joined" },
    });
    expect(decision.trigger).toBe(false);
  });
});
