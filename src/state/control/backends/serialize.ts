// sqlite.ts / firestore.ts 共通のシリアライズ補助

import type { InboundMessage } from "../../../ingress/chat-event.js";

/** InboundMessage は JSON.stringify で timestamp (Date) が ISO 文字列に潰れるので、
 * parse 後に Date へ戻す。他のフィールドに Date は無い (chat-event.ts)。 */
export function parseInboundMessage(payload: string): InboundMessage {
  const parsed = JSON.parse(payload) as Omit<InboundMessage, "timestamp"> & {
    timestamp: string;
  };
  return { ...parsed, timestamp: new Date(parsed.timestamp) };
}

/** SessionRecord の startedAt / lastActiveAt を持たない永続ドキュメントを読むための
 * 補完 (state.md §3.2)。以前のスキーマで書かれたドキュメントは両者の代わりに
 * `updatedAt` を持つ。移行は行わず、読み出し時に updatedAt (それも無ければ読み取り
 * 時刻) を代入して SessionRecord の必須フィールドを満たす。次の put で現行スキーマに
 * 揃う。 */
export function fillSessionTimestamps(fields: {
  startedAt: Date | undefined;
  lastActiveAt: Date | undefined;
  updatedAt: Date | undefined;
  now: Date;
}): { startedAt: Date; lastActiveAt: Date } {
  const startedAt = fields.startedAt ?? fields.updatedAt ?? fields.now;
  const lastActiveAt = fields.lastActiveAt ?? fields.updatedAt ?? startedAt;
  return { startedAt, lastActiveAt };
}
