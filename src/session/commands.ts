// チャットのテキストコマンド (session-model.md §6)。現状は /new のみ。
// gate を通過したメッセージ本文にのみ適用される (parse 自体は純関数)。

/** チャットのテキストコマンド。現状は /new のみ */
export interface ChatCommand {
  kind: "new";
  rest?: string;
}

const NEW_PREFIX = "/new";

/** メッセージ本文を解析してコマンドを返す。純関数 (session-model.md §6):
 * - trim 後が "/new" に完全一致 → { kind: "new" }
 * - "/new" + 空白 (改行含む) + 残り → { kind: "new", rest: <残りを trim> }
 * - それ以外 (前方一致のみ、大文字小文字違い、前後に他の文字がある等) は null */
export function parseCommand(text: string): ChatCommand | null {
  const trimmed = text.trim();
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
