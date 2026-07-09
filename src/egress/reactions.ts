// リアクション操作の薄いラッパ — 👀 (処理中) / ✅ (完了) / ❌ (異常終了)
//
// docs/design/architecture.md §6: トリガー発言に :eyes:、完了で :white_check_mark:。
// already_reacted (再実行・再送で同じリアクションを付けようとした) は冪等な成功として
// 握りつぶす。それ以外のエラーは呼び出し側に伝播する (呼び出し側で warn 継続の判断をする)。

/** WebClient.reactions.add の薄い IF。テストではフェイクを注入する */
export interface ReactionClient {
  add(args: {
    channel: string;
    timestamp: string;
    name: string;
  }): Promise<unknown>;
}

export class Reactions {
  constructor(private readonly client: ReactionClient) {}

  /** 処理開始の合図 (トリガーメッセージに 👀) */
  async addEyes(channelId: string, messageTs: string): Promise<void> {
    await this.add(channelId, messageTs, "eyes");
  }

  /** 完了の合図 (トリガーメッセージに ✅) */
  async addCheck(channelId: string, messageTs: string): Promise<void> {
    await this.add(channelId, messageTs, "white_check_mark");
  }

  /** 異常終了の合図 (トリガーメッセージに ❌)。pi のクラッシュ・タイムアウト・
   * コマンド失敗などセッションが正常に完了しなかったことをユーザーに伝える */
  async addX(channelId: string, messageTs: string): Promise<void> {
    await this.add(channelId, messageTs, "x");
  }

  private async add(
    channelId: string,
    messageTs: string,
    name: string,
  ): Promise<void> {
    try {
      await this.client.add({ channel: channelId, timestamp: messageTs, name });
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
