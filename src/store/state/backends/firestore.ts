// Firestore 実装 (docs/design/persistence.md §1 の InboxStore/SessionStore/LeaseStore)
//
// @google-cloud/firestore を使う。Firestore インスタンスは外から渡す
// (エミュレータ分岐を持たない。SDK は FIRESTORE_EMULATOR_HOST が立っていれば
// 自動でそちらへ接続する)。
//
// - inbox: `<prefix>-inbox/{threadKey}/items/{itemId}`。enqueue は create() を使い
//   ALREADY_EXISTS を false に写像する (dedupe。session-model.md §4)。
// - sessions: `<prefix>-sessions/{threadKey}`
// - leases: `<prefix>-leases/{threadKey}`
// - channels: `<prefix>-channels/{channelId}`
//
// drain の順序保証: enqueue 時に `seq` フィールド (injected now() + 同 ms 単調化の
// インスタンス内カウンタ) を書き、`where acked == false` で取得してクライアント側で
// seq ソートする (orderBy を併用すると複合インデックスが必要になるため)。
//
// lease の期限判定は injected `now()` と数値 `expiresAtMs` の比較で行う (サーバ時刻は
// 使わない)。acquire/renew/release は runTransaction で token/owner の一致を確認する
// (sqlite.ts の意味論と同一)。

import type { Firestore, Transaction } from "@google-cloud/firestore";
import { Timestamp } from "@google-cloud/firestore";

