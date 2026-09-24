// System Config スキーマ + ローダー — docs/design/config.md §1.1, §2, §2.3
//
// Runner プロセスの構成 (チャット接続、State の保存先、Runtime の実行環境、
// 時間の既定値) を 1 ブロックにまとめる。boot 時に 1 回だけ読み、反映は再起動。
// Channel ごとの上書きを持たない。
//
// 設定ファイル (単一 YAML, root-config.ts) に同居する `system` ブロックだけを
// 取り出して独立に読む。3 ブロック (system / agent / channels) を 1 つの zod
// スキーマに統合はしない (config.md §2.1)。
//
// 値には `${env.X}` / `${env.X:-default}` 参照を書ける (env-ref.ts) — 解決するのは
// この system ブロックだけで、agent / channels は解決しない (agent.env を除く)。
// 読み込み順は yaml.parse → resolveEnvRefs(parsed, env) → zod。
//
// env からの直接上書き (TURN_TIMEOUT_MS 等, config.md §2.3) は resolveSystemConfig が
// 担う。優先順位は env > YAML > コード既定。

import { z } from "zod";

import { resolveEnvRefs } from "./env-ref.js";
import { readRootConfig } from "./root-config.js";

// --- system.chat ---

const SlackSocketSchema = z
  .object({
    /** Socket Mode 受信用 (mode: socket)。 */
    appToken: z.string().optional(),
  })
  .strict();

const SlackEventsSchema = z
  .object({
    /** Events API 受信用 (mode: events)。 */
    signingSecret: z.string().optional(),
    /** Events API 受信用 WebServer の port (mode: events)。既定 8080。 */
    port: z.coerce.number().int().positive().default(8080),
  })
  .strict();

const SlackChatSchema = z
  .object({
    mode: z.enum(["socket", "events"]).default("socket"),
    /** 送信用 (chat.postMessage / reactions.add)。 */
    botToken: z.string(),
    /** 受信正規化用 (自分自身への mention 判定)。 */
    botUserId: z.string(),
    socket: SlackSocketSchema.prefault({}),
    events: SlackEventsSchema.prefault({}),
  })
  .strict();

const ChatSchema = z
  .object({
    slack: SlackChatSchema.optional(),
  })
  .strict();

// --- system.state ---

const SqliteStateSchema = z
  .object({
    path: z.string().default("/tmp/pi-chat-runner/state.db"),
  })
  .strict();

const FirestoreStateSchema = z
  .object({
    /** GCP project id. Empty = SDK auto-detection (GOOGLE_CLOUD_PROJECT / ADC). */
    projectId: z.string().default(""),
    /** Named database id. */
    database: z.string().default("(default)"),
    /** Parent document all collections nest under, so a shared project's
     * top level stays clean (state.md §4.2). Validated here so a bad
     * path fails at startup, not at the first store operation. */
    rootDoc: z
      .string()
      .regex(
        /^[^/]+\/[^/]+(\/[^/]+\/[^/]+)*$/,
        'must be a document path with an even number of segments (e.g. "pi-chat-runner/default")',
      )
      .default("pi-chat-runner/default"),
  })
  .strict();

const ControlStateSchema = z
  .object({
    backend: z.enum(["memory", "sqlite", "firestore"]).default("memory"),
    /** backend が sqlite のときだけ使う。default があるので backend が sqlite
     * 以外でも常に値が入る (state.control.sqlite.path で常にアクセス可能)。 */
    sqlite: SqliteStateSchema.prefault({}),
    /** Used only when backend is firestore. Always defaulted, like sqlite. */
    firestore: FirestoreStateSchema.prefault({}),
  })
  .strict();

/** ${env.X:-} 参照で書かれた「未設定」は空文字として届く。空文字は「設定なし」と
 * 同義に扱いたい (workdirDir が "" なら Workdir 退避なし) ため、preprocess で
 * undefined に潰す。 */
const OptionalNonEmptyString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().optional(),
);

