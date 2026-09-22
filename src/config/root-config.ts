// 設定ファイル (単一 YAML, 慣例名 agent.yaml) の共通リーダー — docs/design/config.md §2.1
//
// トップレベルのブロックはちょうど system / agent / channels の 3 つ。全体を 1 つの
// zod スキーマに統合はせず、各ローダー (system-config.ts / config-source.ts) が
// このリーダーで root を読み、自分の担当ブロックだけを取り出して独立に検証する。
//
// env 参照 (${env.X}) を解決するのは system ブロックだけ (config.md §2.1)。唯一の
// 例外が agent.env / channels[].agent.env の値で、ここは pi 子プロセスへ渡す env の
// 値そのものを書く場所なのでロード時に解決する (resolveAgentEnvRefs)。
// agent / channels の残りは env 解決を通らないため、dump (config.md §5) が
// secrets を解決した値で出すことが構造上ありえない。

import { readFile } from "node:fs/promises";

import { parse as parseYaml } from "yaml";

import { resolveEnvRefs } from "./env-ref.js";

/** 設定ファイルのトップレベルに書ける唯一のブロック集合 (config.md §2)。
 * これ以外の未知キーは fail-loud で弾く。 */
const ROOT_BLOCKS = ["system", "agent", "channels"] as const;

/** 設定ファイルを読み、YAML として root オブジェクトを返す。ファイルが無ければ
 * undefined (呼び出し側が「全項目省略」として扱うか fail-loud にするかを決める)。
 * 読み込みエラー・YAML 破損・root が object でない場合は fail-loud で throw する。
 * トップレベルに system / agent / channels 以外のブロックがあれば、想定外の
 * 設定ファイルを黙って無視しないよう fail-loud で throw する。
 * コメントだけの YAML (parse 結果が null) は {} 扱い。 */
export async function readRootConfig(
  filePath: string,
): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new Error(`failed to read config file: ${filePath}`, { cause: err });
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(`invalid YAML in config file: ${filePath}`, { cause: err });
  }

  if (parsed === null || parsed === undefined) {
    return {};
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`invalid config file: ${filePath} (not an object)`);
  }

  const root = parsed as Record<string, unknown>;
  const unknown = Object.keys(root).filter(
    (key) => !(ROOT_BLOCKS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw new Error(
      `unknown top-level block(s) in config file ${filePath}: ${unknown.join(", ")} ` +
        `(valid blocks: ${ROOT_BLOCKS.join(", ")})`,
    );
  }
  return root;
}

/** Agent Config の `env` フィールドの値だけ ${env.X} 参照を解決する
 * (config.md §2.1 の唯一の例外)。agent ブロック / channels[].agent のどちらにも
 * 同じ形で適用する。env フィールドが無ければ入力をそのまま返す。
 * value が object でない場合は zod の検証に委ねてそのまま通す。 */
export function resolveAgentEnvRefs(
  agentRaw: unknown,
  env: NodeJS.ProcessEnv,
  path: string,
): unknown {
  if (agentRaw === null || typeof agentRaw !== "object") return agentRaw;
  const agent = agentRaw as Record<string, unknown>;
  if (agent.env === undefined) return agent;
  let resolvedEnv: unknown;
  try {
    resolvedEnv = resolveEnvRefs(agent.env, env);
  } catch (err) {
    throw new Error(`failed to resolve \${env.*} references in ${path}.env`, {
      cause: err,
    });
  }
  return { ...agent, env: resolvedEnv };
}
