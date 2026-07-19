// エントリポイント (Cloud Run デプロイ / Events API)
//
// Ingress (Socket Mode / Events API) で受けたイベントをハードフィルタ (Layer 0)
// だけ通し、SessionRunner に渡す。入口の選択は connector.slack.mode (agent.yaml /
// SLACK_MODE env) で行い、後段 (gate 評価・inbox・lease・pi の kick/steer。すべて
// SessionRunner の中, src/session/runner.ts) には入口の別を漏らさない
// (architecture.md §1)。Store の実装選択 (store.backend, agent.yaml) も同様にここで行う
// (persistence.md §1 / docs/design/architecture.md §1, §6)。

import { mkdirSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { Firestore } from "@google-cloud/firestore";
import { WebClient } from "@slack/web-api";
import pino from "pino";

import type { BridgeOptions } from "./bridge.js";
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
import { createLocalChat } from "./ingress/local/local-chat.js";
import { startRepl } from "./ingress/local/repl.js";
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
      mkdirSync(dirname(store.sqlite.path), { recursive: true });
      return new SqliteStateStore(store.sqlite.path);
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
 * entrypoint (bin.pi の絶対パス) と nodeModulesDir (pi の全依存を含む node_modules
 * ルート) を自動検出する。決め打ちパス (旧 PI_ENTRYPOINT/PI_NODE_MODULES_DIR env)
 * を廃止し、実際にインストールされた場所から常に正しい値を導く。
 *
 * require.resolve(`${pkg}/package.json`) ではなく import.meta.resolve(pkg) (パッケージ
 * ルート "." の解決) を使う: pi 本体は ESM 専用で package.json の exports に "."
 * (→ dist/index.js) しか定義しておらず "./package.json" は公開していないため、
 * require.resolve 経由のサブパス解決は ERR_PACKAGE_PATH_NOT_EXPORTED で必ず失敗する
 * (exports map が定義された ESM パッケージは CJS の require.resolve では解決不能)。
 * import.meta.resolve は ESM の解決アルゴリズムを使うため "." の import 条件を
 * 正しく解決できる。dist/index.js から dist/cli.js (bin.pi) を相対で導く。
 *
 * nodeModulesDir は allow-fs-read に `${nodeModulesDir}/*` として渡り、pi が起動時に
 * 読む全ファイル (自身のコード + 実行時依存) をこの 1 パスでカバーする必要がある。
 * ここで求めるのは pi の依存を実際に張っている **平坦な node_modules ルート**
 * (= install 先の最外殻の node_modules) であって、pi パッケージの直上ディレクトリ
 * ではない。両者は npm の平坦構成では一致するが pnpm では食い違う: import.meta.resolve
 * は symlink を実体化するため indexPath が
 * `<root>/.pnpm/@earendil-works+pi-coding-agent@x/node_modules/@earendil-works/
 * pi-coding-agent/dist/index.js` を指し、pi の直上 node_modules は pi 専用の仮想
 * ストア (兄弟の cross-spawn 等を含まない) になる。そこを許可しても pi が spawn 時に
 * 読む cross-spawn が ERR_ACCESS_DENIED で pi が即死する。pnpm は全依存を `<root>/.pnpm`
 * 配下に置き `<root>` 直下に top-level symlink を張るので、パス上で最も外側に現れる
 * `node_modules` セグメントを採れば npm(平坦)/pnpm どちらでも「全依存を含むルート」に
 * 一致する (個別パスを列挙し続けないための正規化)。 */
const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

function resolvePiPaths(): { entrypoint: string; nodeModulesDir: string } {
  const indexUrl = import.meta.resolve(PI_PACKAGE_NAME);
  const indexPath = fileURLToPath(indexUrl);
  // indexPath = <...>/@earendil-works/pi-coding-agent/dist/index.js
  const packageDir = dirname(dirname(indexPath));
  const entrypoint = join(packageDir, "dist/cli.js");
  return { entrypoint, nodeModulesDir: outermostNodeModules(indexPath) };
}

/** path 上で最も外側 (ルート寄り) に現れる `node_modules` セグメントまでのパスを返す。
 * pnpm の仮想ストア (`<root>/.pnpm/<pkg>/node_modules/...`) では複数の node_modules が
 * ネストするが、全依存を張るのは最外殻の `<root>` なのでそれを選ぶ。`node_modules` が
 * 無ければ入力の dirname を返す (想定外の配置でのフォールバック)。 */
function outermostNodeModules(path: string): string {
  const marker = `${sep}node_modules${sep}`;
  const idx = path.indexOf(marker);
  if (idx === -1) return dirname(path);
  return path.slice(0, idx + marker.length - 1);
}

/** agent.yaml の agent.runtime.permissionMode (既定 true, agent-config.ts) で Node
 * Permission Model 起動を切り替える (session-runtime.md §6, pi-tools-and-sandbox.md
 * 「リーズナブルな sandbox レイヤ案」)。コード既定は ON — 何も書かなければ隔離が効く。
 * false のときだけ無効化する (ローカル開発・テストの fake pi (test/fixtures/fake-pi.mjs)
 * はこの機構を使わなくても動く)。entrypoint/nodeModulesDir は resolvePiPaths の
 * 自動検出値を使う。 */
function buildPiPermissionConfig(
  runtime: ResolvedAgentRuntime,
  piPaths: { entrypoint: string; nodeModulesDir: string },
): PiPermissionConfig | undefined {
  if (!runtime.permissionMode) return undefined;
  // HOME を agentHome に固定するとローカルのユーザー ADC ($HOME/.config/gcloud) は
  // HOME 経由で見えなくなるため、GOOGLE_APPLICATION_CREDENTIALS で明示された
  // ファイルだけ read を許可する
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  return {
    ...piPaths,
    ...(credentialsPath !== undefined ? { extraRead: [credentialsPath] } : {}),
    ...(runtime.allowAddons ? { allowAddons: true } : {}),
  };
}

function missingConnectorConfig(configPath: string): never {
  console.error("Missing or incomplete connector.slack config");
  console.error("");
  console.error(`${configPath} needs a connector.slack block to start:`);
  console.error("");
  console.error("connector:");
  console.error("  slack:");
  console.error(
    "    mode: ${env.SLACK_MODE:-socket}         # socket | events (default socket; architecture.md §1)",
  );
  console.error(
    "    botToken: ${env.SLACK_BOT_TOKEN}        # required (xoxb-...)",
  );
  console.error(
    "    botUserId: ${env.SLACK_BOT_USER_ID}     # required (U...)",
  );
  console.error("    socket:");
  console.error(
    "      appToken: ${env.SLACK_APP_TOKEN}      # required in socket mode (xapp-...)",
  );
  console.error("    events:");
  console.error(
    "      signingSecret: ${env.SLACK_SIGNING_SECRET}  # required in events mode",
  );
  console.error(
    "      port: ${env.PORT:-8080}               # listen port in events mode",
  );
  console.error("");
  console.error("Optional (can also be set in agent.yaml; see config.md §6):");
  console.error(
    "  PI_AGENT_UID/GID    uid/gid pi runs as (UID separation, session-runtime.md §6; both must be set. Also settable via agent.runtime.uid/gid in agent.yaml)",
  );
  console.error(
    "  PI_AGENT_HOME       directory always passed as HOME to the pi child process (default /home/agent. Also settable via agent.runtime.home in agent.yaml)",
  );
  console.error(
    "  PI_PERMISSION_MODE  set to 0 to disable the Node Permission Model (default ON. Also settable via agent.runtime.permissionMode: false in agent.yaml)",
  );
  console.error(
    "  TURN_TIMEOUT_MS     per-turn limit in ms (default 600000 = 10 min; pi is killed and the session ends if exceeded)",
  );
  console.error(
    "  PROGRESS_NOTICE_INTERVAL_MS  interval in ms between progress notices on long turns (default 30000; 0 disables)",
  );
  console.error(
    "  TURN_TIMEOUT_MS/PROGRESS_NOTICE_INTERVAL_MS above can also be set in the config file's (CONFIG_PATH) agent block (env takes precedence). Extra env passed to pi is listed explicitly in agent.env",
  );
  console.error("");
  console.error("Example (.env file recommended):");
  console.error("  cp .env.example .env  # fill in the values");
  console.error(
    "  pnpm run dev          # loaded via --env-file-if-exists=.env",
  );
  process.exit(1);
}

/** connector.slack.mode (既定 socket) で入口を切り替える (architecture.md §1)。両モードとも
 * dedupe・起動判定・inbox 積みの後段は共通で、「受け取り方 / ACK の意味」だけが違う。
 * モード別必須項目 (appToken / signingSecret) もここで振り分ける。connector.slack 自体が
 * 無い、またはモード別必須項目が欠けている場合は fail-loud で使い方を表示して exit する。 */
function buildConnector(
  slack: SlackConnectorConfig | undefined,
  configPath: string,
): { ingress: Ingress; botToken: string } {
  if (slack === undefined) {
    missingConnectorConfig(configPath);
  }
  const { mode, botToken, botUserId } = slack;
  switch (mode) {
    case "socket": {
      if (slack.socket.appToken === undefined || slack.socket.appToken === "") {
        missingConnectorConfig(configPath);
      }
      const ingress = new SocketIngress({
        appToken: slack.socket.appToken,
        botUserId,
        web: new WebClient(botToken),
        logger: rootLogger.child({ component: "socket" }),
      });
      return { ingress, botToken };
    }
    case "events": {
      if (
        slack.events.signingSecret === undefined ||
        slack.events.signingSecret === ""
      ) {
        missingConnectorConfig(configPath);
      }
      const ingress = new HttpIngress({
        signingSecret: slack.events.signingSecret,
        botUserId,
        port: slack.events.port,
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
 * dump 専用の設定解決ロジックは持たない。channels ブロックしか読まないため
 * connector 等の secrets は解決されない (config.md §6)。例外時は stderr に出して
 * exit(1)。 */
async function runDump(argv: string[]): Promise<void> {
  const channelId = argv[3];
  if (channelId === undefined) {
    console.error("Usage: node dist/server.mjs dump <channel> [--json]");
    process.exit(1);
  }
  const json = argv.includes("--json");
  const configPath = process.env.CONFIG_PATH ?? DEFAULT_CONFIG_PATH;

  try {
    const file = await loadChannelsFile(configPath);
    console.log(formatEffectiveConfig(file, channelId, { json }));
    process.exit(0);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

/** 設定ファイル (単一 YAML) の既定パス。イメージには examples/config を同梱する
 * (Dockerfile) ため、CONFIG_PATH 未設定でもサンプル設定で起動できる。 */
const DEFAULT_CONFIG_PATH = "examples/config/agent.yaml";

/** `local` サブコマンドの既定チャンネル ID (docs/design/local-dev.md §1)。 */
const DEFAULT_LOCAL_CHANNEL_ID = "local";

/** main() / runLocal() 共通の組み立て (store.backend, agent ブロック, pi パス解決,
 * extraEnv, WORKDIR_ARCHIVE_DIR/SHARED_DIR, piPermission 等)。connector ブロックの
 * 読み込みと web (WebClient) の構築だけは呼び出し元ごとに異なるため、ここには含めない
 * (local mode は connector を読まない。docs/design/local-dev.md §1)。
 *
 * 返す options は startBridge に渡す BridgeOptions のうち eventSource/web/configSource
 * を除いた共通部分 (呼び出し元がそれぞれの入口を追加してから startBridge に渡す)。 */
async function buildCommonBridgeOptions(configPath: string): Promise<{
  store: StateStore;
  storeConfig: ResolvedStoreConfig;
  options: Omit<
    BridgeOptions,
    "eventSource" | "web" | "configSource" | "store"
  >;
}> {
  const [storeConfig, agentConfigFile] = await Promise.all([
    loadStoreConfig(configPath),
    loadAgentConfig(configPath),
  ]);

  // agent ブロック (config.md §6) + env を解決する。優先順位は env > 設定ファイル > コード既定
  const agentConfig = resolveAgentConfig(agentConfigFile, process.env);
  const { turnTimeoutMs, progressNoticeIntervalMs, runtime } = agentConfig;

  const gcpEnv = collectGcpEnv();
  const piPaths = resolvePiPaths();
  // 足し算モデル (config.md §6): pi に渡る env は「コード既定 (gcpEnv) + agent.env に
  // 明示列挙したものだけ」。agent.env はレイヤ③ (ユーザー明示) としてレイヤ②
  // (gcpEnv, コード既定) を上書きできる — pi の実行に必須な GOOGLE_CLOUD_PROJECT 等を
  // 利用者が意図して差し替えるケースを許すため、後勝ちで agent.env を上に重ねる。
  // PI_EXPORT_ENTRYPOINT は export extension (孫プロセスとして `pi --export` を
  // 起動する) がホストの pi エントリポイントを知るために必要
  const extraEnv = {
    ...gcpEnv,
    ...agentConfig.env,
    PI_EXPORT_ENTRYPOINT: piPaths.entrypoint,
  };
  const store = buildStateStore(storeConfig);
  const archiveDir = process.env.WORKDIR_ARCHIVE_DIR;
  const sharedDir = process.env.SHARED_DIR;
  // 未設定/非数値なら createSharedStorage の既定閾値を使う (shared.md §7)
  const sharedShelfWarnBytes = Number(process.env.SHARED_SHELF_WARN_BYTES);
  const piPermission = buildPiPermissionConfig(runtime, piPaths);

  return {
    store,
    storeConfig,
    options: {
      piEntrypoint: piPaths.entrypoint,
      ...(Object.keys(extraEnv).length > 0 ? { extraEnv } : {}),
      // WORKDIR_ARCHIVE_DIR 未設定なら境界退避なし (Step 3 相当の挙動)
      ...(archiveDir !== undefined && archiveDir !== "" ? { archiveDir } : {}),
      // SHARED_DIR 未設定ならチャンネル共有ディレクトリなし (docs/design/shared.md)
      ...(sharedDir !== undefined && sharedDir !== "" ? { sharedDir } : {}),
      ...(Number.isFinite(sharedShelfWarnBytes) && sharedShelfWarnBytes > 0
        ? { sharedShelfWarnBytes }
        : {}),
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
      // PROGRESS_NOTICE_INTERVAL_MS 未設定なら SessionRunner の既定 (30_000ms) を使う
      ...(progressNoticeIntervalMs !== undefined
        ? { progressNoticeIntervalMs }
        : {}),
      logger,
    },
  };
}

/** `local [channelId]` (docs/design/local-dev.md §1): Slack を介さず stdin/stdout で
 * 全パイプラインを動かす開発用コネクタ。connector ブロックは読まない — store/agent
 * ブロックと CONFIG_PATH の扱いは main() と共通 (buildCommonBridgeOptions)。
 * startBridge に web を渡さず、poster/reactions/userResolver/fetchMessage を
 * LocalChat から注入する (bridge.ts の 2 点の変更で web なし起動が可能になった)。
 * startBridge (eventSource.start が resolve 次第すぐ返る) の後に REPL を起動し、
 * REPL 終了 (!quit / Ctrl-D) で exit(0) する。
 *
 * ink 化 (repl.tsx) に伴い、REPL 起動後は構造化ログとチャット画面が同じ
 * stdout に混在すると読みにくい。local mode 専用に pino の destination を
 * PassThrough に差し替えた logger を作り、startBridge にはその logger を
 * (buildCommonBridgeOptions が返す options.logger の代わりに) 渡し、同じ
 * PassThrough を startRepl の logStream としてログペインに表示する。
 * rootLogger (通常の Slack 起動パス) 自体はそのまま stdout に出続ける —
 * この差し替えは runLocal 内に閉じる。 */
async function runLocal(argv: string[]): Promise<void> {
  const channelId = argv[3] ?? DEFAULT_LOCAL_CHANNEL_ID;
  const configPath = process.env.CONFIG_PATH ?? DEFAULT_CONFIG_PATH;

  const { store, storeConfig, options } =
    await buildCommonBridgeOptions(configPath);

  const chat = createLocalChat({ defaultChannelId: channelId });

  const logStream = new PassThrough();
  const localLogger = pino(
    { level: process.env.LOG_LEVEL ?? "info" },
    logStream,
  );

  localLogger.child({ component: "server" }).info(
    {
      storeBackend: storeConfig.backend,
      configPath,
      channelId,
    },
    "local mode: state store configured",
  );

  await startBridge({
    eventSource: chat.ingress,
    store,
    configSource: new FileConfigSource(configPath),
    poster: chat.poster,
    reactions: chat.reactions,
    userResolver: chat.userResolver,
    fetchMessage: chat.fetchMessage,
    ...options,
    logger: localLogger.child({ component: "server" }),
  });

  await startRepl(chat, { initialChannelId: channelId, logStream });
  process.exit(0);
}

async function main() {
  if (process.argv[2] === "dump") {
    await runDump(process.argv);
    return;
  }
  if (process.argv[2] === "local") {
    await runLocal(process.argv);
    return;
  }

  const configPath = process.env.CONFIG_PATH ?? DEFAULT_CONFIG_PATH;

  // connector.slack (設定ファイル内, ${env.X} 参照解決済み) と、store/agent ブロック
  // 共通の組み立て (buildCommonBridgeOptions) を並行に読む (起動時の cold start 短縮)。
  // SLACK_MODE 等の env 直読みはやめ、connector-config.ts 経由に一本化する
  const [connectorConfig, { store, storeConfig, options }] = await Promise.all([
    loadConnectorConfig(configPath),
    buildCommonBridgeOptions(configPath),
  ]);
  const { ingress, botToken } = buildConnector(
    connectorConfig.slack,
    configPath,
  );

  const web = new WebClient(botToken);

  logger.info(
    {
      storeBackend: storeConfig.backend,
      workdirArchiveDir: process.env.WORKDIR_ARCHIVE_DIR,
      configPath,
      slackMode: connectorConfig.slack?.mode,
    },
    "state store configured",
  );

  await startBridge({
    eventSource: ingress,
    web,
    store,
    configSource: new FileConfigSource(configPath),
    ...options,
  });
}

main().catch((err) => {
  logger.error({ err }, "fatal error");
  process.exit(1);
});
