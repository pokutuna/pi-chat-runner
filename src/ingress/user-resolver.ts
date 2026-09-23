// UserResolver — userId から表示名への解決と、本文中の mention の展開
// (docs/design/ingress-egress.md §3)
//
// Sender.displayName (chat-event.ts) を埋めるためのインターフェース。mention の
// 記法はチャットごとに違う (Slack の codec は `<@U123>` を `@U123` に剥がす) ため、
// 本文中の mention を拾う正規表現も実装側が持つ。実装は ./slack/user-resolver.ts。

import type { ChatEvent, Sender } from "./chat-event.js";

/** userId → 表示名の解決。解決できなければ null */
export interface UserResolver {
  resolve(userId: string): Promise<string | null>;
  /** 正規化後の本文に現れる mention を拾うパターン (グローバルフラグ付き、
   * capture group 1 が userId)。省略したチャットでは mention 展開を行わない。 */
  readonly mentionPattern?: RegExp;
}

/** ChatEvent の sender.id / text 中の mention を表示名に解決した新しい ChatEvent を返す。
 * reaction は sender のみ解決する (text を持たない)。sender を持たない kind は
 * そのまま (何もせず) 返す。解決できなかった ID は変更しない。
 * sender gate の name 判定 (gates/sender.ts) は解決済み displayName を前提とするため、
 * Ingress ステージ (ingress/pipeline.ts) は gate 評価前にこれを通す。 */
export async function enrichEvent(
  event: ChatEvent,
  resolver: UserResolver,
): Promise<ChatEvent> {
  if (event.kind !== "message" && event.kind !== "reaction") return event;

  const senderName = await resolver.resolve(event.sender.id);
  const sender: Sender =
    senderName !== null
      ? { ...event.sender, displayName: senderName }
      : event.sender;

  if (event.kind === "reaction") {
    return sender === event.sender ? event : { ...event, sender };
  }

  const pattern = resolver.mentionPattern;
  const matches =
    pattern !== undefined ? [...event.text.matchAll(pattern)] : [];
  let text = event.text;
  if (pattern !== undefined && matches.length > 0) {
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
    // 名前だけに置き換えると Agent が mention (`<@U123>`) を組み立てられなくなる
    // ため、UserID を併記する
    text = event.text.replace(pattern, (full, userId: string) => {
      const name = resolvedNames.get(userId);
      return name !== undefined ? `@${name} (${userId})` : full;
    });
  }

  return { ...event, sender, text };
}
