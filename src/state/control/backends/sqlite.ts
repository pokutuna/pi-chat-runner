// SQLite 実装 (docs/design/state.md §4.1)
//
// better-sqlite3 は同期 API。IF は Promise なので async メソッドで包むだけでよい。
// 1 ファイル (":memory:" も可)。ローカルで永続化・排他込みの動作確認に使う想定。

import Database from "better-sqlite3";

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

interface InboxRow {
  item_id: string;
  payload: string;
  enqueued_at: string;
}

interface SessionRow {
  doc: string;
}

interface ThreadRow {
  session_key: string;
}

interface ChannelLatestRow {
  session_key: string;
  last_active_at: number;
  ended_at: number | null;
}

interface LeaseRow {
  owner: string;
  token: number;
  expires_at: number;
}

interface ChannelRow {
  doc: string;
}

class SqliteInboxStore implements InboxStore {
  constructor(private readonly db: Database.Database) {}

  async enqueue(sessionKey: string, item: InboxItem): Promise<boolean> {
    const payload = JSON.stringify(item.event);
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO inbox_items (session_key, item_id, payload, enqueued_at, acked)
				 VALUES (?, ?, ?, ?, 0)`,
      )
      .run(sessionKey, item.id, payload, item.enqueuedAt.toISOString());
    return result.changes > 0;
  }

  async drain(sessionKey: string): Promise<InboxItem[]> {
    const rows = this.db
      .prepare(
        `SELECT item_id, payload, enqueued_at FROM inbox_items
				 WHERE session_key = ? AND acked = 0
				 ORDER BY rowid ASC`,
      )
      .all(sessionKey) as InboxRow[];
    return rows.map((row) => ({
      id: row.item_id,
      event: parseInboundMessage(row.payload),
      enqueuedAt: new Date(row.enqueued_at),
    }));
  }

  async ack(sessionKey: string, itemIds: string[]): Promise<void> {
    if (itemIds.length === 0) return;
    const placeholders = itemIds.map(() => "?").join(", ");
    this.db
      .prepare(
        `UPDATE inbox_items SET acked = 1
				 WHERE session_key = ? AND item_id IN (${placeholders})`,
      )
      .run(sessionKey, ...itemIds);
  }
}

/** 永続 doc の生の形。SessionRecord の Date フィールドを JSON 互換の文字列にした形。 */
interface SessionRecordJson {
  channelId: string;
  threadTs: string;
  triggerMessageId: string;
  startedAt: string;
  lastActiveAt: string;
  endedAt?: string;
  rotateRequestedAt?: string;
}

class SqliteSessionStore implements SessionStore {
  constructor(private readonly db: Database.Database) {}

  async get(sessionKey: string): Promise<SessionRecord | null> {
    const row = this.db
      .prepare(`SELECT doc FROM sessions WHERE session_key = ?`)
      .get(sessionKey) as SessionRow | undefined;
    if (row === undefined) return null;
    const parsed = JSON.parse(row.doc) as SessionRecordJson;
    return {
      channelId: parsed.channelId,
      threadTs: parsed.threadTs,
      triggerMessageId: parsed.triggerMessageId,
      startedAt: new Date(parsed.startedAt),
      lastActiveAt: new Date(parsed.lastActiveAt),
      ...(parsed.endedAt !== undefined && {
        endedAt: new Date(parsed.endedAt),
      }),
      ...(parsed.rotateRequestedAt !== undefined && {
        rotateRequestedAt: new Date(parsed.rotateRequestedAt),
      }),
    };
  }

  async put(sessionKey: string, record: SessionRecord): Promise<void> {
    const payload = JSON.stringify(record);
    this.db
      .prepare(
        `INSERT INTO sessions (session_key, doc) VALUES (?, ?)
				 ON CONFLICT(session_key) DO UPDATE SET doc = excluded.doc`,
      )
      .run(sessionKey, payload);
  }
}

class SqliteThreadStore implements ThreadStore {
  private readonly markEndedTxn: (
    channelId: string,
    sessionKey: string,
  ) => void;

  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number,
  ) {
    this.markEndedTxn = this.db.transaction(
      (channelId: string, sessionKey: string) => {
        const row = this.db
          .prepare(
            `SELECT session_key FROM channel_latest WHERE channel_id = ?`,
          )
          .get(channelId) as { session_key: string } | undefined;
        if (row === undefined || row.session_key !== sessionKey) return;
        const endedAtMs = this.now();
        this.db
          .prepare(
            `UPDATE channel_latest SET last_active_at = ?, ended_at = ? WHERE channel_id = ?`,
          )
          .run(endedAtMs, endedAtMs, channelId);
      },
    );
  }

  async resolve(derivedSessionKey: string): Promise<string | null> {
    const row = this.db
      .prepare(`SELECT session_key FROM threads WHERE derived_session_key = ?`)
      .get(derivedSessionKey) as ThreadRow | undefined;
    return row === undefined ? null : row.session_key;
  }

  async bind(derivedSessionKey: string, sessionKey: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO threads (derived_session_key, session_key) VALUES (?, ?)
				 ON CONFLICT(derived_session_key) DO UPDATE SET session_key = excluded.session_key`,
      )
      .run(derivedSessionKey, sessionKey);
  }

  async latest(channelId: string): Promise<ChannelLatestSession | null> {
    const row = this.db
      .prepare(
        `SELECT session_key, last_active_at, ended_at FROM channel_latest WHERE channel_id = ?`,
      )
      .get(channelId) as ChannelLatestRow | undefined;
    if (row === undefined) return null;
    return {
      sessionKey: row.session_key,
      lastActiveAt: new Date(row.last_active_at),
      ...(row.ended_at !== null && { endedAt: new Date(row.ended_at) }),
    };
  }

  async touchLatest(channelId: string, sessionKey: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO channel_latest (channel_id, session_key, last_active_at, ended_at)
				 VALUES (?, ?, ?, NULL)
				 ON CONFLICT(channel_id) DO UPDATE SET
					 session_key = excluded.session_key,
					 last_active_at = excluded.last_active_at,
					 ended_at = NULL`,
      )
      .run(channelId, sessionKey, this.now());
  }

  async markLatestEnded(channelId: string, sessionKey: string): Promise<void> {
    this.markEndedTxn(channelId, sessionKey);
  }
}

interface ChannelStateDocJson {
  enabled: boolean;
  updatedAt: string;
  updatedBy?: string;
}

function parseChannelStateDoc(payload: string): ChannelStateDoc {
  const parsed = JSON.parse(payload) as ChannelStateDocJson;
  return {
    enabled: parsed.enabled,
    updatedAt: new Date(parsed.updatedAt),
    ...(parsed.updatedBy !== undefined && { updatedBy: parsed.updatedBy }),
  };
}

class SqliteChannelStateStore implements ChannelStateStore {
  constructor(private readonly db: Database.Database) {}

  async get(channelId: string): Promise<ChannelStateDoc | null> {
    const row = this.db
      .prepare(`SELECT doc FROM channel_state WHERE channel_id = ?`)
      .get(channelId) as ChannelRow | undefined;
    if (row === undefined) return null;
    return parseChannelStateDoc(row.doc);
  }

  async put(channelId: string, doc: ChannelStateDoc): Promise<void> {
    const payload = JSON.stringify({
      enabled: doc.enabled,
      updatedAt: doc.updatedAt,
      ...(doc.updatedBy !== undefined && { updatedBy: doc.updatedBy }),
    });
    this.db
      .prepare(
        `INSERT INTO channel_state (channel_id, doc) VALUES (?, ?)
				 ON CONFLICT(channel_id) DO UPDATE SET doc = excluded.doc`,
      )
      .run(channelId, payload);
  }
}

class SqliteLeaseStore implements LeaseStore {
  private readonly acquireTxn: (
    sessionKey: string,
    owner: string,
    ttlMs: number,
  ) => Lease | null;

  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number,
  ) {
    this.acquireTxn = this.db.transaction(
      (sessionKey: string, owner: string, ttlMs: number) => {
        const row = this.db
          .prepare(
            `SELECT owner, token, expires_at FROM leases WHERE session_key = ?`,
          )
          .get(sessionKey) as LeaseRow | undefined;

        const nowMs = this.now();
        if (row !== undefined && row.expires_at > nowMs) return null;

        const token = row === undefined ? 0 : row.token + 1;
        const expiresAt = nowMs + ttlMs;
        this.db
          .prepare(
            `INSERT INTO leases (session_key, owner, token, expires_at) VALUES (?, ?, ?, ?)
						 ON CONFLICT(session_key) DO UPDATE SET owner = excluded.owner, token = excluded.token, expires_at = excluded.expires_at`,
          )
          .run(sessionKey, owner, token, expiresAt);

        const lease: Lease = {
          sessionKey,
          owner,
          token,
          expiresAt: new Date(expiresAt),
        };
        return lease;
      },
    );
  }

  async acquire(
    sessionKey: string,
    owner: string,
    ttlMs: number,
  ): Promise<Lease | null> {
    return this.acquireTxn(sessionKey, owner, ttlMs);
  }

  async renew(lease: Lease, ttlMs: number): Promise<boolean> {
    // 条件付き UPDATE 1 文で原子的に行う (別プロセスの奪取と SELECT の間で競合しない)
    const nowMs = this.now();
    const result = this.db
      .prepare(
        `UPDATE leases SET expires_at = ?
				 WHERE session_key = ? AND token = ? AND owner = ? AND expires_at > ?`,
      )
      .run(nowMs + ttlMs, lease.sessionKey, lease.token, lease.owner, nowMs);
    return result.changes > 0;
  }

  async release(lease: Lease): Promise<void> {
    this.db
      .prepare(`DELETE FROM leases WHERE session_key = ? AND token = ?`)
      .run(lease.sessionKey, lease.token);
  }
}

/** DB ファイルパス (":memory:" 可) を受け取り、CREATE TABLE IF NOT EXISTS で初期化する。 */
export class SqliteControlState implements ControlState {
  private readonly db: Database.Database;
  readonly inbox: InboxStore;
  readonly sessions: SessionStore;
  readonly threads: ThreadStore;
  readonly leases: LeaseStore;
  readonly channels: ChannelStateStore;

  constructor(filePath: string, now: () => number = Date.now) {
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
			CREATE TABLE IF NOT EXISTS inbox_items (
				session_key TEXT NOT NULL,
				item_id TEXT NOT NULL,
				payload TEXT NOT NULL,
				enqueued_at TEXT NOT NULL,
				acked INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (session_key, item_id)
			);
			CREATE TABLE IF NOT EXISTS sessions (
				session_key TEXT PRIMARY KEY,
				doc TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS threads (
				derived_session_key TEXT PRIMARY KEY,
				session_key TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS channel_latest (
				channel_id TEXT PRIMARY KEY,
				session_key TEXT NOT NULL,
				last_active_at INTEGER NOT NULL,
				ended_at INTEGER
			);
			CREATE TABLE IF NOT EXISTS leases (
				session_key TEXT PRIMARY KEY,
				owner TEXT NOT NULL,
				token INTEGER NOT NULL,
				expires_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS channel_state (
				channel_id TEXT PRIMARY KEY,
				doc TEXT NOT NULL
			);
		`);

    this.inbox = new SqliteInboxStore(this.db);
    this.sessions = new SqliteSessionStore(this.db);
    this.threads = new SqliteThreadStore(this.db, now);
    this.leases = new SqliteLeaseStore(this.db, now);
    this.channels = new SqliteChannelStateStore(this.db);
  }

  close(): void {
    this.db.close();
  }
}
