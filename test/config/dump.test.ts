import { describe, expect, it } from "vitest";

import { ChannelsFileSchema } from "../../src/config/channel-config.js";
import { formatEffectiveConfig, formatWhen } from "../../src/config/dump.js";
import { SandboxRulesSchema } from "../../src/config/sandbox-config.js";

describe("formatEffectiveConfig", () => {
  it("formats a normal channel in pretty mode with per-field provenance", () => {
    const file = ChannelsFileSchema.parse({
      channels: [
        {
          channel: "default",
          trigger: { when: [{ kind: "mention" }] },
          agent: { model: "google/gemini-default" },
        },
        {
          channel: "C1",
          agent: { systemPrompt: "p", model: "google/gemini-x" },
        },
      ],
    });

    const out = formatEffectiveConfig(file, "C1", { json: false });

    expect(out).toContain("channel: C1");
    // Channel 部分と Agent 部分は別セクションに分かれる (config.md §5)
    expect(out).toContain("[channel]");
    expect(out).toContain("[agent]");
    expect(out).toMatch(/model:\s+google\/gemini-x\s+← channel agent/);
    expect(out).toMatch(/systemPrompt:.*← channel agent/);
    expect(out).toContain("OR[ mention ]");
    expect(out).toMatch(/trigger\.when:.*← default/);
  });

  it("labels top-level agent block fields '← default agent'", () => {
    const file = ChannelsFileSchema.parse({
      channels: [
        { channel: "default", trigger: { when: [{ kind: "mention" }] } },
      ],
    });

    const out = formatEffectiveConfig(file, "C1", {
      json: false,
      defaultAgent: { model: "google/gemini-top" },
    });
    expect(out).toMatch(/model:\s+google\/gemini-top\s+← default agent/);
  });

  it("dumps memory: false set on the default entry's agent as '← channel agent'", () => {
    const file = ChannelsFileSchema.parse({
      channels: [
        {
          channel: "default",
          trigger: { when: [{ kind: "mention" }] },
          agent: { memory: false },
        },
      ],
    });

    const out = formatEffectiveConfig(file, "C_NOT_FOUND", {
      json: false,
      defaultAgent: { memory: true },
    });
    expect(out).toMatch(/memory:\s+false\s+← channel agent/);
  });

  it("dumps memory from the top-level agent block as '← default agent'", () => {
    const file = ChannelsFileSchema.parse({
      channels: [
        { channel: "default", trigger: { when: [{ kind: "mention" }] } },
      ],
    });

    const out = formatEffectiveConfig(file, "C_NOT_FOUND", {
      json: false,
      defaultAgent: { memory: false },
    });
    expect(out).toMatch(/memory:\s+false\s+← default agent/);
  });

  it("shows memory's code default (true) when nothing sets it", () => {
    const file = ChannelsFileSchema.parse({
      channels: [
        { channel: "default", trigger: { when: [{ kind: "mention" }] } },
      ],
    });

    const out = formatEffectiveConfig(file, "C_NOT_FOUND", { json: false });
    expect(out).toMatch(/memory:\s+true\s+← code default/);
  });

  // dump は agent.env の ${env.X} を解決しない — 書かれたままの参照文字列を出す
  // (config.md §2.1, §5)。この経路が secret を漏らさない保証そのもの。
  it("prints agent.env values as the unresolved reference string", () => {
    const file = ChannelsFileSchema.parse({
      channels: [
        {
          channel: "default",
          trigger: { when: [{ kind: "mention" }] },
          agent: { env: { PAGERDUTY_TOKEN: "${env.PAGERDUTY_TOKEN}" } },
        },
      ],
    });

    const out = formatEffectiveConfig(file, "C_NOT_FOUND", { json: false });
    expect(out).toContain("{PAGERDUTY_TOKEN=${env.PAGERDUTY_TOKEN}}");
  });

  it("formats the default entry alone (id has no matching entry) with all fields '← default'", () => {
    const file = ChannelsFileSchema.parse({
      channels: [
        {
          channel: "default",
          trigger: { when: [{ kind: "mention" }] },
          agent: { model: "google/gemini-default" },
        },
      ],
    });

    const out = formatEffectiveConfig(file, "C_NOT_FOUND", { json: false });

    expect(out).toContain("channel: C_NOT_FOUND");
    expect(out).toMatch(/model:\s+google\/gemini-default\s+← channel agent/);
    expect(out).toMatch(/trigger\.when:.*OR\[ mention \].*← default/);
  });

  it("shows '(pi default)' for an unset model", () => {
    const file = ChannelsFileSchema.parse({
      channels: [
        { channel: "default", trigger: { when: [{ kind: "mention" }] } },
      ],
    });
    const out = formatEffectiveConfig(file, "C_NOT_FOUND", { json: false });
    expect(out).toMatch(/model:\s+\(pi default\)\s+← code default/);
  });

  it("formats a DM with a dm entry: dm-authored fields show '← dm' (no inheritance from default)", () => {
    const file = ChannelsFileSchema.parse({
      channels: [
        { channel: "default", trigger: { when: [{ kind: "mention" }] } },
        { channel: "dm", reply: { mode: "flat" } },
      ],
    });

    const out = formatEffectiveConfig(file, "dm", { json: false });

    expect(out).toContain("channel: dm (dm)");
    // dm エントリ由来のフィールドは provenance "dm" になる (default/channel ではない)
    expect(out).toMatch(/reply\.mode:\s+flat\s+← dm/);
    // default の trigger は継承しない
    expect(out).toMatch(/trigger\.when:\s+disabled\s+← code default/);

    // DM 既定は session.mode=channel (エントリに無く、default も継承しない)
    expect(out).toMatch(/session\.mode:\s+channel\s+← code default/);
  });

  it("formats DM code default (no dm entry) as disabled in pretty mode", () => {
    const file = ChannelsFileSchema.parse({
      channels: [{ channel: "default" }],
    });

    const out = formatEffectiveConfig(file, "dm", { json: false });

    expect(out).toContain("channel: dm (dm)");
    expect(out).toMatch(/disabled/);
  });

  it("formats DM code default (no dm entry) in json mode", () => {
    const file = ChannelsFileSchema.parse({
      channels: [{ channel: "default" }],
    });

    const out = formatEffectiveConfig(file, "dm", { json: true });
    const payload = JSON.parse(out);

    expect(payload.channel).toBe("dm");
    expect(payload.isDm).toBe(true);
    expect(payload.codeDefault).toBe(true);
    expect(payload.note).toMatch(/disabled for dm/);
  });

  it("formats a normal channel in json mode with channel/agent fields and the when tree", () => {
    const file = ChannelsFileSchema.parse({
      channels: [
        {
          channel: "default",
          trigger: { when: [{ kind: "mention" }] },
          agent: { model: "google/gemini-default" },
        },
        { channel: "C1", agent: { model: "google/gemini-x" } },
      ],
    });

    const out = formatEffectiveConfig(file, "C1", {
      json: true,
      defaultAgent: { memory: false },
    });
    const payload = JSON.parse(out);

    expect(payload.channel).toBe("C1");
    expect(payload.isDm).toBe(false);
    expect(payload.agentFields.model.value).toBe("google/gemini-x");
    expect(payload.agentFields.model.source).toBe("channel agent");
    expect(payload.agentFields.memory.value).toBe(false);
    expect(payload.agentFields.memory.source).toBe("default agent");
    expect(payload.channelFields["reply.mode"].source).toBe("code default");
    expect(payload.when).toEqual([{ kind: "mention" }]);
  });

  it("shows sandbox as disabled by code default and as merged rules when set", () => {
    const file = ChannelsFileSchema.parse({
      channels: [
        { channel: "default", trigger: { when: [{ kind: "mention" }] } },
        {
          channel: "C1",
          agent: { sandbox: { network: { allowedDomains: ["github.com"] } } },
        },
      ],
    });
    const off = formatEffectiveConfig(file, "C2", { json: false });
    expect(off).toMatch(/sandbox:\s+disabled\s+← code default/);

    const defaultAgent = {
      sandbox: SandboxRulesSchema.parse({
        network: { allowedDomains: ["api.example.com:443"] },
      }),
    };
    const on = formatEffectiveConfig(file, "C1", { json: false, defaultAgent });
    expect(on).toMatch(
      /sandbox:\s+enabled \(allowedDomains: 2,.*← channel agent/,
    );

    const json = JSON.parse(
      formatEffectiveConfig(file, "C1", { json: true, defaultAgent }),
    );
    expect(json.agentFields.sandbox.value.network.allowedDomains).toEqual([
      "api.example.com:443",
      "github.com",
    ]);
    expect(json.agentFields.sandbox.source).toBe("channel agent");
    const jsonOff = JSON.parse(
      formatEffectiveConfig(file, "C2", { json: true }),
    );
    expect(jsonOff.agentFields.sandbox.value).toBe(false);
  });

  it("prints agent.env unresolved in json mode too", () => {
    const file = ChannelsFileSchema.parse({
      channels: [
        {
          channel: "default",
          agent: { env: { GH_TOKEN: "${env.GH_TOKEN}" } },
        },
      ],
    });

    const payload = JSON.parse(
      formatEffectiveConfig(file, "C_NOT_FOUND", { json: true }),
    );
    expect(payload.agentFields.env.value).toEqual({
      GH_TOKEN: "${env.GH_TOKEN}",
    });
  });
});

describe("formatEffectiveConfig: trigger.whileRunning", () => {
  it("shows the code default (passthrough) when unset", () => {
    const file = ChannelsFileSchema.parse({
      channels: [
        { channel: "default", trigger: { when: [{ kind: "mention" }] } },
      ],
    });
    const out = formatEffectiveConfig(file, "C_NOT_FOUND", { json: false });
    expect(out).toMatch(
      /trigger\.whileRunning:\s+passthrough\s+← code default/,
    );
  });

  it("shows an explicit whileRunning with its provenance", () => {
    const file = ChannelsFileSchema.parse({
      channels: [
        { channel: "default", trigger: { when: [{ kind: "mention" }] } },
        {
          channel: "C1",
          trigger: { when: [{ kind: "mention" }], whileRunning: "evaluate" },
        },
      ],
    });
    const out = formatEffectiveConfig(file, "C1", { json: false });
    expect(out).toMatch(/trigger\.whileRunning:\s+evaluate\s+← channel/);
  });

  it("includes trigger.whileRunning in json output", () => {
    const file = ChannelsFileSchema.parse({
      channels: [
        {
          channel: "default",
          trigger: { when: [{ kind: "mention" }], whileRunning: "evaluate" },
        },
      ],
    });
    const payload = JSON.parse(
      formatEffectiveConfig(file, "C_NOT_FOUND", { json: true }),
    );
    expect(payload.channelFields["trigger.whileRunning"].value).toBe(
      "evaluate",
    );
    expect(payload.channelFields["trigger.whileRunning"].source).toBe(
      "default",
    );
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

  // is を書かず name / id だけで絞る形も有効 (config.md §4.2)。
  // 未指定の is を "is=undefined" と出さないこと。
  it("formats a sender leaf that filters by name only", () => {
    const out = formatWhen([{ kind: "sender", name: ["alice", "bob"] }]);
    expect(out).toBe("OR[ sender(name=[alice, bob]) ]");
  });

  it("formats a sender leaf that filters by id only", () => {
    const out = formatWhen([{ kind: "sender", id: ["U01"] }]);
    expect(out).toBe("OR[ sender(id=[U01]) ]");
  });

  it("formats a sender leaf combining is and name", () => {
    const out = formatWhen([{ kind: "sender", is: "human", name: ["alice"] }]);
    expect(out).toBe("OR[ sender(is=human, name=[alice]) ]");
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
    expect(payload.channelFields["trigger.allowBots"].value).toBe(null);
    expect(payload.channelFields["trigger.allowBots"].source).toBe(
      "code default",
    );
  });
});
