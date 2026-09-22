import { Firestore, Timestamp } from "@google-cloud/firestore";
import { describe, expect, it } from "vitest";

import { FirestoreControlState } from "../../../../src/state/control/backends/firestore.js";
import { describeControlStateContract } from "../contract.js";

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;

describe.skipIf(emulatorHost === undefined)(
  "(requires FIRESTORE_EMULATOR_HOST)",
  () => {
    describeControlStateContract(
      "FirestoreControlState (emulator)",
      async () => {
        const db = new Firestore({ projectId: "pi-chat-runner-test" });
        let now = 0;
        const rootDoc = `test-runs/${Date.now()}-${Math.random()
          .toString(36)
          .slice(2)}`;
        const store = new FirestoreControlState(db, {
          rootDoc,
          now: () => now,
        });
        return {
          store,
          advanceTime: (ms: number) => {
            now += ms;
          },
          close: () => {
            void db.terminate();
          },
        };
      },
    );
  },
);

/** startedAt / lastActiveAt を持たないドキュメント (以前のスキーマ) の読み出し
 * (firestore.ts の fillSessionTimestamps、state.md §3.2)。移行はしないので、
 * 読み出し時の補完だけで get が成立することを見る。 */
describe.skipIf(emulatorHost === undefined)(
  "FirestoreSessionStore: startedAt / lastActiveAt を持たないドキュメントを読む",
  () => {
    it("updatedAt が startedAt / lastActiveAt に代入され、その後の put で現行の形に揃う", async () => {
      const db = new Firestore({ projectId: "pi-chat-runner-test" });
      const rootDoc = `test-runs/${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`;
      const store = new FirestoreControlState(db, { rootDoc, now: () => 0 });
      try {
        const sessionKey = "C1:1000.0";
        const updatedAt = new Date("2026-01-01T00:00:05.000Z");
        // 現行の形では書けないので、ドキュメントを直接書く
        await db
          .doc(rootDoc)
          .collection("sessions")
          .doc(sessionKey)
          .set({
            channelId: "C1",
            threadTs: "1000.0",
            triggerMessageId: "1000.0",
            status: "active",
            updatedAt: Timestamp.fromDate(updatedAt),
          });

        const record = await store.sessions.get(sessionKey);
        expect(record?.channelId).toBe("C1");
        expect(record?.startedAt).toEqual(updatedAt);
        expect(record?.lastActiveAt).toEqual(updatedAt);

        // 現行の形で書き直せば、以後はそのまま読める
        const startedAt = new Date("2026-02-01T00:00:00.000Z");
        const lastActiveAt = new Date("2026-02-01T00:10:00.000Z");
        await store.sessions.put(sessionKey, {
          channelId: "C1",
          threadTs: "1000.0",
          triggerMessageId: "1000.0",
          startedAt,
          lastActiveAt,
        });
        const after = await store.sessions.get(sessionKey);
        expect(after?.startedAt).toEqual(startedAt);
        expect(after?.lastActiveAt).toEqual(lastActiveAt);
      } finally {
        await db.terminate();
      }
    });
  },
);

if (emulatorHost === undefined) {
  console.log(
    "[test/state/control/backends/firestore.test.ts] FIRESTORE_EMULATOR_HOST が未設定のため FirestoreControlState の contract テストを skip します。" +
      " `docker compose up -d` でエミュレータを起動し、FIRESTORE_EMULATOR_HOST=localhost:8080 を設定して再実行してください。",
  );
}
