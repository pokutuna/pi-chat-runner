// UserResolver — userId から表示名への解決 (bridge 層で ChatEvent を enrich するための seam)
//
// Sender.displayName (chat-event.ts) を埋めるためのインターフェース。実装は
// ./slack/user-resolver.ts の Slack users.info クライアント。

import type { ChatEvent, Sender } from "./chat-event.js";

/** userId → 表示名の解決。bridge が Slack users.info で実装し、失敗時は null */
export interface UserResolver {
  resolve(userId: string): Promise<string | null>;
}

/** slack/adapter.ts の stripMentions が生成する `@U123ABC` 形式の mention パターン */
const STRIPPED_MENTION_PATTERN = /@(U[A-Z0-9]+)/g;

/** ChatEvent の sender.id / text 中の mention を表示名に解決した新しい ChatEvent を返す。
 * kind !== "message" はそのまま (何もせず) 返す。解決できなかった ID は変更しない。 */
export async function enrichEvent(
  event: ChatEvent,
  resolver: UserResolver,
): Promise<ChatEvent> {
  if (event.kind !== "message") return event;

  const senderName = await resolver.resolve(event.sender.id);
  const sender: Sender =
    senderName !== null
      ? { ...event.sender, displayName: senderName }
      : event.sender;

  const matches = [...event.text.matchAll(STRIPPED_MENTION_PATTERN)];
  let text = event.text;
  if (matches.length > 0) {
    const uniqueIds = [
      ...new Set(
        matches.map((m) => m[1]).filter((id): id is string => id !== undefined),
      ),
    ];
    const resolved = await Promise.all(
      uniqueIds.map(
        async (userId) => [userId, await resolver.resolve(userId)] as const,
      ),
    );
    const resolvedNames = new Map<string, string>(
      resolved.filter((entry): entry is [string, string] => entry[1] !== null),
    );
    // 名前だけに置き換えると pi が mention (`<@U123>`) を組み立てられなくなる
    // ため、UserID を併記する
    text = event.text.replace(
      STRIPPED_MENTION_PATTERN,
      (full, userId: string) => {
        const name = resolvedNames.get(userId);
        return name !== undefined ? `@${name} (${userId})` : full;
      },
    );
  }

  return { ...event, sender, text };
}