import type {
  ChannelStateDoc,
  ChannelStateStore,
  InboxItem,
  InboxStore,
  Lease,
  LeaseStore,
  SessionDoc,
  SessionStore,
  StateStore,
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

interface SessionDocData {
  channelId: string;
  threadTs: string;
  triggerTs: string;
  status: "active" | "finished";
  updatedAt: Timestamp;
  rotateRequestedAt?: Timestamp;
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
    private readonly db: Firestore,
    private readonly collectionName: string,
    private readonly now: () => number,
  ) {}

  private itemsCollection(threadKey: string) {
    return this.db
      .collection(this.collectionName)
      .doc(threadKey)
      .collection("items");
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

  async enqueue(threadKey: string, item: InboxItem): Promise<boolean> {
    const doc: InboxItemDoc = {
      payload: JSON.stringify(item.event),
      enqueuedAt: Timestamp.fromDate(item.enqueuedAt),
      acked: false,
      seq: this.nextSeq(),
    };
    try {
      await this.itemsCollection(threadKey).doc(item.id).create(doc);
      return true;
    } catch (err) {
      if (isAlreadyExists(err)) return false;
      throw err;
    }
  }

  async drain(threadKey: string): Promise<InboxItem[]> {
    // where + orderBy の組は複合インデックスが必要になり、利用者にインデックス
    // 作成を強いる。thread ごとの未 ack は少件数なのでソートはクライアント側で行う
    const snapshot = await this.itemsCollection(threadKey)
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

  async ack(threadKey: string, itemIds: string[]): Promise<void> {
    if (itemIds.length === 0) return;
    const batch = this.db.batch();
    const collection = this.itemsCollection(threadKey);
    for (const itemId of itemIds) {
      batch.update(collection.doc(itemId), { acked: true });
    }
    await batch.commit();
  }
}

class FirestoreSessionStore implements SessionStore {
  constructor(
    private readonly db: Firestore,
    private readonly collectionName: string,
  ) {}

  async get(threadKey: string): Promise<SessionDoc | null> {
    const snap = await this.db
      .collection(this.collectionName)
      .doc(threadKey)
      .get();
    if (!snap.exists) return null;
    const data = snap.data() as SessionDocData;
    return {
      channelId: data.channelId,
      threadTs: data.threadTs,
      triggerTs: data.triggerTs,
      status: data.status,
      updatedAt: data.updatedAt.toDate(),
      ...(data.rotateRequestedAt !== undefined && {
        rotateRequestedAt: data.rotateRequestedAt.toDate(),
      }),
    };
  }

  async put(threadKey: string, doc: SessionDoc): Promise<void> {
    const data: SessionDocData = {
      channelId: doc.channelId,
      threadTs: doc.threadTs,
      triggerTs: doc.triggerTs,
      status: doc.status,
      updatedAt: Timestamp.fromDate(doc.updatedAt),
      // Firestore は undefined フィールドを拒否するため、値がある場合のみ書く
      ...(doc.rotateRequestedAt !== undefined && {
        rotateRequestedAt: Timestamp.fromDate(doc.rotateRequestedAt),
      }),
    };
    await this.db.collection(this.collectionName).doc(threadKey).set(data);
  }
}

class FirestoreChannelStateStore implements ChannelStateStore {
  constructor(
    private readonly db: Firestore,
    private readonly collectionName: string,
  ) {}

  async get(channelId: string): Promise<ChannelStateDoc | null> {
    const snap = await this.db
      .collection(this.collectionName)
      .doc(channelId)
      .get();
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
    await this.db.collection(this.collectionName).doc(channelId).set(data);
  }
}

class FirestoreLeaseStore implements LeaseStore {
  constructor(
    private readonly db: Firestore,
    private readonly collectionName: string,
    private readonly now: () => number,
  ) {}

  private docRef(threadKey: string) {
    return this.db.collection(this.collectionName).doc(threadKey);
  }

  async acquire(
    threadKey: string,
    owner: string,
    ttlMs: number,
  ): Promise<Lease | null> {
    const ref = this.docRef(threadKey);
    return this.db.runTransaction(async (txn: Transaction) => {
      const snap = await txn.get(ref);
      const nowMs = this.now();
      const current = snap.exists ? (snap.data() as LeaseDocData) : undefined;

      if (current !== undefined && current.expiresAtMs > nowMs) return null;

      const token = current === undefined ? 0 : current.token + 1;
      const expiresAtMs = nowMs + ttlMs;
      const data: LeaseDocData = { owner, token, expiresAtMs };
      txn.set(ref, data);

      return {
        threadKey,
        owner,
        token,
        expiresAt: new Date(expiresAtMs),
      };
    });
  }

  async renew(lease: Lease, ttlMs: number): Promise<boolean> {
    const ref = this.docRef(lease.threadKey);
    return this.db.runTransaction(async (txn: Transaction) => {
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
    });
  }

  async release(lease: Lease): Promise<void> {
    const ref = this.docRef(lease.threadKey);
    await this.db.runTransaction(async (txn: Transaction) => {
      const snap = await txn.get(ref);
      if (!snap.exists) return;
      const current = snap.data() as LeaseDocData;
      if (current.token !== lease.token) return;
      txn.delete(ref);
    });
  }
}

/** コレクション名/コンストラクタオプション。 */
export interface FirestoreStateStoreOptions {
  /** コレクション名の接頭辞。既定 "pi-chat-runner"。
   * テストではランダムな値を渡して分離する。 */
  collectionPrefix?: string;
  /** lease の期限判定に使う時計。既定 Date.now。 */
  now?: () => number;
}

export class FirestoreStateStore implements StateStore {
  readonly inbox: InboxStore;
  readonly sessions: SessionStore;
  readonly leases: LeaseStore;
  readonly channels: ChannelStateStore;

  constructor(db: Firestore, options: FirestoreStateStoreOptions = {}) {
    const prefix = options.collectionPrefix ?? "pi-chat-runner";
    const now = options.now ?? Date.now;

    this.inbox = new FirestoreInboxStore(db, `${prefix}-inbox`, now);
    this.sessions = new FirestoreSessionStore(db, `${prefix}-sessions`);
    this.leases = new FirestoreLeaseStore(db, `${prefix}-leases`, now);
    this.channels = new FirestoreChannelStateStore(db, `${prefix}-channels`);
  }
}
