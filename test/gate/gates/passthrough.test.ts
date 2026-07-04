import { describe, expect, it } from "vitest";
import { PassthroughGate } from "../../../src/gate/gates/passthrough.js";
import type { InboundMessage } from "../../../src/ingress/chat-event.js";

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

describe("PassthroughGate", () => {
	const gate = new PassthroughGate();

	it("always triggers for non-bot messages", () => {
		const decision = gate.decide({
			event: makeMessage({ sender: { id: "U1", isBot: false } }),
			recent: [],
		});
		expect(decision.trigger).toBe(true);
	});

	it("does not trigger for bot senders (self-echo guard)", () => {
		const decision = gate.decide({
			event: makeMessage({ sender: { id: "BOT1", isBot: true } }),
			recent: [],
		});
		expect(decision.trigger).toBe(false);
	});

	it("triggers for non-message events (e.g. reaction)", () => {
		const decision = gate.decide({
			event: {
				kind: "reaction",
				emoji: "eyes",
				targetMessageId: "m1",
				targetIsOwnMessage: false,
				conversation: { channelId: "C1" },
				sender: { id: "U1", isBot: false },
				added: true,
				timestamp: new Date("2026-07-05T00:00:00Z"),
			},
			recent: [],
		});
		expect(decision.trigger).toBe(true);
	});
});
