// Firestore 実装 (docs/design/state.md §4.2)
//
// @google-cloud/firestore を使う。Firestore インスタンスは外から渡す
// (エミュレータ分岐を持たない。SDK は FIRESTORE_EMULATOR_HOST が立っていれば
// 自動でそちらへ接続する)。
//
// 全コレクションは親ドキュメント (rootDoc、既定 "pi-chat-runner/default") の
// サブコレクションに置く。既存プロジェクトの Firestore に同居してもトップレベルを
// 散らかさないため (state.md §4.2)。親ドキュメント自体は書かない (Firestore は
// 実体のない親の下にサブコレクションを置ける。コンソールでは斜体表示になる)。
//
// - inbox: `<rootDoc>/inbox/{sessionKey}/items/{itemId}`。enqueue は create() を使い
//   ALREADY_EXISTS を false に写像する (dedupe。message-dispatch.md §8)。
// - sessions: `<rootDoc>/sessions/{sessionKey}`
// - threads: `<rootDoc>/threads/{threadKey}`
// - channel latest: `<rootDoc>/channel_latest/{channelId}`
// - leases: `<rootDoc>/leases/{sessionKey}`
// - channels: `<rootDoc>/channels/{channelId}`
//
// drain の順序保証: enqueue 時に `seq` フィールド (injected now() + 同 ms 単調化の
// インスタンス内カウンタ) を書き、`where acked == false` で取得してクライアント側で
// seq ソートする (orderBy を併用すると複合インデックスが必要になるため)。
//
// lease の期限判定は injected `now()` と数値 `expiresAtMs` の比較で行う (サーバ時刻は
// 使わない)。acquire/renew/release は runTransaction で token/owner の一致を確認する
// (sqlite.ts の意味論と同一)。

import type {
  CollectionReference,
  Firestore,
  Transaction,
} from "@google-cloud/firestore";
import { Timestamp } from "@google-cloud/firestore";

import type {
  ChannelLatestSession,
  ChannelStateDoc,
  ChannelStateStore,
  ControlState,
  InboxItem,
  InboxStore,
  Lease,
  LeaseStore,
  SessionRecord,
  SessionStore,
  ThreadStore,
} from "../interfaces.js";
import { parseInboundMessage } from "./serialize.js";

/** Firestore の gRPC ステータスコード。ALREADY_EXISTS = 6。
 * https://cloud.google.com/apis/design/errors#error_model */
const GRPC_ALREADY_EXISTS = 6;

function isAlreadyExists(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === GRPC_ALREADY_EXISTS
  );
}

interface InboxItemDoc {
  payload: string;
  enqueuedAt: Timestamp;
  acked: boolean;
  seq: number;
}

/** 永続ドキュメントの生の形。SessionRecord の Date フィールドを Timestamp にした形。 */
interface SessionRecordData {
  channelId: string;
  threadTs: string;
  triggerMessageId: string;
  startedAt: Timestamp;
  lastActiveAt: Timestamp;
  endedAt?: Timestamp;
  rotateRequestedAt?: Timestamp;
}

interface ThreadDocData {
  sessionKey: string;
}

interface ChannelLatestData {
  sessionKey: string;
  lastActiveAt: Timestamp;
  endedAt?: Timestamp;
}

interface LeaseDocData {
  owner: string;
  token: number;
  expiresAtMs: number;
}

interface ChannelStateDocData {
  enabled: boolean;
  updatedAt: Timestamp;
  updatedBy?: string;
}

class FirestoreInboxStore implements InboxStore {
  /** enqueue 時の seq 単調化用。同一 ms 内の enqueue で衝突しないようにする。 */
  private lastSeqMs = -1;
  private seqCounter = 0;

  constructor(
    private readonly collection: CollectionReference,
    private readonly now: () => number,
  ) {}

  private itemsCollection(sessionKey: string) {
    return this.collection.doc(sessionKey).collection("items");
  }

  private nextSeq(): number {
    const nowMs = this.now();
    if (nowMs === this.lastSeqMs) {
      this.seqCounter += 1;
    } else {
      this.lastSeqMs = nowMs;
      this.seqCounter = 0;
    }
    return nowMs + this.seqCounter;
  }

  async enqueue(sessionKey: string, item: InboxItem): Promise<boolean> {
    const doc: InboxItemDoc = {
      payload: JSON.stringify(item.event),
      enqueuedAt: Timestamp.fromDate(item.enqueuedAt),
      acked: false,
      seq: this.nextSeq(),
    };
    try {
      await this.itemsCollection(sessionKey).doc(item.id).create(doc);
      return true;
    } catch (err) {
      if (isAlreadyExists(err)) return false;
      throw err;
    }
  }

