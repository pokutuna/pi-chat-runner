// TurnReactor — ターンの状態を、そのターンを起こしたメッセージへ視覚的に返す port。
//
// docs/design/components.md: 進捗表示 (👀) は Reply レーンとは別レーン。発生源は
// Runner の観測 (agent_end の中身) で、Runner は kick/ok/error という platform 非依存の
// 状態を発するだけ。chat 表現 (Slack ならリアクション絵文字) への写像は platform 実装
// (src/egress/slack/) が持つ — ingress の Ingress vs IngressAdapter と同じ直交。

/** ターンの視覚状態。kick=処理開始 / ok=完走 / error=失敗。
 * 判定結果 (pi-events.ts TurnStatus = "ok" | "error") はこの部分集合。 */
export type ReactionState = "kick" | "ok" | "error";

/** メッセージ単位で「そのターンの状態」をユーザーへ視覚的に返す port。
 * platform ごとに表現が変わる (Slack=リアクション絵文字)。Runner は状態を発する
 * だけで、どう表現されるかを知らない。 */
export interface TurnReactor {
  react(
    channelId: string,
    messageId: string,
    state: ReactionState,
  ): Promise<void>;
}
