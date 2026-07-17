// チャットのテキストコマンド (session-model.md §6, §5)。/new と /enable /disable。
// gate を通過したメッセージ本文にのみ適用される (parse 自体は純関数)。

/** チャットのテキストコマンド。/new は rest 付きを許容するが、/enable /disable は
 * 完全一致のみ (session-model.md §5 「本文完全一致」)。 */
export type ChatCommand =
  | { kind: "new"; rest?: string }
  | { kind: "enable" }
  | { kind: "disable" };

const NEW_PREFIX = "/new";
const ENABLE_COMMAND = "/enable";
const DISABLE_COMMAND = "/disable";

/** メッセージ本文を解析してコマンドを返す。純関数 (session-model.md §6, §5):
 * - trim 後が "/new" に完全一致 → { kind: "new" }
 * - "/new" + 空白 (改行含む) + 残り → { kind: "new", rest: <残りを trim> }
 * - trim 後が "/enable" / "/disable" に完全一致 → { kind: "enable" } / { kind: "disable" }
 *   (後続テキストに意味がないため、rest 付きは誤爆防止でコマンド化しない)
 * - それ以外 (前方一致のみ、大文字小文字違い、前後に他の文字がある等) は null */
export function parseCommand(text: string): ChatCommand | null {
  const trimmed = text.trim();
  if (trimmed === ENABLE_COMMAND) return { kind: "enable" };
  if (trimmed === DISABLE_COMMAND) return { kind: "disable" };
  if (trimmed === NEW_PREFIX) {
    return { kind: "new" };
  }
  if (!trimmed.startsWith(NEW_PREFIX)) return null;
  const rest = trimmed.slice(NEW_PREFIX.length);
  if (!/^\s/.test(rest)) return null;
  const trimmedRest = rest.trim();
  if (trimmedRest === "") return { kind: "new" };
  return { kind: "new", rest: trimmedRest };
}
