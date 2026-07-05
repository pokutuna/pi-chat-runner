// エントリポイント (Step 5: Cloud Run デプロイ / Events API)
//
// EventSource (Socket Mode / Events API) で受けたイベントをハードフィルタ (Layer 0)
// だけ通し、SessionRunner に渡す。入口の選択は SLACK_MODE (env) で行い、後段
// (gate 評価・inbox・lease・pi の kick/steer。すべて SessionRunner の中,
// src/session/runner.ts) には入口の別を漏らさない (architecture.md §1)。
// Store/Storage の実装選択 (env) も同様にここで行う (persistence.md §1)。
// docs/build-plan.md Step 4-5 / docs/design/architecture.md §1, §6。

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Firestore } from "@google-cloud/firestore";
import { WebClient } from "@slack/web-api";
import type { ChatEvent } from "./ingress/chat-event.js";
import type { Ack, EventSource } from "./ingress/event-source.js";
import { SocketEventSource } from "./ingress/event-source.js";
import { HttpEventSource } from "./ingress/http-event-source.js";
import { rootLogger } from "./logger.js";
import { Reactions } from "./reply/reactions.js";
import { ReplyRouter } from "./reply/router.js";
import { SessionRunner } from "./session/runner.js";
import { FileConfigSource } from "./store/config-source.js";
import { FirestoreStateStore } from "./store/firestore.js";
import type { StateStore } from "./store/interfaces.js";
import { InMemoryStateStore } from "./store/memory.js";
import { SqliteStateStore } from "./store/sqlite.js";
import { CopyWorkdirStorage } from "./store/workdir-storage.js";

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

/** env STORE_BACKEND (既定 memory) で永続化バックエンドを選ぶ (persistence.md §1)。
 * SessionRunner 以下には実装の別を漏らさない。 */
function buildStateStore(): StateStore {
	const backend = process.env.STORE_BACKEND ?? "memory";
	switch (backend) {
		case "memory":
			return new InMemoryStateStore();
		case "sqlite": {
			const path = process.env.SQLITE_PATH ?? "/tmp/pi-chat-runner/state.db";
			mkdirSync(dirname(path), { recursive: true });
			return new SqliteStateStore(path);
		}
		case "firestore":
			// projectId は GOOGLE_CLOUD_PROJECT / エミュレータは FIRESTORE_EMULATOR_HOST
			// を SDK が自動で読む (persistence.md §1)
			return new FirestoreStateStore(new Firestore());
		default:
			throw new Error(
				`Unknown STORE_BACKEND "${backend}" (expected memory|sqlite|firestore)`,
			);
	}
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
			"  SLACK_BOT_USER_ID   U...     (bot の User ID。App Home や `auth.test` で確認可能)",
		);
		console.error(
			"  SLACK_MODE          socket|events (既定 socket。architecture.md §1)",
		);
		console.error(
			"    socket 時 -> SLACK_APP_TOKEN      xapp-... (Basic Information > App-Level Tokens, connections:write scope)",
		);
		console.error(
			"    events 時 -> SLACK_SIGNING_SECRET Basic Information > Signing Secret",
		);
		console.error("");
		console.error("任意:");
		console.error(
			"  CONFIG_DIR          channels/*.yaml の親 (既定 examples/config)",
		);
		console.error("  PI_MODEL            ChannelDoc.model 未指定時のモデル");
		console.error("  PI_PROVIDER         pi の --provider");
		console.error(
			"  PORT                events モードの listen ポート (既定 8080)",
		);
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

/** SLACK_MODE (既定 socket) で入口を切り替える (architecture.md §1)。両モードとも
 * dedupe・起動判定・inbox 積みの後段は共通で、「受け取り方 / ACK の意味」だけが違う。
 * モード別必須 env (SLACK_APP_TOKEN / SLACK_SIGNING_SECRET) もここで振り分ける。 */
function buildEventSource(mode: string, botUserId: string): EventSource {
	switch (mode) {
		case "socket": {
			const appToken = requireEnv("SLACK_APP_TOKEN");
			return new SocketEventSource({ appToken, botUserId });
		}
		case "events": {
			const signingSecret = requireEnv("SLACK_SIGNING_SECRET");
			const port = Number.parseInt(process.env.PORT ?? "8080", 10);
			return new HttpEventSource({
				signingSecret,
				botUserId,
				port,
				logger: rootLogger.child({ component: "http" }),
			});
		}
		default:
			throw new Error(`Unknown SLACK_MODE "${mode}" (expected socket|events)`);
	}
}

async function main() {
	const slackMode = process.env.SLACK_MODE ?? "socket";
	const botToken = requireEnv("SLACK_BOT_TOKEN");
	const botUserId = requireEnv("SLACK_BOT_USER_ID");
	const configDir = process.env.CONFIG_DIR ?? "examples/config";
	const model = process.env.PI_MODEL;
	const provider = process.env.PI_PROVIDER;
	const extraEnv = collectGcpEnv();
	const store = buildStateStore();
	const archiveDir = process.env.WORKDIR_ARCHIVE_DIR;

	const web = new WebClient(botToken);
	const eventSource = buildEventSource(slackMode, botUserId);

	const runner = new SessionRunner({
		configSource: new FileConfigSource(configDir),
		store,
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
		// WORKDIR_ARCHIVE_DIR 未設定なら境界退避なし (Step 3 相当の挙動)
		...(archiveDir !== undefined && archiveDir !== ""
			? { workdirStorage: new CopyWorkdirStorage(archiveDir) }
			: {}),
	});
	logger.info(
		{
			storeBackend: process.env.STORE_BACKEND ?? "memory",
			workdirArchiveDir: archiveDir,
		},
		"state store configured",
	);

	// Layer 0 (ハードフィルタ): 同一メッセージは app_mention と message の 2 イベントで
	// 届く (event_id は別) ため、メッセージ ts で重複排除する。inbox の dedupe は
	// event_id ベースなので、この二重配信はここでしか防げない
	const seenMessages = new Set<string>();

	await eventSource.start(async (event: ChatEvent, ack: Ack) => {
		// 3 秒 ACK の意味は入口で違う (Socket Mode = ack コールバック, Events API = 200
		// レスポンス) が、Ack で吸収されているのでここでは「積む前に ack する」だけ書けばよい
		// (architecture.md §1)。以降の残処理は ack 後も継続する
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

	logger.info(
		{ configDir, slackMode },
		"event source started; waiting for events",
	);
}

main().catch((err) => {
	logger.error({ err }, "fatal error");
	process.exit(1);
});
