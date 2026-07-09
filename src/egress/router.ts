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

/** WebClient.chat.postMessage の薄い IF。テストではフェイクを注入する。
 * files は添付するローカルファイルの絶対パス配列 */
export interface ChatPoster {
  postMessage(
    channelId: string,
    text: string,
    threadTs?: string,
    files?: string[],
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
}
