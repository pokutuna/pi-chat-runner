import { describe, expect, it } from "vitest";
import type {
	InboundMessage,
	ReactionEvent,
} from "../src/ingress/chat-event.js";
import { SlackIngressAdapter } from "../src/ingress/slack-adapter.js";

const BOT_USER_ID = "UBOT123";

describe("SlackIngressAdapter.normalize", () => {
	const adapter = new SlackIngressAdapter(BOT_USER_ID);

	it("converts app_mention payload to InboundMessage with mention stripped", () => {
		const result = adapter.normalize(
			{
				type: "app_mention",
				text: `<@${BOT_USER_ID}> hello there`,
				user: "U123",
				channel: "C123",
				ts: "1720000000.000100",
				thread_ts: "1720000000.000100",
			},
			"Ev123",
		);

		expect(result).not.toBeNull();
		const msg = result as InboundMessage;
		expect(msg.kind).toBe("message");
		expect(msg.mentionsBot).toBe(true);
		expect(msg.text).toBe("hello there");
		expect(msg.conversation).toEqual({
			channelId: "C123",
			threadTs: "1720000000.000100",
		});
		expect(msg.sender).toEqual({ id: "U123", isBot: false });
		expect(msg.metadata).toEqual({ eventId: "Ev123" });
	});

	it("converts a plain message without mention to mentionsBot=false", () => {
		const result = adapter.normalize({
			type: "message",
			text: "just chatting",
			user: "U456",
			channel: "C123",
			ts: "1720000001.000100",
		});

		expect(result).not.toBeNull();
		const msg = result as InboundMessage;
		expect(msg.mentionsBot).toBe(false);
		expect(msg.text).toBe("just chatting");
		expect(msg.conversation.threadTs).toBeUndefined();
	});

	it("marks sender.isBot=true for messages with bot_id", () => {
		const result = adapter.normalize({
			type: "message",
			text: "posted by another bot",
			bot_id: "B999",
			channel: "C123",
			ts: "1720000002.000100",
		});

		expect(result).not.toBeNull();
		const msg = result as InboundMessage;
		expect(msg.sender.isBot).toBe(true);
		expect(msg.sender.id).toBe("B999");
	});

	it("converts reaction_added payload to ReactionEvent", () => {
		const result = adapter.normalize({
			type: "reaction_added",
			user: "U123",
			reaction: "eyes",
			item: { type: "message", channel: "C123", ts: "1720000000.000100" },
		});

		expect(result).not.toBeNull();
		const reaction = result as ReactionEvent;
		expect(reaction.kind).toBe("reaction");
		expect(reaction.emoji).toBe("eyes");
		expect(reaction.targetMessageId).toBe("1720000000.000100");
		expect(reaction.added).toBe(true);
		expect(reaction.conversation).toEqual({ channelId: "C123" });
	});

	it("returns null for message subtypes (e.g. message_changed)", () => {
		const result = adapter.normalize({
			type: "message",
			subtype: "message_changed",
			channel: "C123",
			ts: "1720000003.000100",
		});

		expect(result).toBeNull();
	});
});
