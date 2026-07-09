// EgressRouter — thread_key → 投稿先の解決と postMessage
//
// エージェントの確定出力は reply(thread_key, text) ツール経由の 1 本のみで、
// ホストが tool_execution_end を拾ってここへ流す (docs/design/architecture.md §6 フロー 5、
// docs/design/chat-model.md §5)。formatter フックで GFM → mrkdwn 変換を差す
// (Slack 配線は bridge.ts が toMrkdwn を注入する)。未注入時は identity。

import type { Logger } from "../logger.js";
import { rootLogger } from "../logger.js";
import { chunkMessage } from "./chunker.js";

/** reply ツールの引数 (extensions/reply.ts が details に詰めて返す形)。
 * files は runner が workdir 境界チェック済みの絶対パスに解決してから積む */
export interface EgressPayload {
  thread_key: string;
  text: string;
  files?: string[];
}

/** 投稿先。Slack の会話座標は (channelId, threadTs) の 2 つだけ (architecture.md §0)。
 * threadTs は省略時はチャンネル直下に投稿する (reply.mode: flat) */
export interface EgressDestination {
  channelId: string;
  threadTs?: string;
}

/** WebClient.chat.postMessage/chat.update の薄い IF。テストではフェイクを注入する。
 * files は添付するローカルファイルの絶対パス配列。
 * postMessage の戻り値 messageId は「後から更新できる識別子」の共通抽象
 * (Slack: ts、Discord: message id 等)。進捗通知 (progress-notice.md) が
 * updateMessage でこの識別子を使って同一メッセージを上書きする */
export interface ChatPoster {
  postMessage(
    channelId: string,
    text: string,
    threadTs?: string,
    files?: string[],
  ): Promise<{ messageId: string }>;
  updateMessage(
    channelId: string,
    messageId: string,
    text: string,
  ): Promise<void>;
}

export type EgressFormatter = (text: string) => string;

export interface EgressRouterOptions {
  poster: ChatPoster;
  /** 投稿前にテキストを通すフック。省略時は identity */
  formatter?: EgressFormatter;
  logger?: Logger;
}

export class EgressRouter {
  private readonly destinations = new Map<string, EgressDestination>();
  /** 進捗通知メッセージの thread_key → messageId (progress-notice.md)。
   * reply の確定出力とは別レーンなので destinations とは別に持つ */
  private readonly progressMessageIds = new Map<string, string>();
  /** thread_key ごとの直列化キュー。進捗タイマー (notifyProgress) と reply
   * (deliver) が同じ thread_key に非同期で競合すると、進捗メッセージの
   * messageId 消費と再投稿の順序が入れ替わりうるため、同一 thread_key への
   * 呼び出しは常に呼ばれた順に完了させる */
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly poster: ChatPoster;
  private readonly formatter: EgressFormatter;
  private readonly logger: Logger;

  constructor(options: EgressRouterOptions) {
    this.poster = options.poster;
    this.formatter = options.formatter ?? ((text) => text);
    this.logger = options.logger ?? rootLogger.child({ component: "egress" });
  }

  register(threadKey: string, destination: EgressDestination): void {
    this.destinations.set(threadKey, destination);
  }

  private enqueue<T>(threadKey: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(threadKey) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.queues.set(
      threadKey,
      next.catch(() => {}),
    );
    return next;
  }

  /** 未知の thread_key は warn して捨てる (エージェントの引数間違いでホストを落とさない)。
   * progressConsumed: 進捗通知メッセージを reply 本文で上書きできたら true。呼び出し元
   * (SessionRunner) はこれを見て進捗タイマーを即時停止する — agent_end まで待つと、その
   * 間にタイマーが再発火し、上書き済みの進捗メッセージの跡地に新規メッセージを
   * 投稿してしまう (thread_key に紐づく messageId が既に消えているため) */
  async deliver(
    payload: EgressPayload,
  ): Promise<{ progressConsumed: boolean }> {
    return this.enqueue(payload.thread_key, () => this.deliverNow(payload));
  }

