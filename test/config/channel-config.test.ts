import { describe, expect, it } from "vitest";

import {
  ChannelConfigSchema,
  ChannelEntrySchema,
  ChannelsFileSchema,
} from "../../src/config/channel-config.js";

describe("ChannelConfigSchema", () => {
  it("accepts a minimal empty config", () => {
    const result = ChannelConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts a full config with mention/keyword/classifier/passthrough gates", () => {
    const result = ChannelConfigSchema.safeParse({
      agent: {
        systemPrompt: "be nice",
        context: ["note1", "note2"],
        model: "google-vertex/gemini-3-pro",
      },
      trigger: {
        when: [
          { kind: "mention" },
          { kind: "keyword", pattern: "(ALERT|ERROR)" },
          { kind: "classifier", criteria: "infra alert" },
          { kind: "passthrough" },
        ],
      },
      session: { affinity: { debounceSec: 30 } },
    });
    expect(result.success).toBe(true);
  });

  // Agent Config は agent ブロックの下にだけ書ける (config.md §1.2, §1.3)。
  it.each([
    "systemPrompt",
    "context",
    "model",
    "tools",
    "excludeTools",
    "skills",
    "extensions",
    "memory",
    "env",
  ])("rejects a top-level %s (it belongs under agent)", (key) => {
    const result = ChannelConfigSchema.safeParse({ [key]: "x" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys under agent (strict)", () => {
    const result = ChannelConfigSchema.safeParse({
      agent: { unknownField: true },
    });
    expect(result.success).toBe(false);
  });

  it("rejects cooldownSec inside trigger (implementation deferred)", () => {
    const result = ChannelConfigSchema.safeParse({
      trigger: {
        when: [{ kind: "mention" }],
        cooldownSec: 60,
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts trigger.allowBots as a boolean", () => {
    const result = ChannelConfigSchema.safeParse({
      trigger: {
        when: [{ kind: "mention" }],
        allowBots: true,
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-boolean trigger.allowBots", () => {
    const result = ChannelConfigSchema.safeParse({
      trigger: {
        when: [{ kind: "mention" }],
        allowBots: "yes",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects trigger.debounceSec (moved to session.affinity.debounceSec)", () => {
    const result = ChannelConfigSchema.safeParse({
      trigger: {
        when: [{ kind: "mention" }],
        debounceSec: 30,
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts session.affinity with scope/windowSec/debounceSec", () => {
    const result = ChannelConfigSchema.safeParse({
      session: {
        mode: "thread",
        affinity: {
          scope: "channel",
          windowSec: 600,
          debounceSec: 30,
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown session.affinity.scope value", () => {
    const result = ChannelConfigSchema.safeParse({
      session: { affinity: { scope: "global" } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys inside session.affinity (strict)", () => {
    const result = ChannelConfigSchema.safeParse({
      session: { affinity: { unknownField: true } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown top-level keys (strict)", () => {
    const result = ChannelConfigSchema.safeParse({
      agent: { systemPrompt: "hi" },
      piSettings: { foo: "bar" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys inside trigger (strict)", () => {
    const result = ChannelConfigSchema.safeParse({
      trigger: {
        when: [{ kind: "mention" }],
        unknownField: true,
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys inside a gate (strict)", () => {
    const result = ChannelConfigSchema.safeParse({
      trigger: {
        when: [{ kind: "mention", extra: "nope" }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects keyword gate without pattern", () => {
    expect(() =>
      ChannelConfigSchema.parse({
        trigger: {
          when: [{ kind: "keyword" }],
        },
      }),
    ).toThrow(/pattern/);
  });

  it("rejects classifier gate without criteria", () => {
    expect(() =>
      ChannelConfigSchema.parse({
        trigger: {
          when: [{ kind: "classifier" }],
        },
      }),
    ).toThrow(/criteria/);
  });

  it("accepts a classifier gate with a per-gate model override", () => {
    const result = ChannelConfigSchema.safeParse({
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
    const result = ChannelConfigSchema.safeParse({
      trigger: {
        when: [{ kind: "reaction", emoji: ["eyes"] }],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects reaction gate without emoji", () => {
    expect(() =>
      ChannelConfigSchema.parse({
        trigger: {
          when: [{ kind: "reaction" }],
        },
      }),
    ).toThrow(/emoji/);
  });

  it("rejects reaction gate with an empty emoji list", () => {
    const result = ChannelConfigSchema.safeParse({
      trigger: {
        when: [{ kind: "reaction", emoji: [] }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a sender gate with is=bot", () => {
    const result = ChannelConfigSchema.safeParse({
      trigger: {
        when: [{ kind: "sender", is: "bot" }],
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a sender gate with is=human", () => {
    const result = ChannelConfigSchema.safeParse({
      trigger: {
        when: [{ kind: "sender", is: "human" }],
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a sender gate with name only", () => {
    const result = ChannelConfigSchema.safeParse({
      trigger: {
        when: [{ kind: "sender", name: ["alice", "bob"] }],
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a sender gate with id only", () => {
    const result = ChannelConfigSchema.safeParse({
      trigger: {
        when: [{ kind: "sender", id: ["U0123456", "U0234567"] }],
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a sender gate with both is and name", () => {
    const result = ChannelConfigSchema.safeParse({
      trigger: {
        when: [{ kind: "sender", is: "human", name: ["alice"] }],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects sender gate with an empty id and no is/name", () => {
    const result = ChannelConfigSchema.safeParse({
      trigger: {
        when: [{ kind: "sender", id: [] }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects sender gate with none of is, id, name", () => {
    expect(() =>
      ChannelConfigSchema.parse({
        trigger: {
          when: [{ kind: "sender" }],
        },
      }),
    ).toThrow(/at least one of/);
  });

  it("rejects sender gate with an empty name and no is", () => {
    const result = ChannelConfigSchema.safeParse({
      trigger: {
        when: [{ kind: "sender", name: [] }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects sender gate with an invalid is value", () => {
    const result = ChannelConfigSchema.safeParse({
      trigger: {
        when: [{ kind: "sender", is: "robot" }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts mention/passthrough gates without extra params", () => {
    const result = ChannelConfigSchema.safeParse({
      trigger: {
        when: [{ kind: "mention" }, { kind: "passthrough" }],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects cooldown kind", () => {
    const result = ChannelConfigSchema.safeParse({
      trigger: {
        when: [{ kind: "cooldown" }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts an 'and' node combining gates", () => {
    const result = ChannelConfigSchema.safeParse({
      trigger: {
        when: [
          { and: [{ kind: "mention" }, { kind: "keyword", pattern: "x" }] },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an 'or' node combining gates", () => {
    const result = ChannelConfigSchema.safeParse({
      trigger: {
        when: [
          { or: [{ kind: "mention" }, { kind: "keyword", pattern: "x" }] },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an 'and' node with unknown keys (strict)", () => {
    const result = ChannelConfigSchema.safeParse({
      trigger: {
        when: [{ and: [], unknownKey: 1 }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts session/reply fields", () => {
    const result = ChannelConfigSchema.safeParse({
      session: { mode: "channel", idleResetMinutes: 30, maxTranscriptKb: 512 },
      reply: { mode: "flat" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid session.mode value", () => {
    const result = ChannelConfigSchema.safeParse({
      session: { mode: "invalid" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid reply.mode value", () => {
    const result = ChannelConfigSchema.safeParse({
      reply: { mode: "invalid" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys inside session (strict)", () => {
    const result = ChannelConfigSchema.safeParse({
      session: { mode: "thread", unknownField: true },
    });
    expect(result.success).toBe(false);
  });

  // trigger.whileRunning: 実行中セッションがあるレーンで gate を再評価するか
  // (config.md §4.4)。Phase 3 時点では解析・マージ・dump のみ。
  it.each(["passthrough", "evaluate"])(
    "accepts trigger.whileRunning: %s",
    (whileRunning) => {
      const result = ChannelConfigSchema.safeParse({
        trigger: { when: [{ kind: "mention" }], whileRunning },
      });
      expect(result.success).toBe(true);
      expect(result.data?.trigger?.whileRunning).toBe(whileRunning);
    },
  );

  it("leaves trigger.whileRunning undefined when omitted", () => {
    const result = ChannelConfigSchema.safeParse({
      trigger: { when: [{ kind: "mention" }] },
    });
    expect(result.success).toBe(true);
    expect(result.data?.trigger?.whileRunning).toBeUndefined();
  });

  it("rejects an unknown trigger.whileRunning value", () => {
    const result = ChannelConfigSchema.safeParse({
      trigger: { when: [{ kind: "mention" }], whileRunning: "queue" },
    });
    expect(result.success).toBe(false);
  });
});

describe("ChannelEntrySchema", () => {
  it("requires the channel field", () => {
    const result = ChannelEntrySchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("accepts an entry with channel plus ChannelConfig fields", () => {
    const result = ChannelEntrySchema.safeParse({
      channel: "#ask-ai",
      agent: { systemPrompt: "./prompts/ask-ai.md" },
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
