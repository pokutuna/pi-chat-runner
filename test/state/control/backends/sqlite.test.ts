import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
