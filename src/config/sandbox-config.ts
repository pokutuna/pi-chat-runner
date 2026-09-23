// agent.sandbox の設定スキーマ — docs/design/config.md §1.3, §3.2, §3.5,
// docs/design/runtime.md §5.5
//
// pi を srt (@anthropic-ai/sandbox-runtime) で包むときのルール。ファイルは srt
// ネイティブ形式 (srt README の例がそのまま貼れる) で、network / filesystem と
// その配列だけを省略可にしている。Runner は省略分を [] で埋めてから srt が export する
// SandboxRuntimeConfigSchema で検証する — Runner 独自の設定形式を作らない。
//
// 2 つの形がある:
//   - トップレベル `agent.sandbox`: `false` | ファイルパス | インラインの完全ルール
//     (SandboxRulesSchema)。省略 = 無効 (opt-in)
//   - `channels[].agent.sandbox`: `false` | 追加専用オブジェクト (SandboxAdditionsSchema)。
//     完全ルールの配列 8 つに union する。他の Agent Config フィールドは Channel で
//     丸ごと置き換えだが、sandbox だけはこの追加マージ (config.md §3.2)
//
// 追加専用にしている理由 (PLAN §0-2): 想定ユースケース (API 以外全拒否、read / write
// 先の追加、Channel 限定のドメイン追加、Channel 限定で env を隠す) は全部 union で
// 足りる。削除・置換・スカラ上書きは sandbox の緩め方を増やすだけで要求が無い。
// k8s Strategic Merge Patch で言えば `patchStrategy: merge` の配列だけ書ける部分集合。

import { readFile } from "node:fs/promises";

import {
  type SandboxRuntimeConfig,
  SandboxRuntimeConfigSchema,
} from "@anthropic-ai/sandbox-runtime";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/** Runner が正規化・検証を終えた srt 設定。srt の型そのもの (Runner 独自の
 * フィールドは持たない)。Session 起動時に Runner が allowWrite を足して
 * `--settings` ファイルに書き出す (runtime/sandbox.ts)。 */
export type SandboxRules = SandboxRuntimeConfig;

/** 書くと sandbox が無言で弱まるキー。ロード時に error にする (PLAN §0-2)。 */
const FORBIDDEN_ROOT_FLAGS = [
  "enableWeakerNestedSandbox",
  "enableWeakerNetworkIsolation",
] as const;

/** srt ネイティブの設定オブジェクトを正規化・検証する。省略された network /
 * filesystem とその必須配列を [] で埋め、禁止キーを弾き、最後に srt の schema を通す。
 * zod の transform として使うため、問題は ctx.addIssue で報告する。 */
function normalizeSandboxRules(
  raw: Record<string, unknown>,
  ctx: z.RefinementCtx,
): SandboxRules {
  for (const flag of FORBIDDEN_ROOT_FLAGS) {
    if (raw[flag] === true) {
      ctx.addIssue({
        code: "custom",
        path: [flag],
        message: `${flag} weakens the sandbox and is not allowed`,
      });
    }
  }
  const network = asRecord(raw.network, "network", ctx);
  const filesystem = asRecord(raw.filesystem, "filesystem", ctx);
  if (filesystem.disabled === true) {
    ctx.addIssue({
      code: "custom",
      path: ["filesystem", "disabled"],
      message:
        "filesystem.disabled disables every filesystem rule and is not allowed",
    });
  }
  const filled = {
    ...raw,
    network: {
      allowedDomains: [],
      deniedDomains: [],
      ...network,
    },
    filesystem: {
      denyRead: [],
      allowRead: [],
      allowWrite: [],
      denyWrite: [],
      ...filesystem,
    },
  };
  // srt の schema (zod 3) で最終検証。issue はパスを保ってこちらの ctx に積み直す
  const result = SandboxRuntimeConfigSchema.safeParse(filled);
  if (!result.success) {
    for (const issue of result.error.issues) {
      ctx.addIssue({
        code: "custom",
        path: issue.path.map((segment) =>
          typeof segment === "symbol" ? String(segment) : segment,
        ),
        message: issue.message,
      });
    }
    return z.NEVER;
  }
  return result.data;
}

function asRecord(
  value: unknown,
  key: string,
  ctx: z.RefinementCtx,
): Record<string, unknown> {
  if (value === undefined) return {};
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  ctx.addIssue({
    code: "custom",
    path: [key],
    message: `${key} must be an object`,
  });
  return {};
}

/** トップレベル `agent.sandbox` にインラインで書く完全ルール、またはファイルの中身。
 * 入力は srt ネイティブのオブジェクト (省略可のキーあり)、出力は srt の型に正規化済み。 */
export const SandboxRulesSchema = z
  .record(z.string(), z.unknown())
  .transform(normalizeSandboxRules);

/** 追加できる配列の宣言 (config.md §3.2 の表)。ここに列挙した 8 つ以外のキーは
 * strict で弾く。credentials の要素は name / path をキーに union するため、その
 * キーだけ必須にし、他のフィールド (mode 等) は合成後に srt schema で検証する。 */