  async drain(sessionKey: string): Promise<InboxItem[]> {
    // where + orderBy の組は複合インデックスが必要になり、利用者にインデックス
    // 作成を強いる。session ごとの未 ack は少件数なのでソートはクライアント側で行う
    const snapshot = await this.itemsCollection(sessionKey)
      .where("acked", "==", false)
      .get();
    return snapshot.docs
      .map((docSnap) => {
        const data = docSnap.data() as InboxItemDoc;
        return {
          item: {
            id: docSnap.id,
            event: parseInboundMessage(data.payload),
            enqueuedAt: data.enqueuedAt.toDate(),
          },
          seq: data.seq,
        };
      })
      .sort((a, b) => a.seq - b.seq)
      .map(({ item }) => item);
  }

  async ack(sessionKey: string, itemIds: string[]): Promise<void> {
    if (itemIds.length === 0) return;
    const batch = this.collection.firestore.batch();
    const collection = this.itemsCollection(sessionKey);
    for (const itemId of itemIds) {
      batch.update(collection.doc(itemId), { acked: true });
    }
    await batch.commit();
  }
}

class FirestoreSessionStore implements SessionStore {
  constructor(private readonly collection: CollectionReference) {}

  async get(sessionKey: string): Promise<SessionRecord | null> {
    const snap = await this.collection.doc(sessionKey).get();
    if (!snap.exists) return null;
    const data = snap.data() as SessionRecordData;
    return {
      channelId: data.channelId,
      threadTs: data.threadTs,
      triggerMessageId: data.triggerMessageId,
      startedAt: data.startedAt.toDate(),
      lastActiveAt: data.lastActiveAt.toDate(),
      ...(data.endedAt !== undefined && { endedAt: data.endedAt.toDate() }),
      ...(data.rotateRequestedAt !== undefined && {
        rotateRequestedAt: data.rotateRequestedAt.toDate(),
      }),
    };
  }

  async put(sessionKey: string, record: SessionRecord): Promise<void> {
    const data: SessionRecordData = {
      channelId: record.channelId,
      threadTs: record.threadTs,
      triggerMessageId: record.triggerMessageId,
      startedAt: Timestamp.fromDate(record.startedAt),
      lastActiveAt: Timestamp.fromDate(record.lastActiveAt),
      // Firestore は undefined フィールドを拒否するため、値がある場合のみ書く
      ...(record.endedAt !== undefined && {
        endedAt: Timestamp.fromDate(record.endedAt),
      }),
      ...(record.rotateRequestedAt !== undefined && {
        rotateRequestedAt: Timestamp.fromDate(record.rotateRequestedAt),
      }),
    };
    await this.collection.doc(sessionKey).set(data);
  }
}

class FirestoreThreadStore implements ThreadStore {
  constructor(
    private readonly threads: CollectionReference,
    private readonly channelLatest: CollectionReference,
    private readonly now: () => number,
  ) {}

  async resolve(threadKey: string): Promise<string | null> {
    const snap = await this.threads.doc(threadKey).get();
    if (!snap.exists) return null;
    return (snap.data() as ThreadDocData).sessionKey;
  }

  async bind(threadKey: string, sessionKey: string): Promise<void> {
    const data: ThreadDocData = { sessionKey };
    await this.threads.doc(threadKey).set(data);
  }

  async latest(channelId: string): Promise<ChannelLatestSession | null> {
    const snap = await this.channelLatest.doc(channelId).get();
    if (!snap.exists) return null;
    const data = snap.data() as ChannelLatestData;
    return {
      sessionKey: data.sessionKey,
      lastActiveAt: data.lastActiveAt.toDate(),
      ...(data.endedAt !== undefined && { endedAt: data.endedAt.toDate() }),
    };
  }

  async touchLatest(channelId: string, sessionKey: string): Promise<void> {
    // endedAt は書かない = クリアする (set は doc を丸ごと置き換える)
    const data: ChannelLatestData = {
      sessionKey,
      lastActiveAt: Timestamp.fromMillis(this.now()),
    };
    await this.channelLatest.doc(channelId).set(data);
  }

  async markLatestEnded(channelId: string, sessionKey: string): Promise<void> {
    const ref = this.channelLatest.doc(channelId);
    await this.channelLatest.firestore.runTransaction(
      async (txn: Transaction) => {
        const snap = await txn.get(ref);
        if (!snap.exists) return;
        const current = snap.data() as ChannelLatestData;
        if (current.sessionKey !== sessionKey) return;
        const endedAt = Timestamp.fromMillis(this.now());
        const data: ChannelLatestData = {
          sessionKey,
          lastActiveAt: endedAt,
          endedAt,
        };
        txn.set(ref, data);
      },
    );
  }
}

