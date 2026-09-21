import { InMemoryControlState } from "../../../../src/state/control/backends/memory.js";
import { describeControlStateContract } from "../contract.js";

describeControlStateContract("InMemoryControlState", async () => {
  let now = 0;
  const store = new InMemoryControlState(() => now);
  return {
    store,
    advanceTime: (ms: number) => {
      now += ms;
    },
  };
});
