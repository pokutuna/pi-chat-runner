// HttpIngress — Slack Events API (HTTP push) 経由の Ingress
// (docs/design/architecture.md §1, §6)
//
// Events API では「3 秒 ACK」は「200 レスポンスを返す」ことそのもの。Cloud Run の
// CPU always-allocated 前提 (§1) なので、ack() が呼ばれた時点で 200 を返し、
// ハンドラの残り処理はレスポンス後も CPU 上で継続してよい。onEvent が ack を呼ばずに
// 完了/例外を投げても 200 を返す (Slack の無用な再送を防ぐため。エラーは pino に残す)。

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

import { Hono } from "hono";

import type { Logger } from "../../logger.js";
import type { ChatEvent } from "../chat-event.js";
import type { Ack, Ingress } from "../ingress.js";
import { SlackIngressAdapter } from "./adapter.js";

/** リプレイ対策の許容ずれ (Slack 公式ドキュメント推奨値) */
const TIMESTAMP_TOLERANCE_SEC = 300;

export interface HttpIngressOptions {
	signingSecret: string;
	botUserId: string;
	port: number;
	logger?: Logger;
}

/** Slack Events API 経由の Ingress。Cloud Run 本番用途 (architecture.md §1)。
 * 署名検証 → url_verification / event_callback の分岐 → SlackIngressAdapter で正規化。 */
export class HttpIngress implements Ingress {
	private readonly app: Hono;
	private readonly adapter: SlackIngressAdapter;
	private readonly signingSecret: string;
	private readonly port: number;
	private readonly logger: Logger | undefined;
	private server: Server | undefined;

	constructor(opts: HttpIngressOptions) {
		this.signingSecret = opts.signingSecret;
		this.port = opts.port;
		this.logger = opts.logger;
		this.adapter = new SlackIngressAdapter(opts.botUserId);
		this.app = new Hono();
	}

	/** テスト用に app.request を直接叩けるよう公開する (実ポートを listen しなくてよい) */
	get honoApp(): Hono {
		return this.app;
	}

	async start(
		onEvent: (e: ChatEvent, ack: Ack) => Promise<void>,
	): Promise<void> {
		this.registerRoutes(onEvent);

		await new Promise<void>((resolve) => {
			this.server = createServer((req, res) => {
				void this.handleNodeRequest(req, res);
			});
			this.server.listen(this.port, () => resolve());
		});

		this.logger?.info({ port: this.port }, "listening for Slack events");
	}

	async stop(): Promise<void> {
		const server = this.server;
		if (server === undefined) return;
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
	}

	private registerRoutes(
		onEvent: (e: ChatEvent, ack: Ack) => Promise<void>,
	): void {
		// /healthz は GFE (Google Front End) の予約パスで Cloud Run のコンテナに
		// 届かないため /health を使う
		this.app.get("/health", (c) => c.text("ok"));

		this.app.post("/slack/events", async (c) => {
			const rawBody = await c.req.text();
			const timestamp = c.req.header("x-slack-request-timestamp");
			const signature = c.req.header("x-slack-signature");

			if (!this.verifySignature(rawBody, timestamp, signature)) {
				return c.text("invalid signature", 401);
			}

			const retryNum = c.req.header("x-slack-retry-num");
			if (retryNum !== undefined) {
				this.logger?.debug({ retryNum }, "slack retry delivery");
			}

			let payload: unknown;
			try {
				payload = JSON.parse(rawBody);
			} catch {
				return c.text("invalid json", 400);
			}
			if (typeof payload !== "object" || payload === null) {
				return c.text("invalid payload", 400);
			}
			const body = payload as Record<string, unknown>;

			if (body.type === "url_verification") {
				return c.text(String(body.challenge ?? ""), 200);
			}

			if (body.type !== "event_callback") {
				// 未知の envelope type。3 秒 ACK の責務だけ果たす (architecture.md §6)
				return c.text("ok", 200);
			}

			const rawEvent = body.event as Parameters<
				SlackIngressAdapter["normalize"]
			>[0];
			const eventId =
				typeof body.event_id === "string" ? body.event_id : undefined;
			const chatEvent = this.adapter.normalize(rawEvent, eventId);

			if (chatEvent === null) {
				// 対象外イベント。inbox に積む前段で弾いてよい (architecture.md §6 フロー 1-2)
				return c.text("ok", 200);
			}

			// ack() = 200 を返すこと。onEvent の残処理はレスポンス後も継続する
			// (always-allocated 前提。architecture.md §1)。deferred で ack 呼び出しを待つ。
			let resolveAck: () => void;
			const acked = new Promise<void>((resolve) => {
				resolveAck = resolve;
			});
			const ack: Ack = () => {
				resolveAck();
				return Promise.resolve();
			};

			const handled = onEvent(chatEvent, ack).catch((err) => {
				// ack せず throw したハンドラも 200 で返す (再送を防ぐ)。エラーはログに残す
				this.logger?.error({ err, eventId }, "onEvent failed");
			});

			// ack() 呼び出しとハンドラ完了のどちらか早い方でレスポンスを返す
			await Promise.race([acked, handled]);

			return c.text("ok", 200);
		});
	}

	/** raw body に対する HMAC-SHA256 署名検証 (Slack 公式仕様)。JSON parse 前に行う。 */
	private verifySignature(
		rawBody: string,
		timestamp: string | undefined,
		signature: string | undefined,
	): boolean {
		if (timestamp === undefined || signature === undefined) return false;

		const timestampSec = Number.parseInt(timestamp, 10);
		if (Number.isNaN(timestampSec)) return false;
		const nowSec = Date.now() / 1000;
		if (Math.abs(nowSec - timestampSec) > TIMESTAMP_TOLERANCE_SEC) return false;

		const baseString = `v0:${timestamp}:${rawBody}`;
		const expected = `v0=${hmacSha256Hex(this.signingSecret, baseString)}`;

		const expectedBuf = Buffer.from(expected, "utf8");
		const actualBuf = Buffer.from(signature, "utf8");
		if (expectedBuf.length !== actualBuf.length) return false;
		return timingSafeEqual(expectedBuf, actualBuf);
	}

	private async handleNodeRequest(
		req: import("node:http").IncomingMessage,
		res: import("node:http").ServerResponse,
	): Promise<void> {
		const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
		const chunks: Buffer[] = [];
		for await (const chunk of req) {
			chunks.push(chunk as Buffer);
		}
		const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

		const headers = new Headers();
		for (const [key, value] of Object.entries(req.headers)) {
			if (value === undefined) continue;
			if (Array.isArray(value)) {
				for (const v of value) headers.append(key, v);
			} else {
				headers.set(key, value);
			}
		}

		const request = new Request(url, {
			method: req.method ?? "GET",
			headers,
			...(body !== undefined ? { body } : {}),
		});

		const response = await this.app.fetch(request);

		res.statusCode = response.status;
		for (const [key, value] of response.headers) {
			res.setHeader(key, value);
		}
		const responseBody = response.body
			? Buffer.from(await response.arrayBuffer())
			: undefined;
		res.end(responseBody);
	}
}

function hmacSha256Hex(secret: string, data: string): string {
	return createHmac("sha256", secret).update(data).digest("hex");
}
