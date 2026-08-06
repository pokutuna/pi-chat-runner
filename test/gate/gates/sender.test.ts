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
  it("throws when none of is, id, name is given", () => {
    expect(() => new SenderGate({})).toThrow(/at least one of/);
    expect(() => new SenderGate({ id: [] })).toThrow(/at least one of/);
    expect(() => new SenderGate({ name: [] })).toThrow(/at least one of/);
  });

  describe("is", () => {
    it("triggers when is=bot and the message sender is a bot", () => {
      const gate = new SenderGate({ is: "bot" });
      const decision = gate.decide({
        event: makeMessage({
          sender: { id: "B1", isBot: true, isSelf: false },
        }),
      });
      expect(decision.trigger).toBe(true);
    });

    it("does not trigger when is=bot and the message sender is human", () => {
      const gate = new SenderGate({ is: "bot" });
      const decision = gate.decide({
        event: makeMessage({
          sender: { id: "U1", isBot: false, isSelf: false },
        }),
      });
      expect(decision.trigger).toBe(false);
    });

    it("triggers when is=human and the message sender is human", () => {
      const gate = new SenderGate({ is: "human" });
      const decision = gate.decide({
        event: makeMessage({
          sender: { id: "U1", isBot: false, isSelf: false },
        }),
      });
      expect(decision.trigger).toBe(true);
    });

    it("does not trigger when is=human and the message sender is a bot", () => {
      const gate = new SenderGate({ is: "human" });
      const decision = gate.decide({
        event: makeMessage({
          sender: { id: "B1", isBot: true, isSelf: false },
        }),
      });
      expect(decision.trigger).toBe(false);
    });

    it("judges by sender on reaction events too", () => {
      const gate = new SenderGate({ is: "bot" });
      const decision = gate.decide({
        event: makeReaction({
          sender: { id: "B1", isBot: true, isSelf: false },
        }),
      });
      expect(decision.trigger).toBe(true);
    });
  });

  describe("id", () => {
    it("triggers when the sender id is in the allowlist", () => {
      const gate = new SenderGate({ id: ["U1", "U2"] });
      const decision = gate.decide({
        event: makeMessage({
          sender: { id: "U1", isBot: false, isSelf: false },
        }),
      });
      expect(decision.trigger).toBe(true);
    });

    it("does not trigger when the sender id is not in the allowlist", () => {
      const gate = new SenderGate({ id: ["U1", "U2"] });
      const decision = gate.decide({
        event: makeMessage({
          sender: { id: "U9", isBot: false, isSelf: false },
        }),
      });
      expect(decision.trigger).toBe(false);
    });

    it("does not match against the displayName", () => {
      const gate = new SenderGate({ id: ["alice"] });
      const decision = gate.decide({
        event: makeMessage({
          sender: {
            id: "U1",
            isBot: false,
            isSelf: false,
            displayName: "alice",
          },
        }),
      });
      expect(decision.trigger).toBe(false);
    });

    it("judges by id on reaction events too", () => {
      const gate = new SenderGate({ id: ["U1"] });
      const decision = gate.decide({
        event: makeReaction({
          sender: { id: "U1", isBot: false, isSelf: false },
        }),
      });
      expect(decision.trigger).toBe(true);
    });
  });

  describe("name", () => {
    it("triggers when the sender displayName is in the allowlist", () => {
      const gate = new SenderGate({ name: ["alice", "bob"] });
      const decision = gate.decide({
        event: makeMessage({
          sender: {
            id: "U1",
            isBot: false,
            isSelf: false,
            displayName: "alice",
          },
        }),
      });
      expect(decision.trigger).toBe(true);
    });

    it("does not trigger when the displayName is not in the allowlist", () => {
      const gate = new SenderGate({ name: ["alice", "bob"] });
      const decision = gate.decide({
        event: makeMessage({
          sender: {
            id: "U1",
            isBot: false,
            isSelf: false,
            displayName: "carol",
          },
        }),
      });
      expect(decision.trigger).toBe(false);
    });

    it("fails closed when the displayName is unresolved", () => {
      const gate = new SenderGate({ name: ["alice"] });
      const decision = gate.decide({
        event: makeMessage({
          sender: { id: "U1", isBot: false, isSelf: false },
        }),
      });
      expect(decision.trigger).toBe(false);
      expect(decision.reason).toMatch(/no displayName/);
    });

    it("does not match against the sender id", () => {
      const gate = new SenderGate({ name: ["U1"] });
      const decision = gate.decide({
        event: makeMessage({
          sender: {
            id: "U1",
            isBot: false,
            isSelf: false,
            displayName: "alice",
          },
        }),
      });
      expect(decision.trigger).toBe(false);
    });

    it("judges by displayName on reaction events too", () => {
      const gate = new SenderGate({ name: ["alice"] });
      const decision = gate.decide({
        event: makeReaction({
          sender: {
            id: "U1",
            isBot: false,
            isSelf: false,
            displayName: "alice",
          },
        }),
      });
      expect(decision.trigger).toBe(true);
    });
  });

  describe("combined axes", () => {
    it("requires all specified axes to match (AND)", () => {
      const gate = new SenderGate({ is: "human", id: ["U1"], name: ["alice"] });
      const human = { id: "U1", isBot: false, isSelf: false };
      expect(
        gate.decide({
          event: makeMessage({ sender: { ...human, displayName: "alice" } }),
        }).trigger,
      ).toBe(true);
      expect(
        gate.decide({
          event: makeMessage({
            sender: { ...human, id: "U2", displayName: "alice" },
          }),
        }).trigger,
      ).toBe(false);
    });

    it("is + name requires both to match (AND)", () => {
      const gate = new SenderGate({ is: "human", name: ["alice"] });
      const human = { id: "U1", isBot: false, isSelf: false };
      expect(
        gate.decide({
          event: makeMessage({ sender: { ...human, displayName: "alice" } }),
        }).trigger,
      ).toBe(true);
      expect(
        gate.decide({
          event: makeMessage({ sender: { ...human, displayName: "bob" } }),
        }).trigger,
      ).toBe(false);
      expect(
        gate.decide({
          event: makeMessage({
            sender: {
              id: "B1",
              isBot: true,
              isSelf: false,
              displayName: "alice",
            },
          }),
        }).trigger,
      ).toBe(false);
    });
  });

  it("does not trigger for events without a sender", () => {
    const gate = new SenderGate({ is: "bot" });
    const decision = gate.decide({
      event: { kind: "system", subtype: "channel_joined" },
    });
    expect(decision.trigger).toBe(false);
  });
});
