// ConnectorConfig スキーマ + ローダー — チャット接続層 (Ingress/Egress) の設定ブロック。
//
// agent.yaml に同居する (config.md §6 の agent.yaml と同じファイルを読む。ファイルを
// 増やさない)。agent.yaml 全体は 1 つの zod スキーマに統合せず、この connector ブロック
// だけを取り出して独立に読む (agent スキーマ本体は別モジュールが並行して定義するため)。
//
// 値は `${env.X}` / `${env.X:-default}` 参照を書ける (env-ref.ts)。読み込み順は
// yaml.parse → resolveEnvRefs(parsed, env) → zod。zod strict + fail-loud は
// agent-config.ts / channel-doc.ts と同じ流儀。

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { resolveEnvRefs } from "./env-ref.js";

const SlackConnectorSchema = z
  .object({
    mode: z.enum(["socket", "events"]).default("socket"),
    /** Socket Mode 受信用 (mode: socket)。 */
    appToken: z.string().optional(),
    /** Events API 受信用 (mode: events)。 */
    signingSecret: z.string().optional(),
    /** Events API 受信用 (mode: events)。既定 8080。 */
    port: z.coerce.number().int().positive().default(8080),
    /** 送信用 (chat.postMessage / reactions.add)。 */
    botToken: z.string(),
    /** 受信正規化用 (自分自身への mention 判定)。 */
    botUserId: z.string(),
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

const AGENT_CONFIG_FILENAME = "agent.yaml";

/** CONFIG_DIR/agent.yaml から `connector` ブロックだけを読む。ファイル自体が無ければ
 * 全項目省略として `{}` を返す (agent-config.ts の loadAgentConfig と同じ扱い)。
 * env 参照解決は yaml.parse の直後・zod 検証の前に行う。 */
export async function loadConnectorConfig(
  configDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedConnectorConfig> {
  const filePath = join(configDir, AGENT_CONFIG_FILENAME);

  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw new Error(`failed to read agent config file: ${filePath}`, {
      cause: err,
    });
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(`invalid YAML in agent config file: ${filePath}`, {
      cause: err,
    });
  }

  if (parsed === null || parsed === undefined) {
    return {};
  }
  if (typeof parsed !== "object") {
    throw new Error(`invalid agent config file: ${filePath} (not an object)`);
  }

  const connectorRaw = (parsed as Record<string, unknown>).connector;
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
