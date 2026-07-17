import { describe, expect, it } from "vitest";

import { KeywordGate } from "../../../src/gate/gates/keyword.js";
import type { InboundMessage } from "../../../src/ingress/chat-event.js";

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

describe("KeywordGate", () => {
  it("triggers when text matches the pattern", () => {
    const gate = new KeywordGate("deploy|release");
    const decision = gate.decide({
      event: makeMessage({ text: "let's deploy now" }),
    });
    expect(decision.trigger).toBe(true);
  });

  it("does not trigger when text does not match", () => {
    const gate = new KeywordGate("deploy|release");
    const decision = gate.decide({
      event: makeMessage({ text: "just chatting" }),
    });
    expect(decision.trigger).toBe(false);
  });

  it("does not trigger for non-message events", () => {
    const gate = new KeywordGate("deploy");
    const decision = gate.decide({
      event: {
        kind: "system",
        subtype: "channel_joined",
      },
    });
    expect(decision.trigger).toBe(false);
  });

  it("throws at construction time for an invalid regex", () => {
    expect(() => new KeywordGate("(unterminated")).toThrow(
      /Invalid regular expression/,
    );
  });
});
