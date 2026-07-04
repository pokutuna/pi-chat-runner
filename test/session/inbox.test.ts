import { describe, expect, it } from "vitest";
import type { InboundMessage } from "../../src/ingress/chat-event.js";
import {
	type InboxItem,
	InMemoryInbox,
	inboxItemId,
} from "../../src/session/inbox.js";

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
	return {
		kind: "message",
		id: "1700000000.000100",
		conversation: { channelId: "C01" },
		sender: { id: "U01", isBot: false },
		text: "hello",
		mentionsBot: false,
		attachments: [],
		timestamp: new Date("2026-07-05T00:00:00Z"),
		metadata: {},
		...overrides,
	};
}

function item(id: string): InboxItem {
	return { id, event: message(), enqueuedAt: new Date() };
}

describe("inboxItemId", () => {
	it("prefers Slack event_id from metadata", () => {
		const event = message({ metadata: { eventId: "Ev123" } });
		expect(inboxItemId(event)).toBe("Ev123");
	});

	it("falls back to message ts when metadata has no eventId", () => {
		expect(inboxItemId(message())).toBe("1700000000.000100");
	});
});

describe("InMemoryInbox", () => {
	it("enqueues and drains in order", async () => {
		const inbox = new InMemoryInbox();
		expect(await inbox.enqueue("t1", item("a"))).toBe(true);
		expect(await inbox.enqueue("t1", item("b"))).toBe(true);

		const drained = await inbox.drain("t1");
		expect(drained.map((i) => i.id)).toEqual(["a", "b"]);
	});

	it("drain empties the queue", async () => {
		const inbox = new InMemoryInbox();
		await inbox.enqueue("t1", item("a"));
		await inbox.drain("t1");
		expect(await inbox.drain("t1")).toEqual([]);
	});

	it("dedupes by item id and returns false", async () => {
		const inbox = new InMemoryInbox();
		expect(await inbox.enqueue("t1", item("a"))).toBe(true);
		expect(await inbox.enqueue("t1", item("a"))).toBe(false);
		expect((await inbox.drain("t1")).map((i) => i.id)).toEqual(["a"]);
	});

	it("keeps dedupe effective after drain (Slack retry window)", async () => {
		const inbox = new InMemoryInbox();
		await inbox.enqueue("t1", item("a"));
		await inbox.drain("t1");
		expect(await inbox.enqueue("t1", item("a"))).toBe(false);
		expect(await inbox.drain("t1")).toEqual([]);
	});

	it("isolates queues per thread key", async () => {
		const inbox = new InMemoryInbox();
		await inbox.enqueue("t1", item("a"));
		await inbox.enqueue("t2", item("a"));
		expect((await inbox.drain("t1")).map((i) => i.id)).toEqual(["a"]);
		expect((await inbox.drain("t2")).map((i) => i.id)).toEqual(["a"]);
	});
});
