// 設定ファイル (単一 YAML, 慣例名 agent.yaml) の共通リーダー — docs/design/config.md §6
//
// connector / store / pi / agent / channels の全ブロックが 1 つの YAML に同居する。
// 全体を 1 つの zod スキーマに統合はせず、各ローダー (connector-config.ts /
// store-config.ts / agent-config.ts / config-source.ts) がこのリーダーで root を
// 読み、自分の担当ブロックだけを取り出して独立に検証する。env 参照 (${env.X}) の
// 解決も各ローダーが自分のブロックに対してだけ行う — channels ブロックは env 解決を
// 通らないため、dump (config.md §6) が secrets に触れない性質がここで担保される。

import { readFile } from "node:fs/promises";

import { parse as parseYaml } from "yaml";

/** 設定ファイルを読み、YAML として root オブジェクトを返す。ファイルが無ければ
 * undefined (呼び出し側が「全項目省略」として扱うか fail-loud にするかを決める)。
 * 読み込みエラー・YAML 破損・root が object でない場合は fail-loud で throw する。
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
  return parsed as Record<string, unknown>;
}
