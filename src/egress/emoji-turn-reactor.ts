// EmojiTurnReactor — 絵文字リアクションで Turn 状態を返すチャット向けの TurnReactor 実装。
//
// docs/design/ingress-egress.md §7: Runner は start/ok/error という platform 非依存の
// 状態を発するだけで、chat 表現への写像は platform 側が持つ。絵文字リアクションという
// 表現自体は複数の chat で共通なので、写像の器 (状態 → 絵文字名 → reactions.add 相当の
// 呼び出し) をここに置き、絵文字名と呼び出し口だけを platform (src/chat/slack.ts) が渡す。
//
// messageId はプラットフォーム中立なメッセージ ID で、Slack では ts として
// reactions.add へ渡す。already_reacted (再実行・再送で同じリアクションを付けようと
// した) は冪等な成功として握りつぶす。それ以外のエラーは呼び出し側に伝播する
// (呼び出し側で warn 継続の判断をする)。

import type { ReactionState, TurnReactor } from "./turn-reactor.js";

/** `reactions.add` 相当の薄い IF (Slack WebClient.reactions.add の形)。
 * テストや in-memory chat ではフェイクを注入する */
export interface ReactionClient {
  add(args: {
    channel: string;
    timestamp: string;
    name: string;
  }): Promise<unknown>;
}

/** Turn 状態 → 絵文字名の写像。platform ごとに使える絵文字名が違うため注入する */
export type StateEmojiMap = Record<ReactionState, string>;

export class EmojiTurnReactor implements TurnReactor {
  constructor(
    private readonly client: ReactionClient,
    private readonly emoji: StateEmojiMap,
  ) {}

  async react(
    channelId: string,
    messageId: string,
    state: ReactionState,
  ): Promise<void> {
    try {
      await this.client.add({
        channel: channelId,
        timestamp: messageId,
        name: this.emoji[state],
      });
    } catch (err) {
      if (isAlreadyReacted(err)) return;
      throw err;
    }
  }
}

/** platform error は err.data.error にエラーコードを持つ (@slack/web-api の形) */
function isAlreadyReacted(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const data = (err as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return false;
  return (data as { error?: unknown }).error === "already_reacted";
}
