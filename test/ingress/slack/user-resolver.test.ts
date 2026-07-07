import { describe, expect, it } from "vitest";
import {
	SlackUserResolver,
	type UsersInfoClient,
} from "../../../src/ingress/slack/user-resolver.js";

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
