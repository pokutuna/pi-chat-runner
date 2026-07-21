import { describe, expect, it } from "vitest";

import { SlackTurnReactor } from "../../../src/egress/slack/turn-reactor.js";
import type { ReactionClient } from "../../../src/egress/slack/turn-reactor.js";

function client(impl?: Partial<ReactionClient>): ReactionClient & {
  calls: { channel: string; timestamp: string; name: string }[];
} {
  const calls: { channel: string; timestamp: string; name: string }[] = [];
  return {
    calls,
    add: async (args) => {
      calls.push(args);
      if (impl?.add) return impl.add(args);
      return {};
    },
  };
}

describe("SlackTurnReactor", () => {
  it("maps kick to :eyes:", async () => {
    const fake = client();
    await new SlackTurnReactor(fake).react("C01", "1700.1", "kick");
    expect(fake.calls).toEqual([
      { channel: "C01", timestamp: "1700.1", name: "eyes" },
    ]);
  });

  it("maps ok to :white_check_mark: and error to :x:", async () => {
    const fake = client();
    const reactor = new SlackTurnReactor(fake);
    await reactor.react("C01", "1700.1", "ok");
    await reactor.react("C01", "1700.2", "error");
    expect(fake.calls.map((c) => c.name)).toEqual(["white_check_mark", "x"]);
  });

  it("swallows already_reacted platform errors", async () => {
    const err = Object.assign(new Error("An API error occurred"), {
      data: { ok: false, error: "already_reacted" },
    });
    const fake = client({
      add: async () => {
        throw err;
      },
    });
    await expect(
      new SlackTurnReactor(fake).react("C01", "1", "kick"),
    ).resolves.toBeUndefined();
  });

  it("propagates other errors", async () => {
    const err = Object.assign(new Error("An API error occurred"), {
      data: { ok: false, error: "missing_scope" },
    });
    const fake = client({
      add: async () => {
        throw err;
      },
    });
    await expect(
      new SlackTurnReactor(fake).react("C01", "1", "kick"),
    ).rejects.toThrow(err);
  });
});
