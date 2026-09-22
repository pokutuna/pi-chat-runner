// inboxItemId の dedupe キー決定 (state.md §3)。
import { describe, expect, it } from "vitest";

import { inboxItemId } from "../../../src/state/control/inbox-item.js";
import { message } from "../../helpers/session-harness.js";

describe("inboxItemId", () => {
  it("prefers Slack event_id from metadata", () => {
    expect(inboxItemId(message({ metadata: { eventId: "Ev123" } }))).toBe(
      "Ev123",
    );
  });

  it("falls back to message ts when metadata has no eventId", () => {
    expect(inboxItemId(message({ metadata: {} }))).toBe("1700000000.000100");
  });
});
