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
