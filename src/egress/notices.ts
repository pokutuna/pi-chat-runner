// チャットへ送る定型通知文 (docs/design/ingress-egress.md)。
//
// Agent へ渡すプロンプト材料ではなく、Runner がユーザーへ直接返す文面なので
// Egress 側に集約する。表記 (`:emoji:`) は現状 Slack mrkdwn 前提。

/** /new コマンドの拒否通知 (実行中セッションへは割り切りで交錯させない、
 * session-model.md §5.1)。abnormalShutdown の noticeText と同じ mrkdwn 絵文字スタイル */
export const REJECT_NOTICE_TEXT =
  ":warning: セッションが実行中のため、いまは /new できません。完了後にもう一度送ってください";

/** /new コマンド (rest なし) の受理通知 */
export const ACK_NOTICE_TEXT =
  ":new: 次のメッセージから新しいセッションを開始します";

/** /disable コマンドの受理通知 (session-model.md §5.2) */
export const DISABLE_NOTICE_TEXT =
  ":no_bell: このチャンネルでの起動を無効化しました。`/enable` (bot へのメンション付き) で再開できます";

/** /enable コマンドの受理通知 (session-model.md §5.2) */
export const ENABLE_NOTICE_TEXT =
  ":bell: このチャンネルでの起動を有効化しました";
