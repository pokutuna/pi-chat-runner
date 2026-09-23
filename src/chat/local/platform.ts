// in-memory chat の ChatPlatform 実装 (docs/design/local-dev.md §2)
//
// LocalChat core (./local-chat.ts) が持つ seam をそのまま ChatPlatform に束ねる。
// 差し替えるのは Runner の配線だけで、Gate 以降には local 専用の分岐を持ち込まない
// (local-dev.md §1)。

import type { ChatPlatform } from "../platform.js";
import type { LocalChat } from "./types.js";

/** LocalChat を ChatPlatform として見せる。
 *
 * - formatter は identity。TUI は素の Markdown をそのまま端末に出す (mrkdwn 変換は
 *   Slack でしか意味を持たない)。
 * - mentionFormat は Slack と同じ `<@id>` 記法。TUI 上でも Agent が mention を
 *   組み立てる挙動をそのまま確認できるようにする (local-dev.md §1: 本物の Agent と
 *   本物の設定で挙動を見る)。 */
export function createLocalPlatform(chat: LocalChat): ChatPlatform {
  return {
    ingress: chat.ingress,
    poster: chat.poster,
    reactor: chat.reactor,
    userResolver: chat.userResolver,
    fetchMessage: chat.fetchMessage,
    mentionFormat: (userId) => `<@${userId}>`,
    formatter: (text) => text,
  };
}
