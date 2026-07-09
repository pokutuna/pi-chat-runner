import { describe, expect, it } from "vitest";

import { type ReactionClient, Reactions } from "../../src/egress/reactions.js";

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

describe("Reactions", () => {
  it("addEyes adds :eyes: to the message", async () => {
    const fake = client();
    await new Reactions(fake).addEyes("C01", "1700.1");
    expect(fake.calls).toEqual([
      { channel: "C01", timestamp: "1700.1", name: "eyes" },
    ]);
  });

  it("addCheck adds :white_check_mark: to the message", async () => {
    const fake = client();
    await new Reactions(fake).addCheck("C01", "1700.1");
    expect(fake.calls[0]?.name).toBe("white_check_mark");
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
      new Reactions(fake).addEyes("C01", "1"),
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
    await expect(new Reactions(fake).addEyes("C01", "1")).rejects.toThrow(err);
  });
});
