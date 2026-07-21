// SlackTurnReactor — TurnReactor の Slack 実装。ターン状態 (kick/ok/error) を
// リアクション絵文字 (eyes/white_check_mark/x) に写像し、reactions.add で付ける。
//
// messageId はプラットフォーム中立なメッセージ ID で、Slack では ts として
// reactions.add へ渡す。already_reacted (再実行・再送で同じリアクションを付けようと
// した) は冪等な成功として握りつぶす。それ以外のエラーは呼び出し側に伝播する
// (呼び出し側で warn 継続の判断をする)。

import type { ReactionState, TurnReactor } from "../turn-reactor.js";

/** WebClient.reactions.add の薄い IF。テストではフェイクを注入する */
export interface ReactionClient {
  add(args: {
    channel: string;
    timestamp: string;
    name: string;
  }): Promise<unknown>;
}

const STATE_EMOJI: Record<ReactionState, string> = {
  kick: "eyes",
  ok: "white_check_mark",
  error: "x",
};

export class SlackTurnReactor implements TurnReactor {
  constructor(private readonly client: ReactionClient) {}

  async react(
    channelId: string,
    messageId: string,
    state: ReactionState,
  ): Promise<void> {
    try {
      await this.client.add({
        channel: channelId,
        timestamp: messageId,
        name: STATE_EMOJI[state],
      });
    } catch (err) {
      if (isAlreadyReacted(err)) return;
      throw err;
    }
  }
}

/** @slack/web-api の platform error は err.data.error にエラーコードを持つ */
function isAlreadyReacted(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const data = (err as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return false;
  return (data as { error?: unknown }).error === "already_reacted";
}
