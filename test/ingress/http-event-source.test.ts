// HttpEventSource のテスト。実ポートを listen せず honoApp.request で直接叩く
// (Firestore エミュレータのポート 8080 との衝突を避ける。build-plan.md Step 5)。
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
	ChatEvent,
	InboundMessage,
} from "../../src/ingress/chat-event.js";
import type { Ack } from "../../src/ingress/event-source.js";
import { HttpEventSource } from "../../src/ingress/http-event-source.js";

const SIGNING_SECRET = "test-signing-secret";
const BOT_USER_ID = "UBOT123";

/** Slack 署名生成ヘルパ (Slack 公式仕様: v0:{timestamp}:{rawBody} を HMAC-SHA256) */
function sign(
	rawBody: string,
	timestamp: number,
): { "x-slack-request-timestamp": string; "x-slack-signature": string } {
	const baseString = `v0:${timestamp}:${rawBody}`;
	const hex = createHmac("sha256", SIGNING_SECRET)
		.update(baseString)
		.digest("hex");
	return {
		"x-slack-request-timestamp": String(timestamp),
		"x-slack-signature": `v0=${hex}`,
	};
}

function nowSec(): number {
	return Math.floor(Date.now() / 1000);
}

function build(): HttpEventSource {
	return new HttpEventSource({
		signingSecret: SIGNING_SECRET,
		botUserId: BOT_USER_ID,
		port: 0,
	});
}

/** port: 0 で HttpEventSource を start() し、honoApp.request で直接叩く
 * (実ポートの listen 自体は行われるが port:0 なので他のテスト・emulator と衝突しない)。 */
async function startWithHandler(
	source: HttpEventSource,
	onEvent: (e: ChatEvent, ack: Ack) => Promise<void>,
): Promise<void> {
	await source.start(onEvent);
}

describe("HttpEventSource", () => {
	it("verifies signature and normalizes event_callback into ChatEvent", async () => {
		const source = build();
		const received: InboundMessage[] = [];
		await startWithHandler(source, async (event, ack) => {
			if (event.kind === "message") received.push(event);
			await ack();
		});

		const body = JSON.stringify({
			type: "event_callback",
			event_id: "Ev123",
			event: {
				type: "app_mention",
				text: `<@${BOT_USER_ID}> hello`,
				user: "U123",
				channel: "C123",
				ts: "1720000000.000100",
			},
		});
		const ts = nowSec();
		const res = await source.honoApp.request("/slack/events", {
			method: "POST",
			headers: { "content-type": "application/json", ...sign(body, ts) },
			body,
		});

		expect(res.status).toBe(200);
		expect(received).toHaveLength(1);
		expect(received[0]?.mentionsBot).toBe(true);
		expect(received[0]?.text).toBe("hello");

		await source.stop();
	});

	it("rejects mismatched signature with 401 and does not call onEvent", async () => {
		const source = build();
		let called = false;
		await startWithHandler(source, async (_e, ack) => {
			called = true;
			await ack();
		});

		const body = JSON.stringify({
			type: "event_callback",
			event_id: "Ev123",
			event: {
				type: "message",
				text: "hi",
				user: "U123",
				channel: "C123",
				ts: "1720000000.000100",
			},
		});
		const ts = nowSec();
		const res = await source.honoApp.request("/slack/events", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-slack-request-timestamp": String(ts),
				"x-slack-signature": "v0=deadbeef",
			},
			body,
		});

		expect(res.status).toBe(401);
		expect(called).toBe(false);

		await source.stop();
	});

	it("rejects a timestamp older than 5 minutes with 401", async () => {
		const source = build();
		let called = false;
		await startWithHandler(source, async (_e, ack) => {
			called = true;
			await ack();
		});

		const body = JSON.stringify({
			type: "event_callback",
			event_id: "Ev123",
			event: {
				type: "message",
				text: "hi",
				user: "U123",
				channel: "C123",
				ts: "1720000000.000100",
			},
		});
		const staleTs = nowSec() - 301;
		const res = await source.honoApp.request("/slack/events", {
			method: "POST",
			headers: { "content-type": "application/json", ...sign(body, staleTs) },
			body,
		});

		expect(res.status).toBe(401);
		expect(called).toBe(false);

		await source.stop();
	});

	it("responds to url_verification with the challenge", async () => {
		const source = build();
		await startWithHandler(source, async (_e, ack) => {
			await ack();
		});

		const body = JSON.stringify({
			type: "url_verification",
			challenge: "abc123",
		});
		const ts = nowSec();
		const res = await source.honoApp.request("/slack/events", {
			method: "POST",
			headers: { "content-type": "application/json", ...sign(body, ts) },
			body,
		});

		expect(res.status).toBe(200);
		expect(await res.text()).toBe("abc123");

		await source.stop();
	});

	it("returns 200 without calling onEvent for events normalize() filters out", async () => {
		const source = build();
		let called = false;
		await startWithHandler(source, async (_e, ack) => {
			called = true;
			await ack();
		});

		const body = JSON.stringify({
			type: "event_callback",
			event_id: "Ev999",
			event: {
				type: "message",
				subtype: "message_changed",
				channel: "C123",
				ts: "1720000000.000100",
			},
		});
		const ts = nowSec();
		const res = await source.honoApp.request("/slack/events", {
			method: "POST",
			headers: { "content-type": "application/json", ...sign(body, ts) },
			body,
		});

		expect(res.status).toBe(200);
		expect(called).toBe(false);

		await source.stop();
	});

	it("returns 200 once onEvent calls ack(), before onEvent finishes", async () => {
		const source = build();
		let ackCalled = false;
		let finished = false;
		await startWithHandler(source, async (_e, ack) => {
			await ack();
			ackCalled = true;
			await new Promise((resolve) => setTimeout(resolve, 10));
			finished = true;
		});

		const body = JSON.stringify({
			type: "event_callback",
			event_id: "Ev1",
			event: {
				type: "message",
				text: "hi",
				user: "U1",
				channel: "C1",
				ts: "1720000000.000100",
			},
		});
		const ts = nowSec();
		const res = await source.honoApp.request("/slack/events", {
			method: "POST",
			headers: { "content-type": "application/json", ...sign(body, ts) },
			body,
		});

		expect(res.status).toBe(200);
		expect(ackCalled).toBe(true);
		// レスポンスはここで返るが、ハンドラの残処理は継続してよい (architecture.md §1)
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(finished).toBe(true);

		await source.stop();
	});

	it("returns 200 even if onEvent throws without calling ack()", async () => {
		const source = build();
		await startWithHandler(source, async () => {
			throw new Error("boom");
		});

		const body = JSON.stringify({
			type: "event_callback",
			event_id: "Ev2",
			event: {
				type: "message",
				text: "hi",
				user: "U1",
				channel: "C1",
				ts: "1720000000.000200",
			},
		});
		const ts = nowSec();
		const res = await source.honoApp.request("/slack/events", {
			method: "POST",
			headers: { "content-type": "application/json", ...sign(body, ts) },
			body,
		});

		expect(res.status).toBe(200);

		await source.stop();
	});

	it("GET /health returns 200 ok", async () => {
		const source = build();
		await startWithHandler(source, async (_e, ack) => {
			await ack();
		});

		const res = await source.honoApp.request("/health");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("ok");

		await source.stop();
	});
});
