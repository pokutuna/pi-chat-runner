import { describe, expect, it } from "vitest";

import { SLACK_STATE_EMOJI } from "../../src/chat/slack.js";
import {
  EmojiTurnReactor,
  type ReactionClient,
  type StateEmojiMap,
} from "../../src/egress/emoji-turn-reactor.js";

const EMOJI: StateEmojiMap = {
  start: "start-emoji",
  ok: "ok-emoji",
  error: "error-emoji",
};

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

describe("EmojiTurnReactor", () => {
  it("maps start to the injected start emoji", async () => {
    const fake = client();
    await new EmojiTurnReactor(fake, EMOJI).react("C01", "1700.1", "start");
    expect(fake.calls).toEqual([
      { channel: "C01", timestamp: "1700.1", name: "start-emoji" },
    ]);
  });

  it("maps ok and error to the injected emoji", async () => {
    const fake = client();
    const reactor = new EmojiTurnReactor(fake, EMOJI);
    await reactor.react("C01", "1700.1", "ok");
    await reactor.react("C01", "1700.2", "error");
    expect(fake.calls.map((c) => c.name)).toEqual(["ok-emoji", "error-emoji"]);
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
      new EmojiTurnReactor(fake, EMOJI).react("C01", "1", "start"),
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
      new EmojiTurnReactor(fake, EMOJI).react("C01", "1", "start"),
    ).rejects.toThrow(err);
  });

  it("uses Slack's emoji names when configured by the Slack platform", async () => {
    const fake = client();
    const reactor = new EmojiTurnReactor(fake, SLACK_STATE_EMOJI);
    await reactor.react("C01", "1700.1", "start");
    await reactor.react("C01", "1700.2", "ok");
    await reactor.react("C01", "1700.3", "error");
    expect(fake.calls.map((c) => c.name)).toEqual([
      "eyes",
      "white_check_mark",
      "x",
    ]);
  });
});
