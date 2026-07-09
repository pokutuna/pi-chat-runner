import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteStateStore } from "../../../../src/store/state/backends/sqlite.js";
import { describeStateStoreContract } from "../contract.js";

describeStateStoreContract("SqliteStateStore (:memory:)", async () => {
	let now = 0;
	const store = new SqliteStateStore(":memory:", () => now);
	return {
		store,
		advanceTime: (ms: number) => {
			now += ms;
		},
		close: () => store.close(),
	};
});

describeStateStoreContract("SqliteStateStore (file)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-chat-runner-store-"));
	const filePath = join(dir, "state.sqlite3");
	let now = 0;
	const store = new SqliteStateStore(filePath, () => now);
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
