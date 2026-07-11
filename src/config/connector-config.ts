// ConnectorConfig スキーマ + ローダー — チャット接続層 (Ingress/Egress) の設定ブロック。
//
// 設定ファイル (単一 YAML, root-config.ts) に同居する connector ブロックだけを
// 取り出して独立に読む (他ブロックは別モジュールが並行して定義するため、全体を
// 1 つの zod スキーマに統合しない)。
//
// 値は `${env.X}` / `${env.X:-default}` 参照を書ける (env-ref.ts)。読み込み順は
// yaml.parse → resolveEnvRefs(parsed, env) → zod。zod strict + fail-loud は
// agent-config.ts / channel-doc.ts と同じ流儀。

import { z } from "zod";

import { resolveEnvRefs } from "./env-ref.js";
import { readRootConfig } from "./root-config.js";

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

const SlackConnectorSchema = z
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

export const ConnectorConfigSchema = z
  .object({
    slack: SlackConnectorSchema.optional(),
  })
  .strict();

export type ConnectorConfig = z.infer<typeof ConnectorConfigSchema>;
export type SlackConnectorConfig = z.infer<typeof SlackConnectorSchema>;

/** loadConnectorConfig を通した後の設定。現状 slack のみサポートし、connector 自体が
 * 省略されている・slack が省略されている場合は undefined のまま返す (呼び出し側の
 * fail-loud な判断に委ねる)。zod の推論型 (ConnectorConfig) をそのまま公開名として
 * 使う — exactOptionalPropertyTypes 下で独自インターフェースを別途持つと optional の
 * 意味 (キー省略 vs undefined 値) がズレるため。 */
export type ResolvedConnectorConfig = ConnectorConfig;

/** 設定ファイル (単一 YAML) から `connector` ブロックだけを読む。ファイル自体が
 * 無ければ全項目省略として `{}` を返す (agent-config.ts の loadAgentConfig と同じ扱い)。
 * env 参照解決は yaml.parse の直後・zod 検証の前に行う。 */
export async function loadConnectorConfig(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedConnectorConfig> {
  const filePath = configPath;
  const parsed = await readRootConfig(filePath);
  if (parsed === undefined) {
    return {};
  }

  const connectorRaw = parsed.connector;
  if (connectorRaw === undefined) {
    return {};
  }

  let resolved: unknown;
  try {
    resolved = resolveEnvRefs(connectorRaw, env);
  } catch (err) {
    throw new Error(
      `failed to resolve env references in ${filePath} (connector):`,
      { cause: err },
    );
  }

  const result = ConnectorConfigSchema.safeParse(resolved);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - connector.${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `invalid connector config schema in ${filePath}:\n${issues}`,
    );
  }
  return result.data;
}
