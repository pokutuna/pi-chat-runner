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
import { Firestore } from "@google-cloud/firestore";
import { WebClient } from "@slack/web-api";
import { startBridge } from "./bridge.js";
import type { EventSource } from "./ingress/event-source.js";
import { SocketEventSource } from "./ingress/event-source.js";
import { HttpEventSource } from "./ingress/http-event-source.js";
import { rootLogger } from "./logger.js";
import type { PiPermissionConfig } from "./session/runner.js";
import {
	collectPassthroughEnv,
	loadAgentConfig,
	resolveAgentConfig,
} from "./store/agent-config.js";
import { FileConfigSource } from "./store/config-source.js";
import { FirestoreStateStore } from "./store/firestore.js";
import type { StateStore } from "./store/interfaces.js";
import { InMemoryStateStore } from "./store/memory.js";
import { SqliteStateStore } from "./store/sqlite.js";

const logger = rootLogger.child({ component: "server" });

/** GCP 関連 env のうち process.env に存在するものだけを集める。pi の google-vertex
 * プロバイダが GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_LOCATION / GOOGLE_APPLICATION_CREDENTIALS
 * を env から読む (session-runtime.md §2 の allowlist に相当)。 */
function collectGcpEnv(): Record<string, string> {
	const keys = [
		"GOOGLE_CLOUD_PROJECT",
		"GOOGLE_CLOUD_LOCATION",
		"GOOGLE_APPLICATION_CREDENTIALS",
		// gcp-metadata の環境検出 (DMI ファイル read 等) は sandbox 下で当てにならない。
		// Cloud Run では assume-present を設定して検出をスキップし metadata server へ
		// 直行させる (gcp-metadata 8.x の METADATA_SERVER_DETECTION)
		"METADATA_SERVER_DETECTION",
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

/** env PI_AGENT_UID / PI_AGENT_GID (session-runtime.md §6: UID 分離) を数値として
 * パースする。どちらも省略時は無効 (現状動作 = pi は Runner と同一 uid で動く)。
 * 片方だけ設定されているのは誤設定なので fail-loud にする */
function parseAgentIds(): { uid?: number; gid?: number } {
	const uidRaw = process.env.PI_AGENT_UID;
	const gidRaw = process.env.PI_AGENT_GID;
	if (uidRaw === undefined && gidRaw === undefined) return {};
	if (uidRaw === undefined || gidRaw === undefined) {
		throw new Error(
			"PI_AGENT_UID and PI_AGENT_GID must be set together (or both omitted)",
		);
	}
	const uid = Number.parseInt(uidRaw, 10);
	const gid = Number.parseInt(gidRaw, 10);
	if (Number.isNaN(uid) || Number.isNaN(gid)) {
		throw new Error("PI_AGENT_UID and PI_AGENT_GID must be integers");
	}
	return { uid, gid };
}

/** env PI_PERMISSION_MODE=1 (session-runtime.md §6, pi-tools-and-sandbox.md
 * 「リーズナブルな sandbox レイヤ案」) で Node Permission Model 起動を opt-in する。
 * 未設定なら無効 (現状動作)。Cloud Run 実イメージでのみ有効化する想定 — ローカル開発・
 * テストの fake pi (test/fixtures/fake-pi.mjs) はこの機構を使わなくても動く。
 * entrypoint/nodeModulesDir は npm -g インストール先の実体パス (docker で
 * `readlink -f $(which pi)` / `npm root -g` を実測して決めた既定値。イメージの
 * レイアウトを変えた場合は env で上書きする) */
function parsePiPermissionConfig(): PiPermissionConfig | undefined {
	if (process.env.PI_PERMISSION_MODE !== "1") return undefined;
	// HOME を agentHome に固定するとローカルのユーザー ADC ($HOME/.config/gcloud) は
	// HOME 経由で見えなくなるため、GOOGLE_APPLICATION_CREDENTIALS で明示された
	// ファイルだけ read を許可する
	const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
	return {
		entrypoint:
			process.env.PI_ENTRYPOINT ??
			"/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
		nodeModulesDir:
			process.env.PI_NODE_MODULES_DIR ?? "/usr/local/lib/node_modules",
		appDir: process.env.PI_APP_DIR ?? "/app",
		...(credentialsPath !== undefined ? { extraRead: [credentialsPath] } : {}),
	};
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
			"  PI_AGENT_UID/GID    pi を落とす実行 uid/gid (session-runtime.md §6 の UID 分離。両方セットで有効)",
		);
		console.error(
			"  PI_AGENT_HOME       pi 子プロセスへ常に HOME として渡すディレクトリ (既定 /home/agent)",
		);
		console.error(
			"  PI_PERMISSION_MODE  1 で Node Permission Model 起動を有効化 (Cloud Run 実イメージ向け)",
		);
		console.error(
			"  TURN_TIMEOUT_MS     1 ターンの上限 ms (既定 600000 = 10 分。超過で pi を kill してセッションを畳む)",
		);
		console.error(
			"  PI_ENV_PASSTHROUGH  pi へ継承する env 名の追加 allowlist (カンマ区切り。SLACK_/BRIDGE_ prefix は拒否)",
		);
		console.error(
			"  上記 PI_MODEL/PI_PROVIDER/TURN_TIMEOUT_MS/PI_ENV_PASSTHROUGH は CONFIG_DIR/agent.yaml でも設定可 (env が優先)",
		);
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

	// agent.yaml (config.md §6) + env を解決する。優先順位は env > agent.yaml > コード既定
	const agentConfigFile = await loadAgentConfig(configDir);
	const agentConfig = resolveAgentConfig(agentConfigFile, process.env);
	const { model, provider, turnTimeoutMs } = agentConfig;
	const passthrough = collectPassthroughEnv(
		agentConfig.envPassthrough,
		process.env,
	);
	if (passthrough.missing.length > 0) {
		logger.warn(
			{ missing: passthrough.missing },
			"envPassthrough names not found in process.env",
		);
	}

	const gcpEnv = collectGcpEnv();
	// GCP env と envPassthrough が同じ名前を持つことは想定していない (allowlist の
	// 対象が重ならない) が、衝突したら GCP 側を後勝ちにする — pi の google-vertex
	// プロバイダの認証に必須の値をユーザー設定の envPassthrough で上書きさせない
	const extraEnv = { ...passthrough.env, ...gcpEnv };
	const store = buildStateStore();
	const archiveDir = process.env.WORKDIR_ARCHIVE_DIR;
	const agentIds = parseAgentIds();
	const piPermission = parsePiPermissionConfig();
	const agentHome = process.env.PI_AGENT_HOME;

	const web = new WebClient(botToken);
	const eventSource = buildEventSource(slackMode, botUserId);

	logger.info(
		{
			storeBackend: process.env.STORE_BACKEND ?? "memory",
			workdirArchiveDir: archiveDir,
			configDir,
			slackMode,
		},
		"state store configured",
	);

	await startBridge({
		eventSource,
		web,
		store,
		configSource: new FileConfigSource(configDir),
		...(model !== undefined ? { model } : {}),
		...(provider !== undefined ? { provider } : {}),
		...(Object.keys(extraEnv).length > 0 ? { extraEnv } : {}),
		// WORKDIR_ARCHIVE_DIR 未設定なら境界退避なし (Step 3 相当の挙動)
		...(archiveDir !== undefined && archiveDir !== "" ? { archiveDir } : {}),
		// PI_AGENT_UID/GID 未設定なら UID 分離なし (現状動作)
		...(agentIds.uid !== undefined ? { agentUid: agentIds.uid } : {}),
		...(agentIds.gid !== undefined ? { agentGid: agentIds.gid } : {}),
		// PI_AGENT_HOME 未設定なら SessionRunner の既定 (/home/agent) を使う
		...(agentHome !== undefined ? { agentHome } : {}),
		// PI_PERMISSION_MODE=1 未設定なら Node Permission Model なし (現状動作)
		...(piPermission !== undefined ? { piPermission } : {}),
		// TURN_TIMEOUT_MS 未設定なら SessionRunner の既定 (600_000ms) を使う
		...(turnTimeoutMs !== undefined ? { turnTimeoutMs } : {}),
		logger,
	});
}

main().catch((err) => {
	logger.error({ err }, "fatal error");
	process.exit(1);
});