  private async deliverNow(
    payload: EgressPayload,
  ): Promise<{ progressConsumed: boolean }> {
    const destination = this.destinations.get(payload.thread_key);
    if (destination === undefined) {
      this.logger.warn(
        { threadKey: payload.thread_key },
        "unknown thread_key; dropping reply",
      );
      return { progressConsumed: false };
    }
    let progressConsumed = false;
    try {
      const chunks = chunkMessage(this.formatter(payload.text));
      const parts = chunks.length > 0 ? chunks : [""];
      for (const [i, part] of parts.entries()) {
        const isFirst = i === 0;
        const isLast = i === parts.length - 1;
        const files = isLast ? payload.files : undefined;
        // updateMessage は files 添付に対応しないため、files を伴うチャンクは
        // 進捗メッセージの上書き対象にしない (常に新規投稿する)
        if (
          isFirst &&
          files === undefined &&
          (await this.tryUpdateProgress(payload.thread_key, part))
        ) {
          progressConsumed = true;
          continue;
        }
        await this.poster.postMessage(
          destination.channelId,
          part,
          destination.threadTs,
          files,
        );
      }
      this.logger.info(
        {
          threadKey: payload.thread_key,
          textLength: payload.text.length,
          filesCount: payload.files?.length ?? 0,
          chunks: parts.length,
        },
        "reply delivered",
      );
      return { progressConsumed };
    } catch (err) {
      this.logger.error(
        { threadKey: payload.thread_key, err },
        "reply post failed",
      );
      throw err;
    }
  }

  /** 長時間ターンの進捗スナップショット (progress-notice.md)。reply とは別レーンの
   * 単一メッセージで、初回は新規投稿、以降は同じメッセージを上書きする。formatter は
   * 通さない (ツール名程度の短い定型文で、GFM→mrkdwn 変換を要さない)。
   * 未知の thread_key は deliver と同様 warn して捨てる */
  async notifyProgress(threadKey: string, text: string): Promise<void> {
    return this.enqueue(threadKey, () =>
      this.notifyProgressNow(threadKey, text),
    );
  }

  private async notifyProgressNow(
    threadKey: string,
    text: string,
  ): Promise<void> {
    const destination = this.destinations.get(threadKey);
    if (destination === undefined) {
      this.logger.warn(
        { threadKey },
        "unknown thread_key; dropping progress notice",
      );
      return;
    }
    try {
      const existingMessageId = this.progressMessageIds.get(threadKey);
      if (existingMessageId !== undefined) {
        await this.poster.updateMessage(
          destination.channelId,
          existingMessageId,
          text,
        );
        return;
      }
      const { messageId } = await this.poster.postMessage(
        destination.channelId,
        text,
        destination.threadTs,
      );
      this.progressMessageIds.set(threadKey, messageId);
    } catch (err) {
      this.logger.warn({ threadKey, err }, "progress notice post failed");
    }
  }

  /** reply の最初のチャンクを、同じ thread_key に進捗通知メッセージが残っていれば
   * それに上書きする (最終回答で「実行中...」が残り続けるのを避ける)。update できたら
   * true を返し、呼び出し元は新規投稿をスキップする。進捗メッセージが無い/update に
   * 失敗した場合は false を返し、呼び出し元が通常どおり新規投稿する */
  private async tryUpdateProgress(
    threadKey: string,
    text: string,
  ): Promise<boolean> {
    const destination = this.destinations.get(threadKey);
    const messageId = this.progressMessageIds.get(threadKey);
    if (destination === undefined || messageId === undefined) return false;
    try {
      await this.poster.updateMessage(destination.channelId, messageId, text);
      this.progressMessageIds.delete(threadKey);
      return true;
    } catch (err) {
      this.logger.warn(
        { threadKey, err },
        "progress message update for reply failed; falling back to new post",
      );
      return false;
    }
  }

  /** セッション終了時に進捗通知メッセージの記憶を捨てる (次セッションが同じ
   * thread_key を再利用しても古い messageId に update しないようにする)。
   * notifyProgress/deliver と同じキューを通すことで、既にキュー投入済みだが
   * 未実行のタイマー tick が古い messageId を読む前に消してしまう競合を防ぐ */
  async clearProgress(threadKey: string): Promise<void> {
    return this.enqueue(threadKey, () => {
      this.progressMessageIds.delete(threadKey);
      return Promise.resolve();
    });
  }
}
