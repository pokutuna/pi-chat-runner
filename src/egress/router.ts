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

  /** 未知の thread_key は warn して捨てる (エージェントの引数間違いでホストを落とさない) */
  async deliver(payload: EgressPayload): Promise<void> {
    const destination = this.destinations.get(payload.thread_key);
    if (destination === undefined) {
      this.logger.warn(
        { threadKey: payload.thread_key },
        "unknown thread_key; dropping reply",
      );
      return;
    }
    try {
      const chunks = chunkMessage(this.formatter(payload.text));
      const parts = chunks.length > 0 ? chunks : [""];
      for (const [i, part] of parts.entries()) {
        const isLast = i === parts.length - 1;
        await this.poster.postMessage(
          destination.channelId,
          part,
          destination.threadTs,
          isLast ? payload.files : undefined,
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

  /** セッション終了時に進捗通知メッセージの記憶を捨てる (次セッションが同じ
   * thread_key を再利用しても古い messageId に update しないようにする) */
  clearProgress(threadKey: string): void {
    this.progressMessageIds.delete(threadKey);
  }
}
