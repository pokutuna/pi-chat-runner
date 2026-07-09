// ${env.X} 参照解決モジュール — agent.yaml / channels.yaml など、今後 connector/store/agent
// の全スキーマが依存する土台。「A2: parse 後走査」方式を採る: YAML テキストを置換するの
// ではなく、yaml.parse() 済みの JS オブジェクトを再帰走査して string 値中の参照だけを
// 置換する。YAML 構造を壊さない・コメントに影響しない・エラーでフィールドパスを示せる
// ことがこの方式を選んだ理由。
//
// 参照記法:
//   ${env.NAME}            — NAME が未設定なら fail-loud で throw (空文字は「設定された」
//                             扱いで throw しない)
//   ${env.NAME:-default}   — NAME が未設定または空文字のとき default を使う
//                             (シェルの ${VAR:-default} と同じセマンティクス)
// NAME は環境変数名の慣習に合わせ [A-Za-z_][A-Za-z0-9_]* のみ。これにマッチしない
// `${...}` は参照とみなさずリテラルのまま素通しする。
//
// 型変換はしない。解決結果は常に string を返す。数値/boolean への coerce は呼び出し側の
// zod (z.coerce.number() 等) に委ねる (agent-config.ts / channel-doc.ts と同じ「コード側で
// 既定値やパースを二重管理しない」方針)。

const ENV_REF_PATTERN = /\$\{env\.([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g;

/** string 値 1 個に含まれる ${env.*} 参照をすべて解決する。path はエラーメッセージ用の
 * フィールドパス表示 (例 "connector.slack.appToken")。 */
function resolveString(
  value: string,
  env: NodeJS.ProcessEnv,
  path: string,
): string {
  return value.replace(
    ENV_REF_PATTERN,
    (
      _match,
      name: string,
      hasDefault: string | undefined,
      defaultValue: string,
    ) => {
      const actual = env[name];
      if (hasDefault !== undefined) {
        // ${env.NAME:-default}: シェルの :- と同じく、未設定・空文字どちらも default。
        return actual === undefined || actual === "" ? defaultValue : actual;
      }
      if (actual === undefined) {
        throw new Error(
          `env-ref: environment variable "${name}" is not set (referenced at "${path}")`,
        );
      }
      // ${env.NAME}: 空文字は「設定された」とみなすため throw しない。
      return actual;
    },
  );
}

/** yaml.parse() 済みの任意構造を再帰走査し、string 値中の ${env.*} 参照を解決する。
 * object/array は再帰、string 以外 (number/boolean/null) はそのまま返す。 */
export function resolveEnvRefs(obj: unknown, env: NodeJS.ProcessEnv): unknown {
  return resolveNode(obj, env, "");
}

function resolveNode(
  node: unknown,
  env: NodeJS.ProcessEnv,
  path: string,
): unknown {
  if (typeof node === "string") {
    return resolveString(node, env, path);
  }
  if (Array.isArray(node)) {
    return node.map((item, index) =>
      resolveNode(item, env, `${path}[${index}]`),
    );
  }
  if (node !== null && typeof node === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      const childPath = path === "" ? key : `${path}.${key}`;
      result[key] = resolveNode(value, env, childPath);
    }
    return result;
  }
  // number / boolean / null はそのまま素通し。
  return node;
}
