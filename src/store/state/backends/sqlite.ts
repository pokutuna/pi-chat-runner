// SQLite 実装 (docs/design/persistence.md §1 の InboxStore/SessionStore/LeaseStore)
//
// better-sqlite3 は同期 API。IF は Promise なので async メソッドで包むだけでよい。
// 1 ファイル (":memory:" も可)。ローカルで永続化・排他込みの動作確認に使う想定。

import Database from "better-sqlite3";

import type {
  InboxItem,
  InboxStore,
  Lease,
  LeaseStore,
  SessionDoc,
  SessionStore,
  StateStore,
} from "../interfaces.js";
import { parseInboundMessage } from "./serialize.js";

interface InboxRow {
  item_id: string;
  payload: string;
  enqueued_at: string;
}

interface SessionRow {
  doc: string;
}

interface LeaseRow {
  owner: string;
  token: number;
  expires_at: number;
}

class SqliteInboxStore implements InboxStore {
  constructor(private readonly db: Database.Database) {}

  async enqueue(threadKey: string, item: InboxItem): Promise<boolean> {
    const payload = JSON.stringify(item.event);
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO inbox_items (thread_key, item_id, payload, enqueued_at, acked)
				 VALUES (?, ?, ?, ?, 0)`,
      )
      .run(threadKey, item.id, payload, item.enqueuedAt.toISOString());
    return result.changes > 0;
  }

  async drain(threadKey: string): Promise<InboxItem[]> {
    const rows = this.db
      .prepare(
        `SELECT item_id, payload, enqueued_at FROM inbox_items
				 WHERE thread_key = ? AND acked = 0
				 ORDER BY rowid ASC`,
      )
      .all(threadKey) as InboxRow[];
    return rows.map((row) => ({
      id: row.item_id,
      event: parseInboundMessage(row.payload),
      enqueuedAt: new Date(row.enqueued_at),
    }));
  }

  async ack(threadKey: string, itemIds: string[]): Promise<void> {
    if (itemIds.length === 0) return;
    const placeholders = itemIds.map(() => "?").join(", ");
    this.db
      .prepare(
        `UPDATE inbox_items SET acked = 1
				 WHERE thread_key = ? AND item_id IN (${placeholders})`,
      )
      .run(threadKey, ...itemIds);
  }
}

class SqliteSessionStore implements SessionStore {
  constructor(private readonly db: Database.Database) {}

  async get(threadKey: string): Promise<SessionDoc | null> {
    const row = this.db
      .prepare(`SELECT doc FROM sessions WHERE thread_key = ?`)
      .get(threadKey) as SessionRow | undefined;
    if (row === undefined) return null;
    const parsed = JSON.parse(row.doc) as Omit<
      SessionDoc,
      "updatedAt" | "rotateRequestedAt"
    > & {
      updatedAt: string;
      rotateRequestedAt?: string;
    };
    const { rotateRequestedAt, ...rest } = parsed;
    return {
      ...rest,
      updatedAt: new Date(parsed.updatedAt),
      ...(rotateRequestedAt !== undefined && {
        rotateRequestedAt: new Date(rotateRequestedAt),
      }),
    };
  }

  async put(threadKey: string, doc: SessionDoc): Promise<void> {
    const payload = JSON.stringify(doc);
    this.db
      .prepare(
        `INSERT INTO sessions (thread_key, doc) VALUES (?, ?)
				 ON CONFLICT(thread_key) DO UPDATE SET doc = excluded.doc`,
      )
      .run(threadKey, payload);
  }
}

class SqliteLeaseStore implements LeaseStore {
  private readonly acquireTxn: (
    threadKey: string,
    owner: string,
    ttlMs: number,
  ) => Lease | null;

  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number,
  ) {
    this.acquireTxn = this.db.transaction(
      (threadKey: string, owner: string, ttlMs: number) => {
        const row = this.db
          .prepare(
            `SELECT owner, token, expires_at FROM leases WHERE thread_key = ?`,
          )
          .get(threadKey) as LeaseRow | undefined;

        const nowMs = this.now();
        if (row !== undefined && row.expires_at > nowMs) return null;

        const token = row === undefined ? 0 : row.token + 1;
        const expiresAt = nowMs + ttlMs;
        this.db
          .prepare(
            `INSERT INTO leases (thread_key, owner, token, expires_at) VALUES (?, ?, ?, ?)
						 ON CONFLICT(thread_key) DO UPDATE SET owner = excluded.owner, token = excluded.token, expires_at = excluded.expires_at`,
          )
          .run(threadKey, owner, token, expiresAt);

        const lease: Lease = {
          threadKey,
          owner,
          token,
          expiresAt: new Date(expiresAt),
        };
        return lease;
      },
    );
  }

  async acquire(
    threadKey: string,
    owner: string,
    ttlMs: number,
  ): Promise<Lease | null> {
    return this.acquireTxn(threadKey, owner, ttlMs);
  }

  async renew(lease: Lease, ttlMs: number): Promise<boolean> {
    // 条件付き UPDATE 1 文で原子的に行う (別プロセスの奪取と SELECT の間で競合しない)
    const nowMs = this.now();
    const result = this.db
      .prepare(
        `UPDATE leases SET expires_at = ?
				 WHERE thread_key = ? AND token = ? AND owner = ? AND expires_at > ?`,
      )
      .run(nowMs + ttlMs, lease.threadKey, lease.token, lease.owner, nowMs);
    return result.changes > 0;
  }

  async release(lease: Lease): Promise<void> {
    this.db
      .prepare(`DELETE FROM leases WHERE thread_key = ? AND token = ?`)
      .run(lease.threadKey, lease.token);
  }
}

/** DB ファイルパス (":memory:" 可) を受け取り、CREATE TABLE IF NOT EXISTS で初期化する。 */
export class SqliteStateStore implements StateStore {
  private readonly db: Database.Database;
  readonly inbox: InboxStore;
  readonly sessions: SessionStore;
  readonly leases: LeaseStore;

  constructor(filePath: string, now: () => number = Date.now) {
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
			CREATE TABLE IF NOT EXISTS inbox_items (
				thread_key TEXT NOT NULL,
				item_id TEXT NOT NULL,
				payload TEXT NOT NULL,
				enqueued_at TEXT NOT NULL,
				acked INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (thread_key, item_id)
			);
			CREATE TABLE IF NOT EXISTS sessions (
				thread_key TEXT PRIMARY KEY,
				doc TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS leases (
				thread_key TEXT PRIMARY KEY,
				owner TEXT NOT NULL,
				token INTEGER NOT NULL,
				expires_at INTEGER NOT NULL
			);
		`);

    this.inbox = new SqliteInboxStore(this.db);
    this.sessions = new SqliteSessionStore(this.db);
    this.leases = new SqliteLeaseStore(this.db, now);
  }

  close(): void {
    this.db.close();
  }
}