class FirestoreChannelStateStore implements ChannelStateStore {
  constructor(private readonly collection: CollectionReference) {}

  async get(channelId: string): Promise<ChannelStateDoc | null> {
    const snap = await this.collection.doc(channelId).get();
    if (!snap.exists) return null;
    const data = snap.data() as ChannelStateDocData;
    return {
      enabled: data.enabled,
      updatedAt: data.updatedAt.toDate(),
      ...(data.updatedBy !== undefined && { updatedBy: data.updatedBy }),
    };
  }

  async put(channelId: string, doc: ChannelStateDoc): Promise<void> {
    const data: ChannelStateDocData = {
      enabled: doc.enabled,
      updatedAt: Timestamp.fromDate(doc.updatedAt),
      // Firestore は undefined フィールドを拒否するため、値がある場合のみ書く
      ...(doc.updatedBy !== undefined && { updatedBy: doc.updatedBy }),
    };
    await this.collection.doc(channelId).set(data);
  }
}

class FirestoreLeaseStore implements LeaseStore {
  constructor(
    private readonly collection: CollectionReference,
    private readonly now: () => number,
  ) {}

  private docRef(sessionKey: string) {
    return this.collection.doc(sessionKey);
  }

  async acquire(
    sessionKey: string,
    owner: string,
    ttlMs: number,
  ): Promise<Lease | null> {
    const ref = this.docRef(sessionKey);
    return this.collection.firestore.runTransaction(
      async (txn: Transaction) => {
        const snap = await txn.get(ref);
        const nowMs = this.now();
        const current = snap.exists ? (snap.data() as LeaseDocData) : undefined;

        if (current !== undefined && current.expiresAtMs > nowMs) return null;

        const token = current === undefined ? 0 : current.token + 1;
        const expiresAtMs = nowMs + ttlMs;
        const data: LeaseDocData = { owner, token, expiresAtMs };
        txn.set(ref, data);

        return {
          sessionKey,
          owner,
          token,
          expiresAt: new Date(expiresAtMs),
        };
      },
    );
  }

  async renew(lease: Lease, ttlMs: number): Promise<boolean> {
    const ref = this.docRef(lease.sessionKey);
    return this.collection.firestore.runTransaction(
      async (txn: Transaction) => {
        const snap = await txn.get(ref);
        if (!snap.exists) return false;
        const current = snap.data() as LeaseDocData;
        const nowMs = this.now();
        if (current.token !== lease.token || current.owner !== lease.owner) {
          return false;
        }
        if (current.expiresAtMs <= nowMs) return false;

        const data: LeaseDocData = {
          owner: current.owner,
          token: current.token,
          expiresAtMs: nowMs + ttlMs,
        };
        txn.set(ref, data);
        return true;
      },
    );
  }

  async release(lease: Lease): Promise<void> {
    const ref = this.docRef(lease.sessionKey);
    await this.collection.firestore.runTransaction(async (txn: Transaction) => {
      const snap = await txn.get(ref);
      if (!snap.exists) return;
      const current = snap.data() as LeaseDocData;
      if (current.token !== lease.token) return;
      txn.delete(ref);
    });
  }
}

/** コンストラクタオプション。 */
export interface FirestoreControlStateOptions {
  /** 全コレクションを収める親ドキュメントのパス。既定 "pi-chat-runner/default"。
   * テストではランダムなパスを渡して分離する。 */
  rootDoc?: string;
  /** lease / channel latest の時刻に使う時計。既定 Date.now。 */
  now?: () => number;
}

export class FirestoreControlState implements ControlState {
  readonly inbox: InboxStore;
  readonly sessions: SessionStore;
  readonly threads: ThreadStore;
  readonly leases: LeaseStore;
  readonly channels: ChannelStateStore;

  constructor(db: Firestore, options: FirestoreControlStateOptions = {}) {
    const root = db.doc(options.rootDoc ?? "pi-chat-runner/default");
    const now = options.now ?? Date.now;

    this.inbox = new FirestoreInboxStore(root.collection("inbox"), now);
    this.sessions = new FirestoreSessionStore(root.collection("sessions"));
    this.threads = new FirestoreThreadStore(
      root.collection("threads"),
      root.collection("channel_latest"),
      now,
    );
    this.leases = new FirestoreLeaseStore(root.collection("leases"), now);
    this.channels = new FirestoreChannelStateStore(root.collection("channels"));
  }
}
