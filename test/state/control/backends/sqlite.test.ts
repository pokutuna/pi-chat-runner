import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteControlState } from "../../../../src/state/control/backends/sqlite.js";
import { describeControlStateContract } from "../contract.js";

describeControlStateContract("SqliteControlState (:memory:)", async () => {
  let now = 0;
  const store = new SqliteControlState(":memory:", () => now);
  return {
    store,
    advanceTime: (ms: number) => {
      now += ms;
    },
    close: () => store.close(),
  };
});

describeControlStateContract("SqliteControlState (file)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-chat-runner-store-"));
  const filePath = join(dir, "state.sqlite3");
  let now = 0;
  const store = new SqliteControlState(filePath, () => now);
  return {
    store,
    advanceTime: (ms: number) => {
      now += ms;
    },
    close: () => {
      store.close();
      void rm(dir, { recursive: true, force: true });
    },
  };
});

/** 列名を thread_key から session_key へ変えた際の互換措置 (sqlite.ts の
 * renameLegacyThreadKeyColumn)。既存のローカル DB をそのまま開けることを見る。 */
describe("旧スキーマ (thread_key 列) の DB を開く", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-chat-runner-migrate-"));
    filePath = join(dir, "state.sqlite3");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("旧列名で書かれた inbox / sessions / leases のデータが移行後も読める", async () => {
    const legacy = new Database(filePath);
    legacy.exec(`
			CREATE TABLE inbox_items (
				thread_key TEXT NOT NULL,
				item_id TEXT NOT NULL,
				payload TEXT NOT NULL,
				enqueued_at TEXT NOT NULL,
				acked INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (thread_key, item_id)
			);
			CREATE TABLE sessions (
				thread_key TEXT PRIMARY KEY,
				doc TEXT NOT NULL
			);
			CREATE TABLE leases (
				thread_key TEXT PRIMARY KEY,
				owner TEXT NOT NULL,
				token INTEGER NOT NULL,
				expires_at INTEGER NOT NULL
			);
			CREATE TABLE channel_state (
				channel_id TEXT PRIMARY KEY,
				doc TEXT NOT NULL
			);
		`);
    const event = {
      kind: "message",
      id: "1000.0",
      conversation: { channelId: "C1", threadTs: "1000.0" },
      sender: { id: "U1", isBot: false, isSelf: false },
      text: "hello",
      mentionsBot: true,
      attachments: [],
      timestamp: new Date("2026-01-01T00:00:00.000Z"),
      metadata: {},
    };
    legacy
      .prepare(
        `INSERT INTO inbox_items (thread_key, item_id, payload, enqueued_at, acked)
				 VALUES (?, ?, ?, ?, 0)`,
      )
      .run(
        "C1:1000.0",
        "evt-1",
        JSON.stringify(event),
        "2026-01-01T00:00:01.000Z",
      );
    legacy.prepare(`INSERT INTO sessions (thread_key, doc) VALUES (?, ?)`).run(
      "C1:1000.0",
      JSON.stringify({
        channelId: "C1",
        threadTs: "1000.0",
        triggerMessageId: "1000.0",
        startedAt: "2026-01-01T00:00:00.000Z",
        lastActiveAt: "2026-01-01T00:00:03.000Z",
      }),
    );
    legacy
      .prepare(
        `INSERT INTO leases (thread_key, owner, token, expires_at) VALUES (?, ?, ?, ?)`,
      )
      .run("C1:1000.0", "owner-a", 3, 10_000);
    legacy.close();

    const store = new SqliteControlState(filePath, () => 0);
    try {
      const items = await store.inbox.drain("C1:1000.0");
      expect(items.map((i) => i.id)).toEqual(["evt-1"]);
      expect(items[0]?.event.text).toBe("hello");

      const record = await store.sessions.get("C1:1000.0");
      expect(record?.triggerMessageId).toBe("1000.0");
      expect(record?.lastActiveAt).toEqual(
        new Date("2026-01-01T00:00:03.000Z"),
      );

      // 旧 lease は有効期限内なので奪えない (= session_key で引けている)
      expect(
        await store.leases.acquire("C1:1000.0", "owner-b", 1000),
      ).toBeNull();
    } finally {
      store.close();
    }
  });
});
