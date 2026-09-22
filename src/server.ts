// エントリポイント (Cloud Run デプロイ / Events API)
//
// Ingress (Socket Mode / Events API) で受けたイベントをハードフィルタ
// だけ通し、Dispatcher に渡す。入口の選択は system.chat.slack.mode (設定ファイル /
// SLACK_MODE env) で行い、後段 (gate 評価・inbox・lease・pi の起動/steer。すべて
// Dispatcher の中, src/dispatch/dispatcher.ts) には入口の別を漏らさない
// (architecture.md §5)。State backend の実装選択 (system.state.control.backend) も
// 同様にここで行う (state.md §4 / docs/design/architecture.md §3, §6)。

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PassThrough } from "node:stream";

import { Firestore } from "@google-cloud/firestore";
import { WebClient } from "@slack/web-api";
import pino from "pino";

import type { BridgeOptions } from "./bridge.js";
import { startBridge } from "./bridge.js";
import {
  FileConfigSource,
  loadChannelConfigFile,
} from "./config/config-source.js";
import { formatEffectiveConfig } from "./config/dump.js";
import {
  loadSystemConfig,
  type ResolvedSystemConfig,
  resolveSystemConfig,
  type SlackChatConfig,
} from "./config/system-config.js";
import type { Ingress } from "./ingress/ingress.js";
import { createLocalChat } from "./ingress/local/local-chat.js";
import { startRepl } from "./ingress/local/repl.js";
import { HttpIngress } from "./ingress/slack/http-ingress.js";
import { SocketIngress } from "./ingress/slack/socket-ingress.js";
import { rootLogger } from "./logger.js";
import { createRuntimeConfig } from "./runtime/resolve.js";
import { FirestoreControlState } from "./state/control/backends/firestore.js";
import { InMemoryControlState } from "./state/control/backends/memory.js";
import { SqliteControlState } from "./state/control/backends/sqlite.js";
import type { ControlState } from "./state/control/interfaces.js";

const logger = rootLogger.child({ component: "server" });

/** system.state.control.backend (既定 memory) で Control State のバックエンドを選ぶ
 * (state.md §4)。Dispatcher 以下には実装の別を漏らさない。 */
function buildControlState(
  control: ResolvedSystemConfig["state"]["control"],
): ControlState {
  switch (control.backend) {
    case "memory":
      return new InMemoryControlState();
    case "sqlite": {
      mkdirSync(dirname(control.sqlite.path), { recursive: true });
      return new SqliteControlState(control.sqlite.path);
    }
    case "firestore": {
      // projectId 未指定 ("") なら SDK が GOOGLE_CLOUD_PROJECT / ADC から解決する。
      // エミュレータは FIRESTORE_EMULATOR_HOST を SDK が自動で読む (state.md §4.2)
      const { projectId, database, rootDoc } = control.firestore;
      return new FirestoreControlState(
        new Firestore({
          ...(projectId !== "" && { projectId }),
          databaseId: database,
        }),
        { rootDoc },
      );
    }
    default:
      throw new Error(
        `Unknown system.state.control.backend "${control.backend}" (expected memory|sqlite|firestore)`,
      );
  }
}

/** system.chat.slack ブロックの使い方 (新スキーマのブロック名) を stderr に出す。
 * `--help` と、必須項目が欠けたままの起動 (missingChatConfig) で共有する。 */
function printUsage(configPath: string): void {
  console.error(
    "Usage: node dist/server.js [dump <channel> [--json] | local [channelId] | --help]",
  );
  console.error("");
  console.error(`${configPath} needs a system.chat.slack block to start:`);
  console.error("");
  console.error("system:");
  console.error("  chat:");
  console.error("    slack:");
  console.error(
    "      mode: ${env.SLACK_MODE:-socket}       # socket | events (default socket; architecture.md §3)",
  );
  console.error(
    "      botToken: ${env.SLACK_BOT_TOKEN}      # required (xoxb-...)",
  );
  console.error(
    "      botUserId: ${env.SLACK_BOT_USER_ID}   # required (U...)",
  );
  console.error("      socket:");
  console.error(
    "        appToken: ${env.SLACK_APP_TOKEN}    # required in socket mode (xapp-...)",
  );
  console.error("      events:");
  console.error(
    "        signingSecret: ${env.SLACK_SIGNING_SECRET}  # required in events mode",
  );
  console.error(
    "        port: ${env.PORT:-8080}             # listen port in events mode",
  );
  console.error("  state:");
  console.error(
    "    control: { backend: memory|sqlite|firestore, sqlite: {path}, firestore: {...} }",
  );
  console.error(
    "    agent:   { workdirDir, sharedDir, sharedWarnBytes }  # empty = feature off",
  );
  console.error("  runtime: { uid, gid, home, permissionMode, allowAddons }");
  console.error(
    "  turnTimeoutMs, progressNoticeIntervalMs, leaseTtlMs, lingerMs",
  );
  console.error("agent:      # default Agent Config for every channel");
  console.error(
    "  systemPrompt, context, model, tools, excludeTools, skills, extensions, memory, env",
  );
  console.error(
    "channels:   # per-channel: trigger / session / reply + agent overrides",
  );
  console.error("");
  console.error(
    "Env overrides for the system block (env > YAML > code default; config.md §2.3):",
  );
  console.error(
    "  PI_AGENT_UID/GID    uid/gid pi runs as (UID separation, runtime.md §5.1; both must be set. Also system.runtime.uid/gid)",
  );
  console.error(
    "  PI_AGENT_HOME       directory always passed as HOME to the pi child process (default /home/agent. Also system.runtime.home)",
  );
  console.error(
    "  PI_PERMISSION_MODE  set to 0 to disable the Node Permission Model (default ON. Also system.runtime.permissionMode: false)",
  );
  console.error(
    "  PI_ALLOW_ADDONS     set to 1 to allow native addons under the Permission Model (default off. Also system.runtime.allowAddons)",
  );
  console.error(
    "  TURN_TIMEOUT_MS     per-turn limit in ms (default 600000 = 10 min; pi is killed and the session ends if exceeded. Also system.turnTimeoutMs)",
  );
  console.error(
    "  PROGRESS_NOTICE_INTERVAL_MS  interval in ms between progress notices on long turns (default 30000; 0 disables. Also system.progressNoticeIntervalMs)",
  );
  console.error("");
  console.error(
    "Read straight from the process env (never via YAML): CONFIG_PATH, LOG_LEVEL, GOOGLE_*, METADATA_SERVER_DETECTION",
  );
  console.error("");
  console.error("Example (.env file recommended):");
  console.error("  cp .env.example .env  # fill in the values");
  console.error(
    "  pnpm run dev          # loaded via --env-file-if-exists=.env",
  );
}

