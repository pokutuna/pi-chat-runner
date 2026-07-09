import { InMemoryStateStore } from "../../../../src/store/state/backends/memory.js";
import { describeStateStoreContract } from "../contract.js";

describeStateStoreContract("InMemoryStateStore", async () => {
  let now = 0;
  const store = new InMemoryStateStore(() => now);
  return {
    store,
    advanceTime: (ms: number) => {
      now += ms;
    },
  };
});