const AgentStateSchema = z
  .object({
    /** Workdir の退避先。空 (未設定) なら退避なし (state.md §7)。 */
    workdirDir: OptionalNonEmptyString,
    /** Channel 単位の Shared の置き場。空 (未設定) なら Shared なし (state.md §8)。 */
    sharedDir: OptionalNonEmptyString,
    /** Shared のサイズ警告閾値 (bytes)。空 (未設定) なら createSharedStore の
     * 既定閾値を使う (state.md §5.1)。 */
    sharedWarnBytes: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().positive().optional(),
    ),
  })
  .strict();

const StateSchema = z
  .object({
    control: ControlStateSchema.prefault({}),
    agent: AgentStateSchema.prefault({}),
  })
  .strict();

// --- system.runtime ---

/** pi 子プロセスの実行環境設定 (runtime.md §5)。${env.X} 解決後に zod で
 * 型を確定する — uid/gid は文字列でも number に coerce する。 */
const RuntimeSchema = z
  .object({
    uid: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().optional(),
    ),
    gid: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().optional(),
    ),
    /** pi 子プロセスへ常に HOME として渡すディレクトリ。既定 "/home/agent"。 */
    home: z.string().optional(),
  })
  .strict();

export const SystemConfigSchema = z
  .object({
    chat: ChatSchema.prefault({}),
    state: StateSchema.prefault({}),
    runtime: RuntimeSchema.prefault({}),
    /** ${env.X} 解決後は文字列で来る可能性があるため coerce する (uid/gid と同じ理由)。 */
    turnTimeoutMs: z.coerce.number().int().positive().optional(),
    /** 長時間ターンの進捗通知の間隔 (ingress-egress.md §8)。0 で機能自体を無効化する。 */
    progressNoticeIntervalMs: z.coerce.number().int().nonnegative().optional(),
    /** Session 実行の lease TTL (message-dispatch.md §6)。 */
    leaseTtlMs: z.coerce.number().int().positive().optional(),
    /** Turn 終了後に Agent プロセスと lease を保つ時間 (message-dispatch.md §7.3)。 */
    lingerMs: z.coerce.number().int().nonnegative().optional(),
  })
  .strict();

export type SystemConfig = z.infer<typeof SystemConfigSchema>;
export type SlackChatConfig = z.infer<typeof SlackChatSchema>;

export interface LoadSystemConfigOptions {
  /** `system.chat` を読まずに捨てる。local モード (local-dev.md §1) は Slack を
   * 使わないので、chat.slack の `${env.SLACK_BOT_TOKEN}` 等が未設定でも起動できる
   * 必要がある。env 参照の解決前に落とすため、chat 配下の必須 env は要求されない。 */
  omitChat?: boolean;
}

/** 設定ファイル (単一 YAML) から `system` ブロックだけを読む。ファイル自体が無い・
 * system ブロックが省略されている場合も SystemConfigSchema.parse({}) を通した
 * default 済みの値 (state.control.backend: memory 等) を返す。env 参照解決は
 * yaml.parse の直後・zod 検証の前に行う。 */
export async function loadSystemConfig(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
  options: LoadSystemConfigOptions = {},
): Promise<SystemConfig> {
  const filePath = configPath;
  const parsed = await readRootConfig(filePath);
  if (parsed === undefined) {
    return SystemConfigSchema.parse({});
  }

  let systemRaw = parsed.system;
  if (systemRaw === undefined) {
    return SystemConfigSchema.parse({});
  }
  if (options.omitChat && typeof systemRaw === "object" && systemRaw !== null) {
    const { chat: _chat, ...rest } = systemRaw as Record<string, unknown>;
    systemRaw = rest;
  }

  let resolved: unknown;
  try {
    resolved = resolveEnvRefs(systemRaw, env);
  } catch (err) {
    throw new Error(
      `failed to resolve env references in ${filePath} (system):`,
      { cause: err },
    );
  }

  const result = SystemConfigSchema.safeParse(resolved);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - system.${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`invalid system config schema in ${filePath}:\n${issues}`);
  }
  return result.data;
}

/** loadSystemConfig + resolveSystemConfig を通した後の平坦な設定。省略された
 * 時間フィールドは undefined のまま (Dispatcher / Session の既定に委ねる)。
 * runtime.home だけはこのモジュールがコード既定 ("/home/agent") を埋めて返す。 */
