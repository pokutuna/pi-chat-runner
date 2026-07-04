// エントリポイント (Step 3: ローカル一気通貫)
//
// Socket Mode で受けたイベントをハードフィルタ (Layer 0) だけ通し、SessionRunner に渡す。
// gate 評価・inbox・pi の kick/steer はすべて SessionRunner の中 (src/session/runner.ts)。
// docs/build-plan.md Step 3 / docs/design/architecture.md §1, §6。

import { fileURLToPath } from "node:url";
import { WebClient } from "@slack/web-api";
import type { ChatEvent } from "./ingress/chat-event.js";
import type { Ack } from "./ingress/event-source.js";
import { SocketEventSource } from "./ingress/event-source.js";
import { rootLogger } from "./logger.js";
import { Reactions } from "./reply/reactions.js";
import { ReplyRouter } from "./reply/router.js";
import { InMemoryInbox } from "./session/inbox.js";
import { SessionRunner } from "./session/runner.js";
import { FileConfigSource } from "./store/config-source.js";

const logger = rootLogger.child({ component: "server" });

/** GCP 関連 env のうち process.env に存在するものだけを集める。pi の google-vertex
 * プロバイダが GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_LOCATION / GOOGLE_APPLICATION_CREDENTIALS
 * を env から読む (session-runtime.md §2 の allowlist に相当)。 */
function collectGcpEnv(): Record<string, string> {
	const keys = [
		"GOOGLE_CLOUD_PROJECT",
		"GOOGLE_CLOUD_LOCATION",
		"GOOGLE_APPLICATION_CREDENTIALS",
	];
	const env: Record<string, string> = {};
	for (const key of keys) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	return env;
}

function requireEnv(name: string): string {
	const value = process.env[name];
	if (value === undefined || value === "") {
		console.error(`Missing required environment variable: ${name}`);
		console.error("");
		console.error("起動には以下の環境変数が必要です:");
		console.error(
			"  SLACK_BOT_TOKEN     xoxb-... (OAuth & Permissions で取得)",
		);
		console.error(
			"  SLACK_APP_TOKEN     xapp-... (Basic Information > App-Level Tokens, connections:write scope)",
		);
		console.error(
			"  SLACK_BOT_USER_ID   U...     (bot の User ID。App Home や `auth.test` で確認可能)",
		);
		console.error("");
		console.error("任意:");
		console.error(
			"  CONFIG_DIR          channels/*.yaml の親 (既定 examples/config)",
		);
		console.error("  PI_MODEL            ChannelDoc.model 未指定時のモデル");
		console.error("  PI_PROVIDER         pi の --provider");
		console.error("");
		console.error("例 (.env ファイル推奨):");
		console.error("  cp .env.example .env  # 値を埋める");
		console.error(
			"  pnpm run dev          # --env-file-if-exists=.env で読み込まれる",
		);
		process.exit(1);
	}
	return value;
}

async function main() {
	const botToken = requireEnv("SLACK_BOT_TOKEN");
	const appToken = requireEnv("SLACK_APP_TOKEN");
	const botUserId = requireEnv("SLACK_BOT_USER_ID");
	const configDir = process.env.CONFIG_DIR ?? "examples/config";
	const model = process.env.PI_MODEL;
	const provider = process.env.PI_PROVIDER;
	const extraEnv = collectGcpEnv();

	const web = new WebClient(botToken);
	const eventSource = new SocketEventSource({ appToken, botUserId });

	const runner = new SessionRunner({
		configSource: new FileConfigSource(configDir),
		inbox: new InMemoryInbox(),
		router: new ReplyRouter({
			poster: {
				async postMessage(channelId, threadTs, text) {
					await web.chat.postMessage({
						channel: channelId,
						thread_ts: threadTs,
						text,
					});
				},
			},
		}),
		reactions: new Reactions({
			add: (args) => web.reactions.add(args),
		}),
		// tsx 実行時は <repo>/src/../extensions、build 後は <repo>/dist/../extensions を指す。
		// pi が --extension で TS ソースを直接ロードするためビルド対象外 (build-plan.md)
		extensionPath: fileURLToPath(
			new URL("../extensions/reply.ts", import.meta.url),
		),
		...(model !== undefined ? { model } : {}),
		...(provider !== undefined ? { provider } : {}),
		...(Object.keys(extraEnv).length > 0 ? { extraEnv } : {}),
	});

	// Layer 0 (ハードフィルタ): 同一メッセージは app_mention と message の 2 イベントで
	// 届く (event_id は別) ため、メッセージ ts で重複排除する。inbox の dedupe は
	// event_id ベースなので、この二重配信はここでしか防げない
	const seenMessages = new Set<string>();

	await eventSource.start(async (event: ChatEvent, ack: Ack) => {
		// Socket Mode なので積む前に即 ack してよい (architecture.md §1 の 3 秒 ACK)
		await ack();

		logger.debug(
			{
				kind: event.kind,
				eventId: "id" in event ? event.id : undefined,
				channelId: event.conversation?.channelId,
				userId: "sender" in event ? event.sender.id : undefined,
			},
			"event received",
		);

		if (event.kind !== "message") {
			logger.info(
				{ reason: "unsupported_kind", kind: event.kind },
				"event ignored",
			);
			return;
		}

		const messageKey = `${event.conversation.channelId}:${event.id}`;
		if (seenMessages.has(messageKey)) {
			logger.info(
				{ reason: "duplicate_delivery", eventId: event.id },
				"event ignored",
			);
			return;
		}
		seenMessages.add(messageKey);
		if (seenMessages.size > 1000) {
			seenMessages.clear();
		}

		if (event.sender.isBot) {
			logger.info(
				{ reason: "bot_message", eventId: event.id },
				"event ignored",
			);
			return;
		}

		try {
			await runner.handle(event);
		} catch (err) {
			logger.error({ eventId: event.id, err }, "failed to handle event");
		}
	});

	logger.info({ configDir }, "Socket Mode connected; waiting for events");
}

main().catch((err) => {
	logger.error({ err }, "fatal error");
	process.exit(1);
});
