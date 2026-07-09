import { Firestore } from "@google-cloud/firestore";
import { describe } from "vitest";

import { FirestoreStateStore } from "../../../../src/store/state/backends/firestore.js";
import { describeStateStoreContract } from "../contract.js";

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;

describe.skipIf(emulatorHost === undefined)(
	"(requires FIRESTORE_EMULATOR_HOST)",
	() => {
		describeStateStoreContract("FirestoreStateStore (emulator)", async () => {
			const db = new Firestore({ projectId: "pi-chat-runner-test" });
			let now = 0;
			const collectionPrefix = `test-${Date.now()}-${Math.random()
				.toString(36)
				.slice(2)}`;
			const store = new FirestoreStateStore(db, {
				collectionPrefix,
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
		});
	},
);

if (emulatorHost === undefined) {
	console.log(
		"[test/store/firestore.test.ts] FIRESTORE_EMULATOR_HOST が未設定のため FirestoreStateStore の contract テストを skip します。" +
			" `docker compose up -d` でエミュレータを起動し、FIRESTORE_EMULATOR_HOST=localhost:8080 を設定して再実行してください。",
	);
}
