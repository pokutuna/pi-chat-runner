// エントリポイント (Step 5: Cloud Run デプロイ / Events API)
//
// Ingress (Socket Mode / Events API) で受けたイベントをハードフィルタ (Layer 0)
// だけ通し、SessionRunner に渡す。入口の選択は connector.slack.mode (agent.yaml /
// SLACK_MODE env) で行い、後段 (gate 評価・inbox・lease・pi の kick/steer。すべて
// SessionRunner の中, src/session/runner.ts) には入口の別を漏らさない
// (architecture.md §1)。Store の実装選択 (store.backend, agent.yaml) も同様にここで行う
// (persistence.md §1)。docs/build-plan.md Step 4-5 / docs/design/architecture.md §1, §6。

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Firestore } from "@google-cloud/firestore";
import { WebClient } from "@slack/web-api";
import { startBridge } from "./bridge.js";
import {
	loadAgentConfig,
	type ResolvedAgentRuntime,
	resolveAgentConfig,
} from "./config/agent-config.js";
import { FileConfigSource, loadChannelsFile } from "./config/config-source.js";
import {
	loadConnectorConfig,
	type SlackConnectorConfig,
} from "./config/connector-config.js";
import { formatEffectiveConfig } from "./config/dump.js";
import {
	loadStoreConfig,
	type ResolvedStoreConfig,
} from "./config/store-config.js";
import type { Ingress } from "./ingress/ingress.js";
import { HttpIngress } from "./ingress/slack/http-ingress.js";
import { SocketIngress } from "./ingress/slack/socket-ingress.js";
import { rootLogger } from "./logger.js";
import type { PiPermissionConfig } from "./session/runner.js";
import { FirestoreStateStore } from "./store/state/backends/firestore.js";
import { InMemoryStateStore } from "./store/state/backends/memory.js";
import { SqliteStateStore } from "./store/state/backends/sqlite.js";
import type { StateStore } from "./store/state/interfaces.js";

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

/** store.backend (agent.yaml, 既定 memory) で永続化バックエンドを選ぶ (persistence.md §1)。
 * SessionRunner 以下には実装の別を漏らさない。 */
function buildStateStore(store: ResolvedStoreConfig): StateStore {
	switch (store.backend) {
		case "memory":
			return new InMemoryStateStore();
		case "sqlite": {
			mkdirSync(dirname(store.sqlitePath), { recursive: true });
			return new SqliteStateStore(store.sqlitePath);
		}
		case "firestore":
			// projectId は GOOGLE_CLOUD_PROJECT / エミュレータは FIRESTORE_EMULATOR_HOST
			// を SDK が自動で読む (persistence.md §1)
			return new FirestoreStateStore(new Firestore());
		default:
			throw new Error(
				`Unknown store.backend "${store.backend}" (expected memory|sqlite|firestore)`,
			);
	}
}

/** pi 本体パッケージを import.meta.resolve で解決し、Node Permission Model 用の
 * entrypoint (bin.pi の絶対パス) と nodeModulesDir (パッケージがインストールされて
 * いる node_modules ルート) を自動検出する。決め打ちパス (旧 PI_ENTRYPOINT/
 * PI_NODE_MODULES_DIR env) を廃止し、実際にインストールされた場所から常に正しい
 * 値を導く。
 *
 * require.resolve(`${pkg}/package.json`) ではなく import.meta.resolve(pkg) (パッケージ
 * ルート "." の解決) を使う: pi 本体は ESM 専用で package.json の exports に "."
 * (→ dist/index.js) しか定義しておらず "./package.json" は公開していないため、
 * require.resolve 経由のサブパス解決は ERR_PACKAGE_PATH_NOT_EXPORTED で必ず失敗する
 * (exports map が定義された ESM パッケージは CJS の require.resolve では解決不能)。
 * import.meta.resolve は ESM の解決アルゴリズムを使うため "." の import 条件を
 * 正しく解決できる。dist/index.js から dist/cli.js (bin.pi) 及び node_modules
 * ルートを相対で導出する。パッケージ構成は `<nodeModulesDir>/@earendil-works/
 * pi-coding-agent/dist/{index.js,cli.js}` 前提。 */
const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

function resolvePiPaths(): { entrypoint: string; nodeModulesDir: string } {
	const indexUrl = import.meta.resolve(PI_PACKAGE_NAME);
	const indexPath = fileURLToPath(indexUrl);
	// indexPath = <nodeModulesDir>/@earendil-works/pi-coding-agent/dist/index.js
	const packageDir = dirname(dirname(indexPath));
	const entrypoint = join(packageDir, "dist/cli.js");
	// <nodeModulesDir>/@earendil-works/pi-coding-agent → 2 段上が node_modules ルート
	const nodeModulesDir = dirname(dirname(packageDir));
	return { entrypoint, nodeModulesDir };
}

