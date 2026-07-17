// 永続化 Store の抽象 (docs/design/persistence.md §1)
//
// InboxStore / SessionStore / LeaseStore / ChannelStateStore の 4 つを独立したインタフェースとして
// 定義する (1 つの巨大な Store にしない。実装体は 1 つのクラスが 4 つを implements してよい)。
// SessionRunner はこれらを受け取るだけで、どの実装かを知らない。

import type { InboundMessage } from "../../ingress/chat-event.js";

/** InboxStore が保持する 1 件の入力イベント。 */
export interface InboxItem {
  /** dedupe キー。Slack event_id (metadata.eventId)、無ければ message ts (event.id) */
  id: string;
  event: InboundMessage;
  enqueuedAt: Date;
}

/** イベントの耐久キュー。enqueue は dedupe を兼ねる (session-model.md §4)。 */
export interface InboxStore {
  /** 積めたら true。同 id が既に見えていれば (ack 後も) 積まず false。
   * at-least-once の再送を吸収する冪等操作。 */
  enqueue(threadKey: string, item: InboxItem): Promise<boolean>;
  /** 未 ack の item を全件、enqueue 順に返す。削除しない (同じ item が再度返りうる)。 */
  drain(threadKey: string): Promise<InboxItem[]>;
  /** 処理完了の確定。以後この itemIds は drain に出ない。
   * dedupe の「見た」記憶は ack 後も保持する。 */
  ack(threadKey: string, itemIds: string[]): Promise<void>;
}

/** thread_key ごとのセッション状態 (session-model.md §9 の状態機械の永続部分)。 */
export interface SessionDoc {
  channelId: string;
  threadTs: string;
  triggerTs: string;
  // TODO: status は書かれるだけで読まれていない (どこも .status を参照しない)。
  // 実際の再開判定は workdir/session.jsonl の有無で決まる。design (session-model.md
  // §6) の resume_pending/suspended を含む状態機械を実装するまでは死んでいる値。
  status: "active" | "finished";
  updatedAt: Date;
  /** /new コマンドによる transcript 世代交代の要求時刻。次の kick が消費してクリアする */
  rotateRequestedAt?: Date;
}

export interface SessionStore {
  get(threadKey: string): Promise<SessionDoc | null>;
  put(threadKey: string, doc: SessionDoc): Promise<void>;
}

/** 実行ロック。TTL 付き lease で多重起動を排他する (session-model.md §4)。 */
export interface Lease {
  threadKey: string;
  owner: string;
  /** fencing token。acquire (奪取含む) ごとに単調増加。 */
  token: number;
  expiresAt: Date;
}

export interface LeaseStore {
  /** 取得を試みる。有効な lease が既にあれば null (CAS 的取得)。
   * 期限切れの lease は奪える (token を増やして再発行)。 */
  acquire(
    threadKey: string,
    owner: string,
    ttlMs: number,
  ): Promise<Lease | null>;
  /** 延長。渡した lease の token/owner が現行の lease と一致し、かつ期限切れでなければ
   * true を返して期限を延ばす。不一致・期限切れなら false (fencing)。 */
  renew(lease: Lease, ttlMs: number): Promise<boolean>;
  /** token が現行の lease と一致するときのみ削除する。不一致なら何もしない。 */
  release(lease: Lease): Promise<void>;
}

/** チャンネル単位の実行時状態 (session-model.md §5 のチャンネル mute)。
 * doc が無い = enabled が既定。チャットの /enable /disable コマンドで書き換わる */
export interface ChannelStateDoc {
  enabled: boolean;
  updatedAt: Date;
  /** 最後に切り替えた送信者 id (監査用) */
  updatedBy?: string;
}

export interface ChannelStateStore {
  get(channelId: string): Promise<ChannelStateDoc | null>;
  put(channelId: string, doc: ChannelStateDoc): Promise<void>;
}

/** 4 Store をまとめて提供する束。実装体は 1 つのオブジェクトでよい。 */
export interface StateStore {
  inbox: InboxStore;
  sessions: SessionStore;
  leases: LeaseStore;
  channels: ChannelStateStore;
}
