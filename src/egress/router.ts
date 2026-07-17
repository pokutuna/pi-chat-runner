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

function sameDestination(
  left: EgressDestination,
  right: EgressDestination,
): boolean {
  return left.channelId === right.channelId && left.threadTs === right.threadTs;
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
  /** 進捗通知メッセージの進捗キー → messageId (progress-notice.md)。
   * reply の確定出力とは別レーンなので destinations とは別に持つ */
  private readonly progressMessageIds = new Map<string, string>();
  /** 進捗キーごとの直列化キュー。進捗タイマー (notifyProgress) と reply
   * (deliver) が同じ進捗キーに非同期で競合すると、進捗メッセージの
   * messageId 消費と再投稿の順序が入れ替わりうるため、同一進捗キーへの
   * 呼び出しは常に呼ばれた順に完了させる */
  private readonly queues = new Map<string, Promise<unknown>>();
  /** reply が配達された進捗キー (progress-notice.md「進捗レーンの閉鎖」)。
   * deliver は同じキューを通るとはいえ、reply 配達の直後に積まれた進捗タイマーの
   * tick は「配達済みの進捗メッセージが跡形もなく消費された後」の stale な
   * スナップショットであり、そのまま流すと消費済みメッセージの跡地に新規投稿して
   * しまう。deliverNow がこのキーを閉じ、notifyProgressNow は閉じている間
   * 何もしない。次ターン開始時に reopenProgress で再び開く */
  private readonly progressClosed = new Set<string>();
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
   * progressThreadKey は通常 payload.thread_key と同じだが、session.mode=channel の
   * ように進捗通知をセッションキーで出し、reply はメッセージ単位のキーで返す場合に
   * 進捗メッセージとの関連付けに使う。進捗キーを指定した場合は、そのキーのキューで
   * reply も直列化する。
   *
   * progressConsumed: 進捗通知メッセージを reply 本文で上書きできたら true。呼び出し元
   * (SessionRunner) はこれを見て進捗タイマーを即時停止する — agent_end まで待つと、その
   * 間にタイマーが再発火し、上書き済みの進捗メッセージの跡地に新規メッセージを
   * 投稿してしまう (thread_key に紐づく messageId が既に消えているため) */
  async deliver(
    payload: EgressPayload,
    progressThreadKey = payload.thread_key,
  ): Promise<{ progressConsumed: boolean }> {
    return this.enqueue(progressThreadKey, () =>
      this.deliverNow(payload, progressThreadKey),
    );
  }

  private async deliverNow(
    payload: EgressPayload,
    progressThreadKey: string,
  ): Promise<{ progressConsumed: boolean }> {
    // reply の配達が走った時点で、そのターンの以降の進捗 tick は全て stale
    // なので閉じる。destination 未登録 (unknown thread_key) の早期 return
    // より前に行う — 未知の thread_key でも進捗レーンの意味論は変わらない
    this.progressClosed.add(progressThreadKey);
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
          (await this.tryUpdateProgress(progressThreadKey, destination, part))
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
    if (this.progressClosed.has(threadKey)) {
      this.logger.debug(
        { threadKey },
        "progress notice dropped (lane closed by reply)",
      );
      return;
    }
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

  /** reply の最初のチャンクを、進捗キーに対応する進捗通知メッセージが残っており、
   * reply と同じ投稿先ならそれに上書きする (最終回答で「実行中...」が残り続けるのを
   * 避ける)。update できたら true を返し、呼び出し元は新規投稿をスキップする。
   * 進捗メッセージが無い/投稿先が異なる/update に失敗した場合は false を返し、呼び出し元
   * が通常どおり新規投稿する */
  private async tryUpdateProgress(
    progressThreadKey: string,
    replyDestination: EgressDestination,
    text: string,
  ): Promise<boolean> {
    const progressDestination = this.destinations.get(progressThreadKey);
    const messageId = this.progressMessageIds.get(progressThreadKey);
    // session.mode=channel では進捗キーと reply のキーが異なる。実際の投稿先が
    // 同じ場合だけ上書きし、別スレッドの進捗を別の reply で消費しない。
    if (
      progressDestination === undefined ||
      messageId === undefined ||
      !sameDestination(progressDestination, replyDestination)
    )
      return false;
    try {
      await this.poster.updateMessage(
        progressDestination.channelId,
        messageId,
        text,
      );
      this.progressMessageIds.delete(progressThreadKey);
      return true;
    } catch (err) {
      this.logger.warn(
        { threadKey: progressThreadKey, err },
        "progress message update for reply failed; falling back to new post",
      );
      return false;
    }
  }

  /** セッション終了時に進捗通知メッセージの記憶を捨てる (次セッションが同じ
   * thread_key を再利用しても古い messageId に update しないようにする)。
   * notifyProgress/deliver と同じキューを通すことで、既にキュー投入済みだが
   * 未実行のタイマー tick が古い messageId を読む前に消してしまう競合を防ぐ。
   * 進捗レーンの閉鎖も併せて解除し、次セッションが同じキーを再利用したときに
   * 閉鎖状態が残らないようにする */
  async clearProgress(threadKey: string): Promise<void> {
    return this.enqueue(threadKey, () => {
      this.progressMessageIds.delete(threadKey);
      this.progressClosed.delete(threadKey);
      return Promise.resolve();
    });
  }

  /** 新しいターンの開始時に進捗レーンを再び開く (progress-notice.md)。deliver
   * 配達で閉じられたレーンは、reopen するまで notifyProgress を黙って捨て続ける。
   * enqueue 経由にすることで、前ターンの遅延 tick がキューに残っていても
   * reopen より前に処理されて閉鎖中として破棄され、reopen 後に積まれた
   * 新ターンの tick だけが通るようにする */
  async reopenProgress(threadKey: string): Promise<void> {
    return this.enqueue(threadKey, () => {
      this.progressClosed.delete(threadKey);
      return Promise.resolve();
    });
  }
}
