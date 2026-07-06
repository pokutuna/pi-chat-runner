import { describe, expect, it } from "vitest";
import type {
	ChatEvent,
	InboundMessage,
	ReactionEvent,
} from "../../src/ingress/chat-event.js";
import {
	enrichEvent,
	SlackUserResolver,
	type UserResolver,
	type UsersInfoClient,
} from "../../src/ingress/user-resolver.js";

function fakeUsersInfoClient(
	users: Record<
		string,
		{ profile?: { display_name?: string }; real_name?: string; name?: string }
	>,
): { client: UsersInfoClient; calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		client: {
			async usersInfo(userId: string) {
				calls.push(userId);
				const user = users[userId];
				return user !== undefined ? { user } : {};
			},
		},
	};
}

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

describe("SlackUserResolver.resolve", () => {
	it("uses profile.display_name when present", async () => {
		const { client } = fakeUsersInfoClient({
			U1: { profile: { display_name: "たなか" }, real_name: "Tanaka Taro" },
		});
		const resolver = new SlackUserResolver(client);
		expect(await resolver.resolve("U1")).toBe("たなか");
	});

	it("falls back to real_name when display_name is empty", async () => {
		const { client } = fakeUsersInfoClient({
			U1: { profile: { display_name: "" }, real_name: "Tanaka Taro" },
		});
		const resolver = new SlackUserResolver(client);
		expect(await resolver.resolve("U1")).toBe("Tanaka Taro");
	});

	it("falls back to name when display_name and real_name are absent", async () => {
		const { client } = fakeUsersInfoClient({
			U1: { name: "tanaka" },
		});
		const resolver = new SlackUserResolver(client);
		expect(await resolver.resolve("U1")).toBe("tanaka");
	});

	it("returns null when nothing is available", async () => {
		const { client } = fakeUsersInfoClient({
			U1: {},
		});
		const resolver = new SlackUserResolver(client);
		expect(await resolver.resolve("U1")).toBeNull();
	});

	it("caches the result and does not call usersInfo twice for the same id", async () => {
		const { client, calls } = fakeUsersInfoClient({
			U1: { real_name: "Tanaka Taro" },
		});
		const resolver = new SlackUserResolver(client);
		await resolver.resolve("U1");
		await resolver.resolve("U1");
		expect(calls).toEqual(["U1"]);
	});

	it("returns null and does not throw when usersInfo rejects", async () => {
		const resolver = new SlackUserResolver({
			usersInfo: async () => {
				throw new Error("api error");
			},
		});
		await expect(resolver.resolve("U1")).resolves.toBeNull();
	});
});

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
			"@アリス と @ボブ によろしくと @アリス にも伝えて",
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
