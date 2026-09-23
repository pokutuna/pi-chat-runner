import { Firestore } from "@google-cloud/firestore";
import { describe } from "vitest";

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

if (emulatorHost === undefined) {
  console.log(
    "[test/state/control/backends/firestore.test.ts] FIRESTORE_EMULATOR_HOST が未設定のため FirestoreControlState の contract テストを skip します。" +
      " `docker compose up -d` でエミュレータを起動し、FIRESTORE_EMULATOR_HOST=localhost:8080 を設定して再実行してください。",
  );
}
