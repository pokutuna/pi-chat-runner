// Control State の Store 群 (docs/design/state.md §3)
//
// InboxStore / SessionStore / ThreadStore / LeaseStore / ChannelStateStore の 5 つを
// 独立したインタフェースとして定義する (1 つの巨大な Store にしない。実装体は 1 つの
// クラスが 5 つを implements してよい)。Dispatcher はこれらを受け取るだけで、
// どの実装かを知らない。
//
// レコードは sessionKey で引く (state.md §2)。sessionKey は Session の識別子で、
// Thread Key (返信先を指すキー) とは別の概念である。

import type { InboundMessage } from "../../ingress/chat-event.js";

/** InboxStore が保持する 1 件の入力イベント。 */
export interface InboxItem {
  /** dedupe キー。Slack event_id (metadata.eventId)、無ければメッセージ ID (event.id) */
  id: string;
  event: InboundMessage;
  enqueuedAt: Date;
}

/** イベントの耐久キュー。enqueue は dedupe を兼ねる (message-dispatch.md §8)。 */
export interface InboxStore {
  /** 積めたら true。同 id が既に見えていれば (ack 後も) 積まず false。
   * at-least-once の再送を吸収する冪等操作。 */
  enqueue(sessionKey: string, item: InboxItem): Promise<boolean>;
  /** 未 ack の item を全件、enqueue 順に返す。削除しない (同じ item が再度返りうる)。 */
  drain(sessionKey: string): Promise<InboxItem[]>;
  /** 処理完了の確定。以後この itemIds は drain に出ない。
   * dedupe の「見た」記憶は ack 後も保持する。 */
  ack(sessionKey: string, itemIds: string[]): Promise<void>;
}

/** sessionKey ごとの Session の実行状況 (state.md §3.2)。 */
export interface SessionRecord {
  channelId: string;
  threadTs: string;
  /** Session を起こしたトリガーメッセージの ID (Session の同一性) */
  triggerMessageId: string;
  startedAt: Date;
  lastActiveAt: Date;
  /** Turn の完了で Session が畳まれた時刻。undefined = 稼働中 (生死の真実は lease 側) */
  endedAt?: Date;
  /** 明示的な新規 Session 要求 (/new) の時刻。次の起動が消費してクリアする */
  rotateRequestedAt?: Date;
}

export interface SessionStore {
  get(sessionKey: string): Promise<SessionRecord | null>;
  put(sessionKey: string, record: SessionRecord): Promise<void>;
}

/** Thread と Session の対応、および Channel の最新 Session へのポインタ
 * (state.md §3.3、message-dispatch.md §3.1/§3.2)。 */
export interface ThreadStore {
  /** Thread から導出した sessionKey (derivedSessionKey) → 合流先 sessionKey。
   * 未登録なら null */
  resolve(derivedSessionKey: string): Promise<string | null>;
  bind(derivedSessionKey: string, sessionKey: string): Promise<void>;
  /** Channel の最新 Session (affinity の合流候補)。未登録なら null */
  latest(channelId: string): Promise<ChannelLatestSession | null>;
  /** Session の発生・Turn の進行で呼ぶ。endedAt はクリアされる */
  touchLatest(channelId: string, sessionKey: string): Promise<void>;
  /** Session の終了で呼ぶ。最新が別 Session を指していれば何もしない
   * (古い Session の終了で「最後に活動した Session」を巻き戻さない) */
  markLatestEnded(channelId: string, sessionKey: string): Promise<void>;
}

/** Channel の最新 Session。affinity の合流候補を探すときに読む。 */
export interface ChannelLatestSession {
  sessionKey: string;
  lastActiveAt: Date;
  /** undefined = 稼働中 (生死の真実は lease 側) */
  endedAt?: Date;
}

/** 実行ロック。TTL 付き lease で多重起動を排他する (message-dispatch.md §6)。 */
export interface Lease {
  sessionKey: string;
  owner: string;
  /** fencing token。acquire (奪取含む) ごとに単調増加。 */
  token: number;
  expiresAt: Date;
}

export interface LeaseStore {
  /** 取得を試みる。有効な lease が既にあれば null (CAS 的取得)。
   * 期限切れの lease は奪える (token を増やして再発行)。 */
  acquire(
    sessionKey: string,
    owner: string,
    ttlMs: number,
  ): Promise<Lease | null>;
  /** 延長。渡した lease の token/owner が現行の lease と一致し、かつ期限切れでなければ
   * true を返して期限を延ばす。不一致・期限切れなら false (fencing)。 */
  renew(lease: Lease, ttlMs: number): Promise<boolean>;
  /** token が現行の lease と一致するときのみ削除する。不一致なら何もしない。 */
  release(lease: Lease): Promise<void>;
}

/** チャンネル単位の実行時状態 (session-model.md §5.2 のチャンネル mute)。
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

/** 5 Store をまとめて提供する束。実装体は 1 つのオブジェクトでよい (state.md §3)。 */
export interface ControlState {
  inbox: InboxStore;
  sessions: SessionStore;
  threads: ThreadStore;
  leases: LeaseStore;
  channels: ChannelStateStore;
}
