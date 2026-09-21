// InboxItem.id の導出 (docs/design/state.md §3.1)。
//
// Slack リトライは同じ event_id で届くため、これで冪等排除できる
// (app_mention/message の二重配信は別 event_id なので、ここではなく server 側で防ぐ)。

import type { InboundMessage } from "../../ingress/chat-event.js";

/** InboxItem.id の導出。Slack event_id (metadata.eventId)、無ければメッセージ ID (event.id) */
export function inboxItemId(event: InboundMessage): string {
  const eventId = event.metadata.eventId;
  return typeof eventId === "string" ? eventId : event.id;
}