function missingChatConfig(configPath: string): never {
  console.error("Missing or incomplete system.chat.slack config");
  console.error("");
  printUsage(configPath);
  process.exit(1);
}

/** system.chat.slack.mode (既定 socket) で入口を切り替える (architecture.md §3)。両モードとも
 * dedupe・起動判定・inbox 積みの後段は共通で、「受け取り方 / ACK の意味」だけが違う。
 * モード別必須項目 (appToken / signingSecret) もここで振り分ける。system.chat.slack 自体が
 * 無い、またはモード別必須項目が欠けている場合は fail-loud で使い方を表示して exit する。 */
function buildChat(
  slack: SlackChatConfig | undefined,
  configPath: string,
): { ingress: Ingress; botToken: string } {
  if (slack === undefined) {
    missingChatConfig(configPath);
  }
  const { mode, botToken, botUserId } = slack;
  switch (mode) {
    case "socket": {
      if (slack.socket.appToken === undefined || slack.socket.appToken === "") {
        missingChatConfig(configPath);
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
        missingChatConfig(configPath);
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
        `Unknown system.chat.slack.mode "${mode}" (expected socket|events)`,
      );
  }
}

/** `dump <channel> [--json]` (config.md §5): bot を起動せず、あるチャンネルの
 * merge 済み実効設定を provenance 付きで表示して exit(0) する。resolveChannelConfig
 * (ランタイムと共有) をそのまま呼ぶ formatEffectiveConfig に委譲するだけで、
 * dump 専用の設定解決ロジックは持たない。agent / channels ブロックしか読まないため
 * system の secrets は解決されない (config.md §5)。例外時は stderr に出して
 * exit(1)。 */
async function runDump(argv: string[]): Promise<void> {
  const channelId = argv[3];
  if (channelId === undefined) {
    console.error("Usage: node dist/server.js dump <channel> [--json]");
    process.exit(1);
  }
  const json = argv.includes("--json");
  const configPath = process.env.CONFIG_PATH ?? DEFAULT_CONFIG_PATH;

  try {
    // resolveEnv: false — dump は agent.env の ${env.X} を解決せず、書かれたままの
    // 参照文字列を表示する (config.md §2.1 末尾, §5)。secret を解決した値を
    // stdout に出さないための経路。
    const { file, defaultAgent } = await loadChannelConfigFile(
      configPath,
      process.env,
      { resolveEnv: false },
    );
    console.log(formatEffectiveConfig(file, channelId, { json, defaultAgent }));
    process.exit(0);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

/** 設定ファイル (単一 YAML) の既定パス。イメージには examples/config を同梱する
 * (Dockerfile) ため、CONFIG_PATH 未設定でもサンプル設定で起動できる。 */
const DEFAULT_CONFIG_PATH = "examples/config/agent.yaml";

/** `local` サブコマンドの既定チャンネル ID (docs/design/local-dev.md §2)。 */
const DEFAULT_LOCAL_CHANNEL_ID = "local";

/** main() / runLocal() 共通の組み立て (Control State backend, RuntimeConfig,
 * Agent State のディレクトリ等)。すべて system ブロック
 * (config.md §1.1) から取る。system.chat の消費 (Ingress の選択) と web (WebClient) の
 * 構築だけは呼び出し元ごとに異なるため、ここには含めない (local mode は chat を
 * 読まない。docs/design/local-dev.md §2)。
 *
 * 返す options は startBridge に渡す BridgeOptions のうち eventSource/web/configSource
 * を除いた共通部分 (呼び出し元がそれぞれの入口を追加してから startBridge に渡す)。 */
function buildCommonBridgeOptions(system: ResolvedSystemConfig): {
  controlState: ControlState;
  options: Omit<
    BridgeOptions,
    "eventSource" | "web" | "configSource" | "controlState"
  >;
} {
  const { state } = system;

  const controlState = buildControlState(state.control);
  const { workdirDir, sharedDir, sharedWarnBytes } = state.agent;

  return {
    controlState,
    options: {
      // Runtime レイヤの静的設定 (pi のパス解決・env allowlist・UID 分離・
      // Permission Model・workdir のルート) は runtime/resolve.ts に閉じる
      runtime: createRuntimeConfig(system),
      // system.state.agent.workdirDir 未設定なら境界退避なし
      ...(workdirDir !== undefined ? { archiveDir: workdirDir } : {}),
      // system.state.agent.sharedDir 未設定ならチャンネル共有ディレクトリなし
      // (docs/design/state.md §8)
      ...(sharedDir !== undefined ? { sharedDir } : {}),
      // 未設定なら createSharedStore の既定閾値を使う (state.md §5.1)
      ...(sharedWarnBytes !== undefined
        ? { sharedShelfWarnBytes: sharedWarnBytes }
        : {}),
      // system.turnTimeoutMs 未設定なら Dispatcher の既定 (600_000ms) を使う
      ...(system.turnTimeoutMs !== undefined
        ? { turnTimeoutMs: system.turnTimeoutMs }
        : {}),
      // system.progressNoticeIntervalMs 未設定なら Dispatcher の既定を使う
      ...(system.progressNoticeIntervalMs !== undefined
        ? { progressNoticeIntervalMs: system.progressNoticeIntervalMs }
        : {}),
      ...(system.leaseTtlMs !== undefined
        ? { leaseTtlMs: system.leaseTtlMs }
        : {}),
      ...(system.lingerMs !== undefined ? { lingerMs: system.lingerMs } : {}),
      logger,
    },
  };
}

/** `local [channelId]` (docs/design/local-dev.md §2): Slack を介さず stdin/stdout で
 * 全パイプラインを動かす開発用コネクタ。system.chat は読まない — system の残りと
 * CONFIG_PATH の扱いは main() と共通 (buildCommonBridgeOptions)。
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

  const system = resolveSystemConfig(
    await loadSystemConfig(configPath),
    process.env,
  );
  const { controlState, options } = buildCommonBridgeOptions(system);

  const chat = createLocalChat({ defaultChannelId: channelId });

  const logStream = new PassThrough();
  const localLogger = pino(
    { level: process.env.LOG_LEVEL ?? "info" },
    logStream,
  );

  localLogger.child({ component: "server" }).info(
    {
      storeBackend: system.state.control.backend,
      configPath,
      channelId,
    },
    "local mode: state store configured",
  );

  await startBridge({
    eventSource: chat.ingress,
    controlState,
    configSource: new FileConfigSource(configPath),
    poster: chat.poster,
    reactor: chat.reactor,
    userResolver: chat.userResolver,
    fetchMessage: chat.fetchMessage,
    ...options,
    logger: localLogger.child({ component: "server" }),
  });

  await startRepl(chat, {
    initialChannelId: channelId,
    logStream,
    listChannels: async () =>
      (await loadChannelConfigFile(configPath)).file.channels.map(
        (c) => c.channel,
      ),
  });
  process.exit(0);
}

async function main() {
  if (process.argv[2] === "--help" || process.argv[2] === "-h") {
    printUsage(process.env.CONFIG_PATH ?? DEFAULT_CONFIG_PATH);
    process.exit(0);
  }
  if (process.argv[2] === "dump") {
    await runDump(process.argv);
    return;
  }
  if (process.argv[2] === "local") {
    await runLocal(process.argv);
    return;
  }

  const configPath = process.env.CONFIG_PATH ?? DEFAULT_CONFIG_PATH;

  // system ブロック (設定ファイル内, ${env.X} 参照解決済み) を 1 回だけ読み、
  // 実装選択 (Ingress / Control State / Runtime) をすべてそこから導く。
  // SLACK_MODE 等の env 直読みはやめ、system-config.ts 経由に一本化する
  const system = resolveSystemConfig(
    await loadSystemConfig(configPath),
    process.env,
  );
  const { controlState, options } = buildCommonBridgeOptions(system);
  const { ingress, botToken } = buildChat(system.chat.slack, configPath);

  const web = new WebClient(botToken);

  logger.info(
    {
      storeBackend: system.state.control.backend,
      workdirArchiveDir: system.state.agent.workdirDir,
      configPath,
      slackMode: system.chat.slack?.mode,
    },
    "state store configured",
  );

  await startBridge({
    eventSource: ingress,
    web,
    controlState,
    configSource: new FileConfigSource(configPath),
    ...options,
  });
}

main().catch((err) => {
  logger.error({ err }, "fatal error");
  process.exit(1);
});
