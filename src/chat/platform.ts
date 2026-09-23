// ChatPlatform — 1 つのチャット実装がパイプラインへ差し込む seam の束
// (docs/design/architecture.md §4, docs/design/ingress-egress.md §1)。
//
// Runner (src/runner.ts) はこの型だけを受け取り、背後が Slack なのか in-memory chat
// なのかを知らない。チャット固有の API とデータ構造はこの境界の外に出さない —
// 実装は src/chat/slack.ts (Slack) と src/chat/local/ (in-memory chat + TUI)。
//
// 受信側 (ingress / userResolver / fetchMessage) と送信側 (poster / reactor /
// formatter / mentionFormat) が 1 つの型に同居するのは、どちらも「同じチャット
// 実装の裏表」であり、Runner から見れば 1 つの差し替え単位だから。

import type { ChatPoster, EgressFormatter } from "../egress/router.js";
import type { TurnReactor } from "../egress/turn-reactor.js";
import type { FetchMessage } from "../gate/evaluate.js";
import type { Ingress } from "../ingress/ingress.js";
import type { UserResolver } from "../ingress/user-resolver.js";
import type { MentionFormat } from "../runtime/prompt.js";

export interface ChatPlatform {
  /** 受信の入口 (Socket Mode / Events API / in-memory chat)。 */
  readonly ingress: Ingress;
  /** 返信の投稿と、進捗通知の上書き (ingress-egress.md §5, §8)。 */
  readonly poster: ChatPoster;
  /** Turn 状態をメッセージへ視覚的に返す (ingress-egress.md §7)。 */
  readonly reactor: TurnReactor;
  /** UserID → 表示名の解決 (ingress-egress.md §3)。text 中の mention の
   * 記法もこの実装が持つ (Slack なら `<@U...>` を剥がした `@U...`)。 */
  readonly userResolver: UserResolver;
  /** reaction トリガーの対象メッセージ本文の取得 (config.md §4.1 の `kind: reaction`)。 */
  readonly fetchMessage: FetchMessage;
  /** 返信本文に埋め込む mention の記法 (runtime.md §6)。Agent の system prompt に
   * 出力例として載るため、チャットごとの記法をここで決める。 */
  readonly mentionFormat: MentionFormat;
  /** 投稿前にテキストを通す整形 (Slack なら GFM → mrkdwn。ingress-egress.md §6)。 */
  readonly formatter: EgressFormatter;
}
