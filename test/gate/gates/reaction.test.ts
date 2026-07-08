import { describe, expect, it } from "vitest";
import { ReactionGate } from "../../../src/gate/gates/reaction.js";
import type {
	InboundMessage,
	ReactionEvent,
} from "../../../src/ingress/chat-event.js";

function makeReaction(overrides: Partial<ReactionEvent> = {}): ReactionEvent {
	return {
		kind: "reaction",
		emoji: "eyes",
		targetMessageId: "m1",
		targetIsOwnMessage: false,
		conversation: { channelId: "C1" },
		sender: { id: "U1", isBot: false },
		added: true,
		timestamp: new Date("2026-07-05T00:00:00Z"),
		...overrides,
	};
}

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

describe("ReactionGate", () => {
	it("triggers when the emoji is in the allowlist and added=true", () => {
		const gate = new ReactionGate(["eyes", "+1"]);
		const decision = gate.decide({
			event: makeReaction({ emoji: "eyes" }),
			recent: [],
		});
		expect(decision.trigger).toBe(true);
	});

	it("does not trigger when the emoji is not in the allowlist", () => {
		const gate = new ReactionGate(["eyes"]);
		const decision = gate.decide({
			event: makeReaction({ emoji: "tada" }),
			recent: [],
		});
		expect(decision.trigger).toBe(false);
	});

	it("does not trigger when the reaction was removed (added=false)", () => {
		const gate = new ReactionGate(["eyes"]);
		const decision = gate.decide({
			event: makeReaction({ emoji: "eyes", added: false }),
			recent: [],
		});
		expect(decision.trigger).toBe(false);
	});

	it("does not trigger for non-reaction events (self-guard)", () => {
		const gate = new ReactionGate(["eyes"]);
		const decision = gate.decide({ event: makeMessage(), recent: [] });
		expect(decision.trigger).toBe(false);
	});
});