export const SandboxAdditionsSchema = z
  .object({
    network: z
      .object({
        allowedDomains: z.array(z.string()).optional(),
        deniedDomains: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    filesystem: z
      .object({
        allowRead: z.array(z.string()).optional(),
        allowWrite: z.array(z.string()).optional(),
        denyRead: z.array(z.string()).optional(),
        denyWrite: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    credentials: z
      .object({
        envVars: z.array(z.looseObject({ name: z.string() })).optional(),
        files: z.array(z.looseObject({ path: z.string() })).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type SandboxAdditions = z.infer<typeof SandboxAdditionsSchema>;

/** 文字列配列の union: base の順序を保ち、追加分を末尾に、重複は 1 つに。 */
function unionStrings(
  base: readonly string[] | undefined,
  additions: readonly string[] | undefined,
): string[] {
  return [...new Set([...(base ?? []), ...(additions ?? [])])];
}

/** オブジェクト配列の union: key フィールドの値で同一視する。同じキーで内容まで同じなら
 * 1 つに畳み、内容が違えば throw する (どちらが勝つかの規則を作らない)。 */
function unionKeyed<T extends Record<string, unknown>>(
  base: readonly T[] | undefined,
  additions: readonly Record<string, unknown>[] | undefined,
  key: string,
  label: string,
): T[] {
  const result: T[] = [...(base ?? [])];
  for (const entry of additions ?? []) {
    const id = entry[key];
    const existing = result.find((item) => item[key] === id);
    if (existing === undefined) {
      result.push(entry as T);
      continue;
    }
    if (!sameJson(existing, entry)) {
      throw new Error(
        `${label}: entry with ${key} "${String(id)}" is already defined with different content`,
      );
    }
  }
  return result;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

/** Channel の追加分を完全ルールに union する (config.md §3.2)。純粋関数。
 * base の他のキー (strictAllowlist / allowUnixSockets / credentials.awsPairs 等) は
 * スプレッドで素通り。合成結果は srt schema で再検証する — 追加分の credentials 要素の
 * mode 等の妥当性はここで初めて見る。 */
export function mergeSandboxAdditions(
  base: SandboxRules,
  additions: SandboxAdditions,
): SandboxRules {
  const merged = {
    ...base,
    network: {
      ...base.network,
      allowedDomains: unionStrings(
        base.network.allowedDomains,
        additions.network?.allowedDomains,
      ),
      deniedDomains: unionStrings(
        base.network.deniedDomains,
        additions.network?.deniedDomains,
      ),
    },
    filesystem: {
      ...base.filesystem,
      allowRead: unionStrings(
        base.filesystem.allowRead,
        additions.filesystem?.allowRead,
      ),
      allowWrite: unionStrings(
        base.filesystem.allowWrite,
        additions.filesystem?.allowWrite,
      ),
      denyRead: unionStrings(
        base.filesystem.denyRead,
        additions.filesystem?.denyRead,
      ),
      denyWrite: unionStrings(
        base.filesystem.denyWrite,
        additions.filesystem?.denyWrite,
      ),
    },
    ...(additions.credentials !== undefined || base.credentials !== undefined
      ? {
          credentials: {
            ...base.credentials,
            ...(additions.credentials?.envVars !== undefined ||
            base.credentials?.envVars !== undefined
              ? {
                  envVars: unionKeyed(
                    base.credentials?.envVars,
                    additions.credentials?.envVars,
                    "name",
                    "credentials.envVars",
                  ),
                }
              : {}),
            ...(additions.credentials?.files !== undefined ||
            base.credentials?.files !== undefined
              ? {
                  files: unionKeyed(
                    base.credentials?.files,
                    additions.credentials?.files,
                    "path",
                    "credentials.files",
                  ),
                }
              : {}),
          },
        }
      : {}),
  };
  const result = SandboxRuntimeConfigSchema.safeParse(merged);
  if (!result.success) {
    throw new Error(
      `merged sandbox rules are invalid:\n${formatIssues(result.error.issues)}`,
    );
  }
  return result.data;
}

function formatIssues(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): string {
  return issues
    .map((issue) => `  - ${issue.path.map(String).join(".")}: ${issue.message}`)
    .join("\n");
}

/** `agent.sandbox` にパスで指定されたファイルを読み、SandboxRulesSchema で正規化・検証
 * する。JSON でも YAML でもよい (JSON は YAML の部分集合なので YAML パーサで読む)。
 * ファイル不在・パース失敗・schema 違反はファイルパス付きで throw する (設定ミスは
 * メッセージ到着時でなく boot / dump で落とす)。 */
export async function loadSandboxRuleFile(path: string): Promise<SandboxRules> {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch (err) {
    throw new Error(`failed to read sandbox rule file: ${path}`, {
      cause: err,
    });
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new Error(`invalid JSON/YAML in sandbox rule file: ${path}`, {
      cause: err,
    });
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `sandbox rule file must contain an object at the root: ${path}`,
    );
  }
  const result = SandboxRulesSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `invalid sandbox rules in ${path}:\n${formatIssues(result.error.issues)}`,
    );
  }
  return result.data;
}
