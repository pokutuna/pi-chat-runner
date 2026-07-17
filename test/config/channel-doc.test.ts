import { describe, expect, it } from "vitest";

import {
  ChannelDocSchema,
  ChannelEntrySchema,
  ChannelsFileSchema,
} from "../../src/config/channel-doc.js";

describe("ChannelDocSchema", () => {
  it("accepts a minimal empty doc", () => {
    const result = ChannelDocSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts a full doc with mention/keyword/classifier/passthrough gates", () => {
    const result = ChannelDocSchema.safeParse({
      systemPrompt: "be nice",
      context: ["note1", "note2"],
      trigger: {
        when: [
          { kind: "mention" },
          { kind: "keyword", pattern: "(ALERT|ERROR)" },
          { kind: "classifier", criteria: "infra alert" },
          { kind: "passthrough" },
        ],
        debounceSec: 30,
      },
      model: "google-vertex/gemini-3-pro",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a model with a thinking-level suffix", () => {
    const result = ChannelDocSchema.safeParse({
      model: "google-vertex/gemini-3.1-pro:high",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a bare model id without a provider prefix", () => {
    const result = ChannelDocSchema.safeParse({ model: "gemini-3.5-flash" });
    expect(result.success).toBe(false);
  });

  it("rejects cooldownSec inside trigger (implementation deferred)", () => {
    const result = ChannelDocSchema.safeParse({
      trigger: {
        when: [{ kind: "mention" }],
        cooldownSec: 60,
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts trigger.allowBots as a boolean", () => {
    const result = ChannelDocSchema.safeParse({
      trigger: {
        when: [{ kind: "mention" }],
        allowBots: true,
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-boolean trigger.allowBots", () => {
    const result = ChannelDocSchema.safeParse({
      trigger: {
        when: [{ kind: "mention" }],
        allowBots: "yes",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown top-level keys (strict)", () => {
    const result = ChannelDocSchema.safeParse({
      systemPrompt: "hi",
      piSettings: { foo: "bar" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys inside trigger (strict)", () => {
    const result = ChannelDocSchema.safeParse({
      trigger: {
        when: [{ kind: "mention" }],
        unknownField: true,
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys inside a gate (strict)", () => {
    const result = ChannelDocSchema.safeParse({
      trigger: {
        when: [{ kind: "mention", extra: "nope" }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects keyword gate without pattern", () => {
    expect(() =>
      ChannelDocSchema.parse({
        trigger: {
          when: [{ kind: "keyword" }],
        },
      }),
    ).toThrow(/pattern/);
  });

  it("rejects classifier gate without criteria", () => {
    expect(() =>
      ChannelDocSchema.parse({
        trigger: {
          when: [{ kind: "classifier" }],
        },
      }),
    ).toThrow(/criteria/);
  });

  it("accepts a classifier gate with a per-gate model override", () => {
    const result = ChannelDocSchema.safeParse({
      trigger: {
        when: [
          { kind: "classifier", criteria: "infra alert", model: "gemini-x" },
        ],
      },
    });
    expect(result.success).toBe(true);
    expect(result.data?.trigger?.when[0]).toMatchObject({
      kind: "classifier",
      model: "gemini-x",
    });
  });

  it("accepts a reaction gate with a non-empty emoji list", () => {
    const result = ChannelDocSchema.safeParse({
      trigger: {
        when: [{ kind: "reaction", emoji: ["eyes"] }],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects reaction gate without emoji", () => {
    expect(() =>
      ChannelDocSchema.parse({
        trigger: {
          when: [{ kind: "reaction" }],
        },
      }),
    ).toThrow(/emoji/);
  });

  it("rejects reaction gate with an empty emoji list", () => {
    const result = ChannelDocSchema.safeParse({
      trigger: {
        when: [{ kind: "reaction", emoji: [] }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a sender gate with is=bot", () => {
    const result = ChannelDocSchema.safeParse({
      trigger: {
        when: [{ kind: "sender", is: "bot" }],
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a sender gate with is=human", () => {
    const result = ChannelDocSchema.safeParse({
      trigger: {
        when: [{ kind: "sender", is: "human" }],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects sender gate without is", () => {
    expect(() =>
      ChannelDocSchema.parse({
        trigger: {
          when: [{ kind: "sender" }],
        },
      }),
    ).toThrow(/is/);
  });

  it("rejects sender gate with an invalid is value", () => {
    const result = ChannelDocSchema.safeParse({
      trigger: {
        when: [{ kind: "sender", is: "robot" }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts mention/passthrough gates without extra params", () => {
    const result = ChannelDocSchema.safeParse({
      trigger: {
        when: [{ kind: "mention" }, { kind: "passthrough" }],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects cooldown kind", () => {
    const result = ChannelDocSchema.safeParse({
      trigger: {
        when: [{ kind: "cooldown" }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts an 'and' node combining gates", () => {
    const result = ChannelDocSchema.safeParse({
      trigger: {
        when: [
          { and: [{ kind: "mention" }, { kind: "keyword", pattern: "x" }] },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an 'or' node combining gates", () => {
    const result = ChannelDocSchema.safeParse({
      trigger: {
        when: [
          { or: [{ kind: "mention" }, { kind: "keyword", pattern: "x" }] },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an 'and' node with unknown keys (strict)", () => {
    const result = ChannelDocSchema.safeParse({
      trigger: {
        when: [{ and: [], unknownKey: 1 }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts session/reply fields", () => {
    const result = ChannelDocSchema.safeParse({
      session: { mode: "channel", idleResetMinutes: 30, maxTranscriptKb: 512 },
      reply: { mode: "flat" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid session.mode value", () => {
    const result = ChannelDocSchema.safeParse({
      session: { mode: "invalid" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid reply.mode value", () => {
    const result = ChannelDocSchema.safeParse({
      reply: { mode: "invalid" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys inside session (strict)", () => {
    const result = ChannelDocSchema.safeParse({
      session: { mode: "thread", unknownField: true },
    });
    expect(result.success).toBe(false);
  });
});

describe("ChannelEntrySchema", () => {
  it("requires the channel field", () => {
    const result = ChannelEntrySchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("accepts a doc with channel plus ChannelDoc fields", () => {
    const result = ChannelEntrySchema.safeParse({
      channel: "#ask-ai",
      systemPrompt: "./prompts/ask-ai.md",
    });
    expect(result.success).toBe(true);
  });

  it("still rejects unknown keys (strict) alongside channel", () => {
    const result = ChannelEntrySchema.safeParse({
      channel: "C123",
      unknown: "nope",
    });
    expect(result.success).toBe(false);
  });
});

describe("ChannelsFileSchema", () => {
  it("accepts a file containing a 'default' entry", () => {
    const result = ChannelsFileSchema.safeParse({
      channels: [{ channel: "default" }, { channel: "C1" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty channels array", () => {
    const result = ChannelsFileSchema.safeParse({ channels: [] });
    expect(result.success).toBe(false);
  });

  it("rejects a file missing the 'default' entry", () => {
    const result = ChannelsFileSchema.safeParse({
      channels: [{ channel: "C1" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown top-level keys (strict)", () => {
    const result = ChannelsFileSchema.safeParse({
      channels: [{ channel: "default" }],
      extra: 1,
    });
    expect(result.success).toBe(false);
  });
});
