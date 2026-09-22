// チャットへ送る定型通知文と、その中で使う絵文字表記 (docs/design/ingress-egress.md §7, §8)。
//
// Agent へ渡すプロンプト材料ではなく、Runner がユーザーへ直接返す文面なので
// Egress 側に集約する。表記 (`:emoji:`) は現状 Slack mrkdwn 前提で、platform ごとの
// 描画に差し替えるための 1 箇所としてここに集める — Dispatcher / Session /
// ProgressNotice は文面と絵文字名を自分では組まず、この定数と関数だけを使う。

/** `/new` コマンドの拒否通知 (実行中 Session へは割り切りで交錯させない、
 * session-model.md §5.1)。abnormalShutdown の noticeText と同じ mrkdwn 絵文字スタイル */
export const REJECT_NOTICE_TEXT =
  ":warning: セッションが実行中のため、いまは /new できません。完了後にもう一度送ってください";

/** `/new` コマンド (rest なし) の受理通知 */
export const ACK_NOTICE_TEXT =
  ":new: 次のメッセージから新しいセッションを開始します";

/** `/disable` コマンドの受理通知 (session-model.md §5.2) */
export const DISABLE_NOTICE_TEXT =
  ":no_bell: このチャンネルでの起動を無効化しました。`/enable` (bot へのメンション付き) で再開できます";

/** `/enable` コマンドの受理通知 (session-model.md §5.2) */
export const ENABLE_NOTICE_TEXT =
  ":bell: このチャンネルでの起動を有効化しました";

/** Session が異常終了したことの通知 (message-dispatch.md §7.4)。pi が「動けない」と
 * 応答したケース (認証エラー等) で、Session を畳む前にユーザーへ返す */
export function sessionFailedNoticeText(error: string | undefined): string {
  return `:warning: セッションが異常終了しました: ${error ?? "unknown error"}`;
}

/** Turn が turnTimeoutMs を超過して Session を畳むことの通知 (message-dispatch.md §7.4) */
export function turnTimeoutNoticeText(turnTimeoutMs: number): string {
  return `:warning: ターンがタイムアウトしました (${turnTimeoutMs}ms)。セッションを終了します`;
}

/** ツール実行の絵文字が決まらないときの既定 (進捗通知、ingress-egress.md §8) */
export const PROGRESS_DEFAULT_EMOJI = ":gear:";

/** ファイル読み取り系ツール (read/grep/find/ls) の絵文字 */
export const PROGRESS_READ_EMOJI = ":mag:";

/** ファイル書き込み系ツール (write/edit) の絵文字 */
export const PROGRESS_WRITE_EMOJI = ":memo:";

/** bash の絵文字候補。頻出のため呼び出しごとに 1 つ選び、単調な見た目にならない
 * ようにする (ingress-egress.md §8) */
export const PROGRESS_BASH_EMOJIS = [
  ":computer:",
  ":keyboard:",
  ":zap:",
  ":gear:",
  ":hammer_and_wrench:",
  ":rocket:",
  ":robot_face:",
  ":satellite:",
];

/** ツール実行がまだ観測できていない (Turn 開始直後) 段階の進捗表示
 * (ingress-egress.md §8) */
export function progressThinkingText(step: number): string {
  return `:thinking_face: ... (step ${step})`;
}

/** 直近のツール実行スナップショットの進捗表示 (ingress-egress.md §8)。
 * argsPreview が空なら引数部分を省く */
export function progressToolText(args: {
  emoji: string;
  toolName: string;
  argsPreview: string;
  step: number;
}): string {
  const { emoji, toolName, argsPreview, step } = args;
  return argsPreview === ""
    ? `${emoji} \`${toolName}\` ... (step ${step})`
    : `${emoji} \`${toolName}\` \`${argsPreview}\` ... (step ${step})`;
}