/** agent.yaml の agent.runtime.permissionMode (既定 true, agent-config.ts) で Node
 * Permission Model 起動を切り替える (session-runtime.md §6, pi-tools-and-sandbox.md
 * 「リーズナブルな sandbox レイヤ案」)。コード既定は ON — 何も書かなければ隔離が効く。
 * false のときだけ無効化する (ローカル開発・テストの fake pi (test/fixtures/fake-pi.mjs)
 * はこの機構を使わなくても動く)。entrypoint/nodeModulesDir は resolvePiPaths の
 * 自動検出値を使う。 */
function buildPiPermissionConfig(
	runtime: ResolvedAgentRuntime,
): PiPermissionConfig | undefined {
	if (!runtime.permissionMode) return undefined;
	// HOME を agentHome に固定するとローカルのユーザー ADC ($HOME/.config/gcloud) は
	// HOME 経由で見えなくなるため、GOOGLE_APPLICATION_CREDENTIALS で明示された
	// ファイルだけ read を許可する
	const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
	return {
		...resolvePiPaths(),
		...(credentialsPath !== undefined ? { extraRead: [credentialsPath] } : {}),
	};
}

function missingConnectorConfig(configDir: string): never {
	console.error("Missing or incomplete connector.slack config");
	console.error("");
	console.error(
		`起動には ${configDir}/agent.yaml の connector.slack ブロックが必要です:`,
	);
	console.error("");
	console.error("connector:");
	console.error("  slack:");
	console.error(
		"    mode: ${env.SLACK_MODE:-socket}         # socket | events (既定 socket。architecture.md §1)",
	);
	console.error(
		"    appToken: ${env.SLACK_APP_TOKEN}        # socket 時必須 (xapp-...)",
	);
	console.error(
		"    signingSecret: ${env.SLACK_SIGNING_SECRET}  # events 時必須",
	);
	console.error(
		"    port: ${env.PORT:-8080}                 # events 時の listen ポート",
	);
	console.error(
		"    botToken: ${env.SLACK_BOT_TOKEN}        # 必須 (xoxb-...)",
	);
	console.error("    botUserId: ${env.SLACK_BOT_USER_ID}     # 必須 (U...)");
	console.error("");
	console.error("任意 (agent.yaml でも設定可。詳細は config.md §6):");
	console.error("  PI_PROVIDER         pi の --provider");
	console.error(
		"  PI_AGENT_UID/GID    pi を落とす実行 uid/gid (session-runtime.md §6 の UID 分離。両方セットで有効。agent.yaml の agent.runtime.uid/gid でも指定可)",
	);
	console.error(
		"  PI_AGENT_HOME       pi 子プロセスへ常に HOME として渡すディレクトリ (既定 /home/agent。agent.yaml の agent.runtime.home でも指定可)",
	);
	console.error(
		"  PI_PERMISSION_MODE  0 で Node Permission Model 起動を無効化 (既定 ON。agent.yaml の agent.runtime.permissionMode: false でも無効化可)",
	);
	console.error(
		"  TURN_TIMEOUT_MS     1 ターンの上限 ms (既定 600000 = 10 分。超過で pi を kill してセッションを畳む)",
	);
	console.error(
		"  上記 PI_PROVIDER/TURN_TIMEOUT_MS は CONFIG_DIR/agent.yaml でも設定可 (env が優先)。pi へ渡す追加 env は agent.yaml の agent.env で明示列挙する",
	);
	console.error("");
	console.error("例 (.env ファイル推奨):");
	console.error("  cp .env.example .env  # 値を埋める");
	console.error(
		"  pnpm run dev          # --env-file-if-exists=.env で読み込まれる",
	);
	process.exit(1);
}

/** connector.slack.mode (既定 socket) で入口を切り替える (architecture.md §1)。両モードとも
 * dedupe・起動判定・inbox 積みの後段は共通で、「受け取り方 / ACK の意味」だけが違う。
 * モード別必須項目 (appToken / signingSecret) もここで振り分ける。connector.slack 自体が
 * 無い、またはモード別必須項目が欠けている場合は fail-loud で使い方を表示して exit する。 */
