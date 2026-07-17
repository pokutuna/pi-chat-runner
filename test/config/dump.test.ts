import { describe, expect, it } from "vitest";

import { ChannelsFileSchema } from "../../src/config/channel-doc.js";
import { formatEffectiveConfig, formatWhen } from "../../src/config/dump.js";

describe("formatEffectiveConfig", () => {
  it("formats a normal channel in pretty mode with per-field provenance", () => {
    const file = ChannelsFileSchema.parse({
      channels: [
        {
          channel: "default",
          model: "google/gemini-default",
          trigger: { when: [{ kind: "mention" }] },
        },
        { channel: "C1", systemPrompt: "p", model: "google/gemini-x" },
      ],
    });

    const out = formatEffectiveConfig(file, "C1", { json: false });

    expect(out).toContain("channel: C1");
    expect(out).toMatch(/model:\s+google\/gemini-x\s+← channel/);
    expect(out).toMatch(/systemPrompt:.*← channel/);
    expect(out).toContain("OR[ mention ]");
    expect(out).toMatch(/trigger\.when:.*← default/);
  });

  it("formats the default doc alone (id has no matching entry) with all fields '← default'", () => {
    const file = ChannelsFileSchema.parse({
      channels: [
        {
          channel: "default",
          model: "google/gemini-default",
          trigger: { when: [{ kind: "mention" }] },
        },
      ],
    });

    const out = formatEffectiveConfig(file, "C_NOT_FOUND", { json: false });

    expect(out).toContain("channel: C_NOT_FOUND");
    expect(out).toMatch(/model:\s+google\/gemini-default\s+← default/);
    expect(out).toMatch(/trigger\.when:.*OR\[ mention \].*← default/);
  });

  it("formats a DM with a dm entry: dm-authored fields show '← dm' (no inheritance from default)", () => {
    const file = ChannelsFileSchema.parse({
      channels: [
        {
          channel: "default",
          trigger: { when: [{ kind: "mention" }] },
        },
        { channel: "dm", systemPrompt: "dm p" },
      ],
    });

    const out = formatEffectiveConfig(file, "dm", { json: false });

    expect(out).toContain("channel: dm (dm)");
    // dm エントリ由来のフィールドは provenance "dm" になる (default/channel ではない)
    expect(out).toMatch(/systemPrompt:.*← dm/);
    expect(out).not.toMatch(/systemPrompt:.*← default/);
    expect(out).not.toMatch(/systemPrompt:.*← channel/);

    // DM 既定は session.mode=channel / reply.mode=flat (doc に無く、default も継承しない)
    expect(out).toMatch(/session\.mode:\s+channel\s+← code default/);
    expect(out).toMatch(/reply\.mode:\s+flat\s+← code default/);
  });

  it("formats DM passthrough (no dm entry) in pretty mode", () => {
    const file = ChannelsFileSchema.parse({
      channels: [{ channel: "default", systemPrompt: "default prompt" }],
    });

    const out = formatEffectiveConfig(file, "dm", { json: false });

    expect(out).toContain("channel: dm (dm)");
    expect(out).toMatch(/passthrough/);
  });

  it("formats DM passthrough (no dm entry) in json mode", () => {
    const file = ChannelsFileSchema.parse({
      channels: [{ channel: "default", systemPrompt: "default prompt" }],
    });

    const out = formatEffectiveConfig(file, "dm", { json: true });
    const payload = JSON.parse(out);

    expect(payload.channel).toBe("dm");
    expect(payload.isDm).toBe(true);
    expect(payload.passthrough).toBe(true);
  });

  it("formats a normal channel in json mode with fields and when tree", () => {
    const file = ChannelsFileSchema.parse({
      channels: [
        {
          channel: "default",
          model: "google/gemini-default",
          trigger: { when: [{ kind: "mention" }] },
        },
        { channel: "C1", model: "google/gemini-x" },
      ],
    });

    const out = formatEffectiveConfig(file, "C1", { json: true });
    const payload = JSON.parse(out);

    expect(payload.channel).toBe("C1");
    expect(payload.isDm).toBe(false);
    expect(payload.fields.model.value).toBe("google/gemini-x");
    expect(payload.fields.model.source).toBe("channel");
    expect(payload.when).toEqual([{ kind: "mention" }]);
  });
});

describe("formatWhen", () => {
  it("formats a classifier leaf with an explicit model", () => {
    const out = formatWhen([
      { kind: "classifier", criteria: "c", model: "gemini-x" },
    ]);
    expect(out).toBe("OR[ classifier(gemini-x) ]");
  });

  it("formats a classifier leaf without a model as 'code default'", () => {
    const out = formatWhen([{ kind: "classifier", criteria: "c" }]);
    expect(out).toBe("OR[ classifier(code default) ]");
  });

  it("formats a nested AND of mention and keyword", () => {
    const out = formatWhen([
      {
        and: [{ kind: "mention" }, { kind: "keyword", pattern: "x" }],
      },
    ]);
    expect(out).toBe("OR[ AND[ mention, keyword ] ]");
  });

  it("formats a sender leaf with its is value", () => {
    const out = formatWhen([{ kind: "sender", is: "bot" }]);
    expect(out).toBe("OR[ sender(is=bot) ]");
  });
});

describe("formatEffectiveConfig: trigger.allowBots", () => {
  it("shows trigger.allowBots when set to true", () => {
    const file = ChannelsFileSchema.parse({
      channels: [
        {
          channel: "default",
          trigger: {
            when: [
              {
                and: [
                  { kind: "sender", is: "bot" },
                  { kind: "keyword", pattern: "x" },
                ],
              },
            ],
            allowBots: true,
          },
        },
      ],
    });

    const out = formatEffectiveConfig(file, "C_NOT_FOUND", { json: false });
    expect(out).toMatch(/trigger\.allowBots:\s+true\s+← default/);
  });

  it("omits trigger.allowBots from pretty output when not set", () => {
    const file = ChannelsFileSchema.parse({
      channels: [
        { channel: "default", trigger: { when: [{ kind: "mention" }] } },
      ],
    });

    const out = formatEffectiveConfig(file, "C_NOT_FOUND", { json: false });
    expect(out).not.toContain("trigger.allowBots");
  });

  it("includes trigger.allowBots in json output with source and null when unset", () => {
    const file = ChannelsFileSchema.parse({
      channels: [
        { channel: "default", trigger: { when: [{ kind: "mention" }] } },
      ],
    });

    const out = formatEffectiveConfig(file, "C_NOT_FOUND", { json: true });
    const payload = JSON.parse(out);
    expect(payload.fields["trigger.allowBots"].value).toBe(null);
    expect(payload.fields["trigger.allowBots"].source).toBe("code default");
  });
});
