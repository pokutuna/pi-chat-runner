import { describe, expect, it } from "vitest";

import { MentionGate } from "../../../src/gate/gates/mention.js";
import type {
  InboundMessage,
  ReactionEvent,
} from "../../../src/ingress/chat-event.js";

function makeMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    kind: "message",
    id: "m1",
    conversation: { channelId: "C1" },
    sender: { id: "U1", isBot: false },
    text: "hello",
    mentionsBot: false,
    attachments: [],
    timestamp: new Date("2026-07-05T00:00:00Z"),
    metadata: {},
    ...overrides,
  };
}

describe("MentionGate", () => {
  const gate = new MentionGate();

  it("triggers when mentionsBot is true", () => {
    const decision = gate.decide({
      event: makeMessage({ mentionsBot: true }),
      recent: [],
    });
    expect(decision.trigger).toBe(true);
  });

  it("does not trigger when mentionsBot is false", () => {
    const decision = gate.decide({
      event: makeMessage({ mentionsBot: false }),
      recent: [],
    });
    expect(decision.trigger).toBe(false);
  });

  it("does not trigger for non-message events", () => {
    const reaction: ReactionEvent = {
      kind: "reaction",
      emoji: "eyes",
      targetMessageId: "m1",
      targetIsOwnMessage: false,
      conversation: { channelId: "C1" },
      sender: { id: "U1", isBot: false },
      added: true,
      timestamp: new Date("2026-07-05T00:00:00Z"),
    };
    const decision = gate.decide({ event: reaction, recent: [] });
    expect(decision.trigger).toBe(false);
  });
});