function buildConnector(
	slack: SlackConnectorConfig | undefined,
	configDir: string,
): { ingress: Ingress; botToken: string } {
	if (slack === undefined) {
		missingConnectorConfig(configDir);
	}
	const { mode, botToken, botUserId, port } = slack;
	switch (mode) {
		case "socket": {
			if (slack.appToken === undefined || slack.appToken === "") {
				missingConnectorConfig(configDir);
			}
			const ingress = new SocketIngress({
				appToken: slack.appToken,
				botUserId,
			});
			return { ingress, botToken };
		}
		case "events": {
			if (slack.signingSecret === undefined || slack.signingSecret === "") {
				missingConnectorConfig(configDir);
			}
			const ingress = new HttpIngress({
				signingSecret: slack.signingSecret,
				botUserId,
				port,
				logger: rootLogger.child({ component: "http" }),
			});
			return { ingress, botToken };
		}
		default:
			throw new Error(
				`Unknown connector.slack.mode "${mode}" (expected socket|events)`,
			);
	}
}

/** `dump <channel> [--json]` (config.md §6): bot を起動せず、あるチャンネルの
 * merge 済み実効設定を provenance 付きで表示して exit(0) する。resolveChannelConfig
 * (ランタイムと共有) をそのまま呼ぶ formatEffectiveConfig に委譲するだけで、
 * dump 専用の設定解決ロジックは持たない。例外時は stderr に出して exit(1)。 */
async function runDump(argv: string[]): Promise<void> {
	const channelId = argv[3];
	if (channelId === undefined) {
		console.error("Usage: node dist/server.mjs dump <channel> [--json]");
		process.exit(1);
	}
	const json = argv.includes("--json");
	const configDir = process.env.CONFIG_DIR ?? "examples/config";

	try {
		const file = await loadChannelsFile(join(configDir, "channels.yaml"));
		console.log(formatEffectiveConfig(file, channelId, { json }));
		process.exit(0);
	} catch (err) {
		console.error(err instanceof Error ? err.message : err);
		process.exit(1);
	}
}

async function main() {
	if (process.argv[2] === "dump") {
		await runDump(process.argv);
		return;
	}

	const configDir = process.env.CONFIG_DIR ?? "examples/config";

	// connector.slack (agent.yaml 内, ${env.X} 参照解決済み) を読む。SLACK_MODE 等の
	// env 直読みはやめ、connector 経由に一本化する (connector-config.ts)
	const connectorConfig = await loadConnectorConfig(configDir);
	const { ingress, botToken } = buildConnector(
		connectorConfig.slack,
		configDir,
	);

	// store.backend/sqlitePath (agent.yaml 内, ${env.X} 参照解決済み) を読む。
	// STORE_BACKEND/SQLITE_PATH env 直読みはやめ、store 経由に一本化する (store-config.ts)
	const storeConfig = await loadStoreConfig(configDir);

	// agent.yaml (config.md §6) + env を解決する。優先順位は env > agent.yaml > コード既定
	const agentConfigFile = await loadAgentConfig(configDir);
	const agentConfig = resolveAgentConfig(agentConfigFile, process.env);
	const { provider, turnTimeoutMs, runtime } = agentConfig;

	const gcpEnv = collectGcpEnv();
	// 足し算モデル (config.md §6): pi に渡る env は「コード既定 (gcpEnv) + agent.env に
	// 明示列挙したものだけ」。agent.env はレイヤ③ (ユーザー明示) としてレイヤ②
	// (gcpEnv, コード既定) を上書きできる — pi の実行に必須な GOOGLE_CLOUD_PROJECT 等を
	// 利用者が意図して差し替えるケースを許すため、後勝ちで agent.env を上に重ねる
	const extraEnv = { ...gcpEnv, ...agentConfig.env };
	const store = buildStateStore(storeConfig);
	const archiveDir = process.env.WORKDIR_ARCHIVE_DIR;
	const piPermission = buildPiPermissionConfig(runtime);

	const web = new WebClient(botToken);

	logger.info(
		{
			storeBackend: storeConfig.backend,
			workdirArchiveDir: archiveDir,
			configDir,
			slackMode: connectorConfig.slack?.mode,
		},
		"state store configured",
	);

	await startBridge({
		eventSource: ingress,
		web,
		store,
		configSource: new FileConfigSource(configDir),
		...(provider !== undefined ? { provider } : {}),
		...(Object.keys(extraEnv).length > 0 ? { extraEnv } : {}),
		// WORKDIR_ARCHIVE_DIR 未設定なら境界退避なし (Step 3 相当の挙動)
		...(archiveDir !== undefined && archiveDir !== "" ? { archiveDir } : {}),
		// agent.runtime.uid/gid (env PI_AGENT_UID/GID) 未設定なら UID 分離なし (現状動作)
		...(runtime.uid !== undefined ? { agentUid: runtime.uid } : {}),
		...(runtime.gid !== undefined ? { agentGid: runtime.gid } : {}),
		// home は resolveAgentConfig が既定 "/home/agent" を埋めて返すので常に渡す
		agentHome: runtime.home,
		// permissionMode: false (env PI_PERMISSION_MODE=0 または agent.yaml) なら
		// Node Permission Model なし。コード既定は ON
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