export interface ResolvedSystemConfig {
  chat: SystemConfig["chat"];
  state: SystemConfig["state"];
  runtime: ResolvedRuntimeConfig;
  turnTimeoutMs?: number;
  progressNoticeIntervalMs?: number;
  leaseTtlMs?: number;
  lingerMs?: number;
}

export interface ResolvedRuntimeConfig {
  uid?: number;
  gid?: number;
  /** pi 子プロセスへ常に HOME として渡すディレクトリ。既定 "/home/agent"。 */
  home: string;
}

/** env TURN_TIMEOUT_MS をパースする。未設定/空文字は undefined。0 や負数・非整数は
 * setTimeout の即時発火や無意味なタイムアウトに繋がるため fail-loud で弾く。 */
function parseTurnTimeoutMsEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value <= 0 || !Number.isInteger(value)) {
    throw new Error(
      "TURN_TIMEOUT_MS must be a positive integer (milliseconds)",
    );
  }
  return value;
}

/** env PROGRESS_NOTICE_INTERVAL_MS をパースする (parseTurnTimeoutMsEnv と同形)。
 * 未設定/空文字は undefined。0 は機能自体の無効化として許容する (turnTimeoutMs と
 * 異なり positive を要求しない)。負数・非整数は fail-loud で弾く。 */
function parseProgressNoticeIntervalMsEnv(
  raw: string | undefined,
): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value < 0 || !Number.isInteger(value)) {
    throw new Error(
      "PROGRESS_NOTICE_INTERVAL_MS must be a non-negative integer (milliseconds)",
    );
  }
  return value;
}

/** env PI_AGENT_UID / PI_AGENT_GID (runtime.md §5.1: UID 分離) を数値として
 * パースする。どちらも未設定か空文字なら undefined (file の値を使う分岐に委ねる)。
 * 空文字を未設定と同じに扱うのは、イメージが ENV で持つ既定値を `-e PI_AGENT_UID=`
 * のように空で上書きして UID 分離を外せるようにするため。片方だけ設定されているのは
 * 誤設定なので fail-loud にする。 */
function parseAgentIdsEnv(env: NodeJS.ProcessEnv): {
  uid?: number;
  gid?: number;
} {
  const uidRaw = env.PI_AGENT_UID === "" ? undefined : env.PI_AGENT_UID;
  const gidRaw = env.PI_AGENT_GID === "" ? undefined : env.PI_AGENT_GID;
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

/** system ブロックの内容と env を合わせて解決する。優先順位は env > YAML >
 * コード既定 (config.md §2.3)。時間フィールドのコード既定はここでは埋めない
 * (undefined のまま返し、Dispatcher / Session の既定に委ねる) が、runtime は
 * このモジュールがコード既定を埋めて返す。 */
export function resolveSystemConfig(
  file: SystemConfig,
  env: NodeJS.ProcessEnv,
): ResolvedSystemConfig {
  const turnTimeoutMs =
    parseTurnTimeoutMsEnv(env.TURN_TIMEOUT_MS) ?? file.turnTimeoutMs;
  const progressNoticeIntervalMs =
    parseProgressNoticeIntervalMsEnv(env.PROGRESS_NOTICE_INTERVAL_MS) ??
    file.progressNoticeIntervalMs;

  const agentIdsFromEnv = parseAgentIdsEnv(env);
  const uid = agentIdsFromEnv.uid ?? file.runtime.uid;
  const gid = agentIdsFromEnv.gid ?? file.runtime.gid;
  const home = env.PI_AGENT_HOME ?? file.runtime.home ?? "/home/agent";

  return {
    chat: file.chat,
    state: file.state,
    runtime: {
      ...(uid !== undefined ? { uid } : {}),
      ...(gid !== undefined ? { gid } : {}),
      home,
    },
    ...(turnTimeoutMs !== undefined ? { turnTimeoutMs } : {}),
    ...(progressNoticeIntervalMs !== undefined
      ? { progressNoticeIntervalMs }
      : {}),
    ...(file.leaseTtlMs !== undefined ? { leaseTtlMs: file.leaseTtlMs } : {}),
    ...(file.lingerMs !== undefined ? { lingerMs: file.lingerMs } : {}),
  };
}
