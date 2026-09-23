import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentConfig } from "../../src/config/agent-config.js";
import { ChannelsFileSchema } from "../../src/config/channel-config.js";
import {
  type ChannelPart,
  FileConfigSource,
  loadChannelConfigFile,
  mergeAgentConfig,
  mergeChannelPart,
  resolveChannelConfig,
} from "../../src/config/config-source.js";
import { SandboxRulesSchema } from "../../src/config/sandbox-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "fixtures");
const REPO_ROOT = join(__dirname, "..", "..");

describe("FileConfigSource", () => {
  it("returns the matching channel by ID and inlines file references", async () => {
    const source = new FileConfigSource(
      join(FIXTURES_DIR, "config/channels.yaml"),
    );
    const channel = await source.channel("C0000000001");

    expect(channel).not.toBeNull();
    expect(channel?.agent.systemPrompt).toBe(
      "You are a friendly assistant for this channel.\n",
    );
    expect(channel?.agent.context).toEqual([
      "Extra context note inlined from a file reference.\n",
      "inline text without file reference",
    ]);
    expect(channel?.agent.model).toBe("google/gemini-3-pro");
    expect(channel?.trigger?.when).toEqual([{ kind: "mention" }]);
    // channel field must not leak into the runtime ResolvedChannel
    expect(channel).not.toHaveProperty("channel");
  });

  it("matches by '#name' form as a plain string", async () => {
    const source = new FileConfigSource(
      join(FIXTURES_DIR, "config/channels.yaml"),
    );
    const channel = await source.channel("#keyword-demo");

    expect(channel).not.toBeNull();
    expect(channel?.trigger?.when).toEqual([
      { kind: "keyword", pattern: "(?i)(help|error)" },
      { kind: "mention" },
    ]);
  });

  it("merges into the 'default' entry when no channel entry matches", async () => {
    const source = new FileConfigSource(
      join(FIXTURES_DIR, "config-default/channels.yaml"),
    );
    const channel = await source.channel("C_NOT_FOUND");
    expect(channel).not.toBeNull();
    expect(channel?.agent.systemPrompt).toBe("default fallback prompt");
    expect(channel?.agent.model).toBe("google/gemini-default");
  });

  it("merges the matching entry over 'default' (own keys win, unset inherit)", async () => {
    const source = new FileConfigSource(
      join(FIXTURES_DIR, "config-default/channels.yaml"),
    );
    const channel = await source.channel("C0000000001");
    expect(channel?.agent.systemPrompt).toBe("specific channel prompt");
    expect(channel?.agent.model).toBe("google/gemini-default");
  });

  it("does not fall back to the 'default' entry for the reserved DM name", async () => {
    // default は通常チャンネル向けの土台。dm エントリが無ければ DM は無効に
    // 落ちる必要があり、default を継承してはいけない (config.md §3.1)
    const source = new FileConfigSource(
      join(FIXTURES_DIR, "config-default/channels.yaml"),
    );
    expect(await source.channel("dm")).toBeNull();
  });

  it("returns the 'dm' entry by exact match when present", async () => {
    const source = new FileConfigSource(
      join(FIXTURES_DIR, "config-dm/channels.yaml"),
    );
    const channel = await source.channel("dm");
    expect(channel?.agent.systemPrompt).toBe("dm prompt");
  });

  it("passes agent.tools/excludeTools through", async () => {
    const source = new FileConfigSource(
      join(FIXTURES_DIR, "config-tools/channels.yaml"),
    );
    const channel = await source.channel("C0000000TOOLS");

    expect(channel?.agent.tools).toEqual(["read", "grep"]);
    expect(channel?.agent.excludeTools).toEqual(["write", "edit"]);
  });

  it("passes session/reply through", async () => {
    const source = new FileConfigSource(
      join(FIXTURES_DIR, "config-tools/channels.yaml"),
    );
    const channel = await source.channel("C0000000TOOLS");

    expect(channel?.session).toEqual({ mode: "channel", idleResetMinutes: 30 });
    expect(channel?.reply).toEqual({ mode: "flat" });
  });

  it("merges into 'default' when no entry matches (non-null)", async () => {
    const source = new FileConfigSource(
      join(FIXTURES_DIR, "config/channels.yaml"),
    );
    const channel = await source.channel("C_NOT_FOUND");
    expect(channel).not.toBeNull();
    expect(channel?.trigger?.when).toEqual([{ kind: "mention" }]);
  });

  it("absolutizes agent skills/extensions relative refs from the config file's directory", async () => {
    const source = new FileConfigSource(
      join(FIXTURES_DIR, "config-paths/channels.yaml"),
    );
    const channel = await source.channel("C0000000PATHS");

    // ./ は設定ファイルの dir 基準で絶対化、絶対パスはそのまま (内容は読まない)
    expect(channel?.agent.skills).toEqual([
      join(FIXTURES_DIR, "config-paths/skills/local-skill"),
      "/app/skills/baked-skill",
    ]);
    expect(channel?.agent.extensions).toEqual([
      join(FIXTURES_DIR, "config-paths/extensions/local-ext.ts"),
      "/app/extensions/baked-ext.ts",
    ]);
  });

  it("absolutizes skills refs even when the config path itself is relative", async () => {
    // CONFIG_PATH が相対パス (例 develop/config/agent.yaml) のとき baseDir も
    // 相対になる。join では相対のまま残り再検証で落ちるため、cwd 基準まで
    // resolve で絶対化する (実運用で踏んだ回帰)
    const relativePath = relative(
      process.cwd(),
      join(FIXTURES_DIR, "config-paths/channels.yaml"),
    );
    const source = new FileConfigSource(relativePath);
    const channel = await source.channel("C0000000PATHS");
    expect(channel?.agent.skills?.[0]).toBe(
      join(FIXTURES_DIR, "config-paths/skills/local-skill"),
    );
    expect(isAbsolute(channel?.agent.skills?.[0] ?? "")).toBe(true);
  });

  it("rejects bare relative paths (no ./ prefix) in agent.skills/extensions", () => {
    // 裸の相対パスは基準が曖昧 (config dir か workdir か) なので schema で弾く
    const result = ChannelsFileSchema.safeParse({
      channels: [
        { channel: "default" },
        { channel: "C1", agent: { skills: ["skills/foo"] } },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("throws when the config file does not exist", async () => {
    const source = new FileConfigSource(
      join(FIXTURES_DIR, "does-not-exist/agent.yaml"),
    );
    await expect(source.channel("C0000000001")).rejects.toThrow(/not found/);
  });

  it("ignores the system block and its env refs", async () => {
    // 単一ファイル config では system に secrets を含むブロックが同居するが、
    // agent/channels の読み込みはそこに触れない (${env.X} が未設定でも throw しない)
    const source = new FileConfigSource(
      join(FIXTURES_DIR, "config-single-file/agent.yaml"),
    );
    const channel = await source.channel("C_NOT_FOUND");
    expect(channel?.agent.systemPrompt).toBe("single-file default prompt");
  });

  it("throws with file name and zod issue for schema violations", async () => {
    const source = new FileConfigSource(
      join(FIXTURES_DIR, "config-invalid/channels.yaml"),
    );
    await expect(source.channel("C0000000009")).rejects.toThrow(
      /channels\.yaml/,
    );
  });

  it("throws for malformed YAML", async () => {
    const source = new FileConfigSource(
      join(FIXTURES_DIR, "config-malformed-yaml/channels.yaml"),
    );
    await expect(source.channel("C1")).rejects.toThrow(/channels\.yaml/);
  });

  it("throws when a referenced file is missing", async () => {
    const source = new FileConfigSource(
      join(FIXTURES_DIR, "config-missing-ref/channels.yaml"),
    );
    await expect(source.channel("C0000000002")).rejects.toThrow(
      /does-not-exist\.md/,
    );
  });

  describe("mtime caching", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "config-source-cache-test-"));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("reuses the parsed result when the file's mtime is unchanged", async () => {
      const configPath = join(dir, "channels.yaml");
      await writeFile(
        configPath,
        "channels:\n  - channel: default\n    agent:\n      model: google/gemini-a\n",
      );
      const source = new FileConfigSource(configPath);

      const first = await source.channel("C_NOT_FOUND");
      const second = await source.channel("C_NOT_FOUND");
      expect(first).toEqual(second);
    });

    it("re-reads when the file's mtime changes (edit without restart)", async () => {
      const configPath = join(dir, "channels.yaml");
      await writeFile(
        configPath,
        "channels:\n  - channel: default\n    agent:\n      model: google/gemini-a\n",
      );
      const source = new FileConfigSource(configPath);
      const first = await source.channel("C_NOT_FOUND");
      expect(first?.agent.model).toBe("google/gemini-a");

      await writeFile(
        configPath,
        "channels:\n  - channel: default\n    agent:\n      model: google/gemini-b\n",
      );
      // mtime の解像度がファイルシステムによっては粗いため、変化を確実に検知
      // させるために明示的に mtime を進める
      const future = new Date(Date.now() + 60_000);
      await utimes(configPath, future, future);

      const second = await source.channel("C_NOT_FOUND");
      expect(second?.agent.model).toBe("google/gemini-b");
    });
  });
});

describe("loadChannelConfigFile", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "config-load-test-"));
    path = join(dir, "agent.yaml");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the top-level agent block as defaultAgent", async () => {
    await writeFile(
      path,
      [
        "agent:",
        "  model: google/gemini-default",
        "  memory: true",
        "channels:",
        "  - channel: default",
        "    trigger:",
        "      when: [{ kind: mention }]",
        "",
      ].join("\n"),
    );
    const { defaultAgent } = await loadChannelConfigFile(path, {});
    expect(defaultAgent).toEqual({
      model: "google/gemini-default",
      memory: true,
    });
  });

  it("returns an empty defaultAgent when the agent block is omitted", async () => {
    await writeFile(path, "channels:\n  - channel: default\n");
    const { defaultAgent } = await loadChannelConfigFile(path, {});
    expect(defaultAgent).toEqual({});
  });

  // ${env.X} を解決するのは agent.env / channels[].agent.env の値だけ (config.md §2.1)
  it("resolves ${env.X} references in agent.env", async () => {
    await writeFile(
      path,
      [
        "agent:",
        "  env:",
        "    GH_TOKEN: ${env.TEST_GH_TOKEN}",
        "    FALLBACK: ${env.TEST_UNSET_X:-fallback}",
        "channels:",
        "  - channel: default",
        "",
      ].join("\n"),
    );
    const { defaultAgent } = await loadChannelConfigFile(path, {
      TEST_GH_TOKEN: "resolved-secret",
    });
    expect(defaultAgent.env).toEqual({
      GH_TOKEN: "resolved-secret",
      FALLBACK: "fallback",
    });
  });

  it("resolves ${env.X} references in channels[].agent.env", async () => {
    await writeFile(
      path,
      [
        "channels:",
        "  - channel: default",
        "  - channel: C1",
        "    agent:",
        "      env:",
        "        PAGERDUTY_TOKEN: ${env.TEST_PD_TOKEN}",
        "",
      ].join("\n"),
    );
    const { file } = await loadChannelConfigFile(path, {
      TEST_PD_TOKEN: "pd-secret",
    });
    const entry = file.channels.find((c) => c.channel === "C1");
    expect(entry?.agent?.env).toEqual({ PAGERDUTY_TOKEN: "pd-secret" });
  });

  it("throws when a required ${env.X} reference in agent.env is unset", async () => {
    await writeFile(
      path,
      [
        "agent:",
        "  env:",
        "    GH_TOKEN: ${env.TEST_UNSET_TOKEN_XYZ}",
        "channels:",
        "  - channel: default",
        "",
      ].join("\n"),
    );
    // 変数名は cause 側 (env-ref.ts) に載る
    await expect(loadChannelConfigFile(path, {})).rejects.toThrow(
      /failed to resolve .* in agent\.env/,
    );
    await expect(loadChannelConfigFile(path, {})).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining("TEST_UNSET_TOKEN_XYZ"),
      }),
    });
  });

  // agent ブロック外のフィールドは ${env.X} を解決しない — dump が secret を
  // 解決済みで出さない性質はこの非解決に依っている (config.md §2.1, §5)
  it("leaves ${env.X} in non-env agent fields untouched", async () => {
    await writeFile(
      path,
      [
        "agent:",
        "  systemPrompt: literal ${env.TEST_UNSET_TOKEN_XYZ}",
        "channels:",
        "  - channel: default",
        "",
      ].join("\n"),
    );
    const { defaultAgent } = await loadChannelConfigFile(path, {});
    expect(defaultAgent.systemPrompt).toBe(
      "literal ${env.TEST_UNSET_TOKEN_XYZ}",
    );
  });

  // dump 経路 (config.md §5): agent.env すら解決せず、書かれたままの参照文字列を
  // 残す。これにより dump が secret を解決した値を stdout に出すことがなくなる。
  it("leaves agent.env unresolved with resolveEnv: false", async () => {
    await writeFile(
      path,
      [
        "agent:",
        "  env:",
        "    GH_TOKEN: ${env.TEST_GH_TOKEN}",
        "channels:",
        "  - channel: default",
        "    agent:",
        "      env:",
        "        PD_TOKEN: ${env.TEST_PD_TOKEN}",
        "",
      ].join("\n"),
    );
    const { file, defaultAgent } = await loadChannelConfigFile(
      path,
      { TEST_GH_TOKEN: "resolved-secret", TEST_PD_TOKEN: "pd-secret" },
      { resolveEnv: false },
    );
    expect(defaultAgent.env).toEqual({ GH_TOKEN: "${env.TEST_GH_TOKEN}" });
    expect(file.channels[0]?.agent?.env).toEqual({
      PD_TOKEN: "${env.TEST_PD_TOKEN}",
    });
  });

  it("does not throw on unset env refs with resolveEnv: false", async () => {
    await writeFile(
      path,
      [
        "agent:",
        "  env:",
        "    GH_TOKEN: ${env.TEST_UNSET_TOKEN_XYZ}",
        "channels:",
        "  - channel: default",
        "",
      ].join("\n"),
    );
    const { defaultAgent } = await loadChannelConfigFile(
      path,
      {},
      { resolveEnv: false },
    );
    expect(defaultAgent.env).toEqual({
      GH_TOKEN: "${env.TEST_UNSET_TOKEN_XYZ}",
    });
  });

  it("throws when the channels block is missing", async () => {
    await writeFile(path, "agent:\n  model: google/gemini-a\n");
    await expect(loadChannelConfigFile(path, {})).rejects.toThrow(/channels/);
  });

  it("throws naming the three valid blocks for an unknown top-level block", async () => {
    await writeFile(
      path,
      "connector:\n  slack: {}\nchannels:\n  - channel: default\n",
    );
    await expect(loadChannelConfigFile(path, {})).rejects.toThrow(
      /system, agent, channels/,
    );
  });
});

describe("agent.sandbox", () => {
  const configPath = join(FIXTURES_DIR, "config-sandbox/agent.yaml");
  const rulesPath = join(FIXTURES_DIR, "config-sandbox/rules/base.json");
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "config-sandbox-test-"));
    path = join(dir, "agent.yaml");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads the top-level rule file relative to the config file and normalizes it", async () => {
    const { defaultAgent } = await loadChannelConfigFile(configPath, {});
    expect(defaultAgent.sandbox).not.toBe(false);
    expect(defaultAgent.sandbox).toMatchObject({
      network: {
        allowedDomains: [
          "oauth2.googleapis.com:443",
          "aiplatform.googleapis.com:443",
        ],
        deniedDomains: [],
        strictAllowlist: true,
      },
      filesystem: { denyRead: ["~/.ssh"], allowWrite: [] },
    });
  });

  it("unions channel additions onto the top-level rules through all three stages", async () => {
    const source = new FileConfigSource(configPath);
    const channel = await source.channel("C0GITHUB01");
    const sandbox = channel?.agent.sandbox;
    expect(sandbox).not.toBe(false);
    if (sandbox === undefined || sandbox === false)
      throw new Error("unreachable");
    // default エントリの追加 (deniedDomains) と C0GITHUB01 の追加 (allowedDomains 等) が
    // 両方入る。既に base にある oauth2 は重複しない
    expect(sandbox.network.allowedDomains).toEqual([
      "oauth2.googleapis.com:443",
      "aiplatform.googleapis.com:443",
      "github.com",
      "api.github.com",
    ]);
    expect(sandbox.network.deniedDomains).toEqual(["*.example.org"]);
    expect(sandbox.network.strictAllowlist).toBe(true);
    expect(sandbox.filesystem.allowRead).toEqual(["/data/knowledge"]);
    expect(sandbox.credentials?.envVars).toEqual([
      { name: "GH_TOKEN", mode: "deny" },
    ]);
  });

  it("applies only the default entry's additions when the channel has no entry", async () => {
    const source = new FileConfigSource(configPath);
    const channel = await source.channel("C0OTHER");
    const sandbox = channel?.agent.sandbox;
    if (sandbox === undefined || sandbox === false)
      throw new Error("unreachable");
    expect(sandbox.network.allowedDomains).toEqual([
      "oauth2.googleapis.com:443",
      "aiplatform.googleapis.com:443",
    ]);
    expect(sandbox.network.deniedDomains).toEqual(["*.example.org"]);
  });

  it("disables the sandbox for a channel that writes sandbox: false", async () => {
    const source = new FileConfigSource(configPath);
    const channel = await source.channel("C0NOSANDBOX");
    expect(channel?.agent.sandbox).toBe(false);
  });

  it("leaves sandbox undefined when nothing sets it", async () => {
    const source = new FileConfigSource(
      join(FIXTURES_DIR, "config/channels.yaml"),
    );
    const channel = await source.channel("C0000000001");
    expect(channel?.agent.sandbox).toBeUndefined();
  });

  it("throws at load time when the rule file is missing (named)", async () => {
    await writeFile(
      path,
      `agent:\n  sandbox: ./nope.json\nchannels:\n  - channel: default\n`,
    );
    await expect(loadChannelConfigFile(path, {})).rejects.toThrow(
      /agent\.sandbox.*nope\.json/,
    );
  });

  it("throws at load time when the rule file has a forbidden key", async () => {
    await writeFile(
      path,
      `agent:\n  sandbox: ${join(FIXTURES_DIR, "config-sandbox-invalid.json")}\nchannels:\n  - channel: default\n`,
    );
    await expect(loadChannelConfigFile(path, {})).rejects.toThrow(
      /filesystem\.disabled/,
    );
  });

  it("accepts inline rules at the top level", async () => {
    await writeFile(
      path,
      [
        "agent:",
        "  sandbox:",
        "    network:",
        "      allowedDomains: [api.example.com:443]",
        "channels:",
        "  - channel: default",
      ].join("\n"),
    );
    const { defaultAgent } = await loadChannelConfigFile(path, {});
    expect(defaultAgent.sandbox).toMatchObject({
      network: { allowedDomains: ["api.example.com:443"] },
    });
  });

  it("rejects non-additive keys in channels[].agent.sandbox (strict, with the channel index)", async () => {
    await writeFile(
      path,
      [
        `agent:`,
        `  sandbox: ${rulesPath}`,
        `channels:`,
        `  - channel: default`,
        `  - channel: C1`,
        `    agent:`,
        `      sandbox:`,
        `        network:`,
        `          strictAllowlist: true`,
      ].join("\n"),
    );
    await expect(loadChannelConfigFile(path, {})).rejects.toThrow(
      /channels\.1\.agent\.sandbox/,
    );
  });

  it("throws when a channel adds rules but the top-level sandbox is disabled", async () => {
    await writeFile(
      path,
      [
        `channels:`,
        `  - channel: default`,
        `  - channel: C1`,
        `    agent:`,
        `      sandbox:`,
        `        network:`,
        `          allowedDomains: [github.com]`,
      ].join("\n"),
    );
    const source = new FileConfigSource(path);
    await expect(source.channel("C1")).rejects.toThrow(
      /channels\[C1\]\.agent\.sandbox adds rules/,
    );
    // 追加を書いていない Channel は影響を受けない
    await expect(source.channel("C2")).resolves.not.toBeNull();
  });

  it("throws when a channel adds rules after the default entry disabled the sandbox", async () => {
    await writeFile(
      path,
      [
        `agent:`,
        `  sandbox: ${rulesPath}`,
        `channels:`,
        `  - channel: default`,
        `    agent:`,
        `      sandbox: false`,
        `  - channel: C1`,
        `    agent:`,
        `      sandbox:`,
        `        network:`,
        `          allowedDomains: [github.com]`,
      ].join("\n"),
    );
    const source = new FileConfigSource(path);
    await expect(source.channel("C1")).rejects.toThrow(/adds rules/);
  });

  it("names the channel when a credential entry conflicts", async () => {
    await writeFile(
      path,
      [
        `agent:`,
        `  sandbox:`,
        `    credentials:`,
        `      envVars: [{ name: GH_TOKEN, mode: deny }]`,
        `channels:`,
        `  - channel: default`,
        `  - channel: C1`,
        `    agent:`,
        `      sandbox:`,
        `        credentials:`,
        `          envVars: [{ name: GH_TOKEN, mode: deny, extract: x }]`,
      ].join("\n"),
    );
    const source = new FileConfigSource(path);
    await expect(source.channel("C1")).rejects.toThrow(
      /channels\[C1\]\.agent\.sandbox: credentials\.envVars.*GH_TOKEN/,
    );
  });
});

// examples/ の設定ファイルが実ローダーを通ることを担保する (README の手順が
// そのまま動くこと + schema 変更時に examples の更新漏れを検知するため)
describe("example config files", () => {
  it.each([
    "examples/config/agent.yaml",
    "examples/config/agent.full.yaml",
    "examples/local-demo/agent.yaml",
    "examples/gc-logging-agent/config/agent.yaml",
    "examples/smart-fetch-agent/config/agent.yaml",
  ])("loads %s with the real loader", async (relPath) => {
    const source = new FileConfigSource(join(REPO_ROOT, relPath));
    const channel = await source.channel("default");
    expect(channel).not.toBeNull();
    expect(channel?.agent).toBeDefined();
  });
});

describe("mergeChannelPart", () => {
  it("uses own's value for keys own writes, base's value for keys own omits", () => {
    const base: ChannelPart = {
      trigger: { when: [{ kind: "mention" }] },
      reply: { mode: "thread" },
    };
    const own: ChannelPart = { reply: { mode: "flat" } };
    const { part, provenance } = mergeChannelPart(base, "default", own);
    expect(part).toEqual({
      trigger: { when: [{ kind: "mention" }] },
      reply: { mode: "flat" },
    });
    expect(provenance).toEqual({ trigger: "default", reply: "channel" });
  });

  it("replaces the whole trigger field wholesale (no inner merge)", () => {
    const base: ChannelPart = {
      trigger: { when: [{ kind: "mention" }], allowBots: true },
    };
    const own: ChannelPart = { trigger: { when: [{ kind: "passthrough" }] } };
    const { part } = mergeChannelPart(base, "default", own);
    expect(part).toEqual({ trigger: { when: [{ kind: "passthrough" }] } });
  });

  it("labels base-derived fields 'dm' when the base is the dm entry", () => {
    const { provenance } = mergeChannelPart(
      { reply: { mode: "flat" } },
      "dm",
      {},
    );
    expect(provenance).toEqual({ reply: "dm" });
  });

  it("returns an empty part when both base and own omit a key", () => {
    const { part, provenance } = mergeChannelPart({}, "default", {});
    expect(part).toEqual({});
    expect(provenance).toEqual({});
  });
});

describe("mergeAgentConfig", () => {
  // agent → channels[default].agent → channels[id].agent の 3 段 (config.md §3.2)
  it("layers the three stages, later stages winning per field", () => {
    const defaultAgent: AgentConfig = {
      model: "google/gemini-default",
      systemPrompt: "top-level prompt",
      memory: true,
    };
    const baseAgent: AgentConfig = { systemPrompt: "default entry prompt" };
    const ownAgent: AgentConfig = { model: "google/gemini-own" };

    const { agent, provenance } = mergeAgentConfig(
      defaultAgent,
      baseAgent,
      ownAgent,
    );
    expect(agent).toEqual({
      model: "google/gemini-own",
      systemPrompt: "default entry prompt",
      memory: true,
    });
    expect(provenance).toEqual({
      model: "channel agent",
      systemPrompt: "channel agent",
      memory: "default agent",
    });
  });

  it("keeps every field labelled 'default agent' when no channel overrides it", () => {
    const { agent, provenance } = mergeAgentConfig(
      { model: "google/gemini-default", tools: ["read"] },
      {},
      {},
    );
    expect(agent).toEqual({ model: "google/gemini-default", tools: ["read"] });
    expect(provenance).toEqual({
      model: "default agent",
      tools: "default agent",
    });
  });

  it("replaces array fields wholesale (no concat)", () => {
    const { agent } = mergeAgentConfig(
      { tools: ["read", "grep"] },
      {},
      { tools: ["bash"] },
    );
    expect(agent).toEqual({ tools: ["bash"] });
  });

  // memory は CHANNEL_DOC_KEYS の列挙漏れで落ちていたフィールド。
  // キー列挙が型で強制されるようになった回帰テスト。
  it("propagates memory: false from a later stage", () => {
    const { agent, provenance } = mergeAgentConfig(
      { memory: true },
      { memory: false },
      {},
    );
    expect(agent.memory).toBe(false);
    expect(provenance.memory).toBe("channel agent");
  });

  it("merges every AgentConfig field", () => {
    const full: AgentConfig = {
      systemPrompt: "p",
      context: ["c"],
      model: "google/m",
      tools: ["read"],
      excludeTools: ["write"],
      skills: ["/s"],
      extensions: ["/e.ts"],
      memory: false,
      env: { A: "1" },
      // Channel 側の sandbox は追加専用の形なので、ここでは無効化 (false) で網羅する
      sandbox: false,
    };
    const { agent, provenance } = mergeAgentConfig({}, {}, full);
    expect(agent).toEqual(full);
    for (const key of Object.keys(full)) {
      expect(provenance[key as keyof AgentConfig]).toBe("channel agent");
    }
  });

  it("unions sandbox additions onto the top-level rules instead of replacing", () => {
    const defaultAgent: AgentConfig = {
      sandbox: SandboxRulesSchema.parse({
        network: { allowedDomains: ["api.example.com:443"] },
      }),
    };
    const { agent, provenance } = mergeAgentConfig(
      defaultAgent,
      { sandbox: { network: { deniedDomains: ["x.example.com"] } } },
      { sandbox: { network: { allowedDomains: ["github.com"] } } },
    );
    expect(agent.sandbox).toMatchObject({
      network: {
        allowedDomains: ["api.example.com:443", "github.com"],
        deniedDomains: ["x.example.com"],
      },
    });
    expect(provenance.sandbox).toBe("channel agent");
  });

  it("keeps top-level sandbox rules with 'default agent' provenance when no channel touches them", () => {
    const defaultAgent: AgentConfig = { sandbox: SandboxRulesSchema.parse({}) };
    const { agent, provenance } = mergeAgentConfig(defaultAgent, {}, {});
    expect(agent.sandbox).toEqual(defaultAgent.sandbox);
    expect(provenance.sandbox).toBe("default agent");
  });

  it("returns an empty agent when all three stages are empty", () => {
    const { agent, provenance } = mergeAgentConfig({}, {}, {});
    expect(agent).toEqual({});
    expect(provenance).toEqual({});
  });
});

describe("resolveChannelConfig", () => {
  it("marks own-written channel keys as 'channel' and omitted keys as 'default'", () => {
    const file = ChannelsFileSchema.parse({
      channels: [
        {
          channel: "default",
          trigger: { when: [{ kind: "mention" }] },
          reply: { mode: "thread" },
        },
        { channel: "C1", reply: { mode: "flat" } },
      ],
    });
    const resolved = resolveChannelConfig(file, "C1");
    expect(resolved).not.toBeNull();
    expect(resolved?.channel.reply).toEqual({ mode: "flat" });
    expect(resolved?.channel.trigger?.when).toEqual([{ kind: "mention" }]);
    expect(resolved?.provenance.reply).toBe("channel");
    expect(resolved?.provenance.trigger).toBe("default");
  });

  it("runs the agent part through all three stages", () => {
    const file = ChannelsFileSchema.parse({
      channels: [
        { channel: "default", agent: { systemPrompt: "default entry prompt" } },
        { channel: "C1", agent: { model: "google/gemini-own" } },
      ],
    });
    const resolved = resolveChannelConfig(file, "C1", {
      model: "google/gemini-top",
      memory: true,
    });
    expect(resolved?.channel.agent).toEqual({
      model: "google/gemini-own",
      systemPrompt: "default entry prompt",
      memory: true,
    });
    expect(resolved?.agentProvenance).toEqual({
      model: "channel agent",
      systemPrompt: "channel agent",
      memory: "default agent",
    });
  });

  it("propagates memory: false set on the default entry's agent", () => {
    const file = ChannelsFileSchema.parse({
      channels: [
        { channel: "default", agent: { memory: false } },
        { channel: "C1" },
      ],
    });
    const resolved = resolveChannelConfig(file, "C1", { memory: true });
    expect(resolved?.channel.agent.memory).toBe(false);
    expect(resolved?.agentProvenance.memory).toBe("channel agent");
  });

  it("resolves the dm entry's channel part without inheriting from 'default'", () => {
    const file = ChannelsFileSchema.parse({
      channels: [
        {
          channel: "default",
          trigger: { when: [{ kind: "mention" }] },
          reply: { mode: "thread" },
        },
        { channel: "dm", reply: { mode: "flat" } },
      ],
    });
    const resolved = resolveChannelConfig(file, "dm");
    expect(resolved).not.toBeNull();
    // DM は dm エントリ単独。default の trigger は継承せず、dm 由来のフィールドは
    // provenance "dm" (channel ではない) になる (config.md §3.1, §3.3)。
    expect(resolved?.channel.trigger).toBeUndefined();
    expect(resolved?.channel.reply).toEqual({ mode: "flat" });
    expect(resolved?.provenance).toEqual({ reply: "dm" });
  });

  // DM は Channel 部分こそ default を継承しないが、Agent 部分はトップレベルの
  // agent ブロックを土台にする (config.md §3.1)
  it("still layers the top-level agent block under the dm entry's agent", () => {
    const file = ChannelsFileSchema.parse({
      channels: [
        { channel: "default", agent: { model: "google/gemini-default-entry" } },
        { channel: "dm", agent: { systemPrompt: "dm prompt" } },
      ],
    });
    const resolved = resolveChannelConfig(file, "dm", {
      model: "google/gemini-top",
      memory: true,
    });
    // default エントリの agent は DM には効かない
    expect(resolved?.channel.agent).toEqual({
      model: "google/gemini-top",
      memory: true,
      systemPrompt: "dm prompt",
    });
    expect(resolved?.agentProvenance).toEqual({
      model: "default agent",
      memory: "default agent",
      systemPrompt: "channel agent",
    });
  });

  it("returns the default entry alone (all provenance 'default') when id has no matching entry", () => {
    const file = ChannelsFileSchema.parse({
      channels: [
        {
          channel: "default",
          trigger: { when: [{ kind: "mention" }] },
          reply: { mode: "thread" },
        },
      ],
    });
    const resolved = resolveChannelConfig(file, "C_NOT_FOUND");
    expect(resolved).not.toBeNull();
    expect(resolved?.provenance).toEqual({
      trigger: "default",
      reply: "default",
    });
  });

  it("returns an empty agent object when nothing sets any agent field", () => {
    const file = ChannelsFileSchema.parse({
      channels: [{ channel: "default" }],
    });
    const resolved = resolveChannelConfig(file, "C_NOT_FOUND");
    expect(resolved?.channel.agent).toEqual({});
  });

  it("returns null for dm when no dm entry exists", () => {
    const file = ChannelsFileSchema.parse({
      channels: [{ channel: "default" }],
    });
    expect(resolveChannelConfig(file, "dm")).toBeNull();
  });

  it("merges trigger.whileRunning like any other trigger field", () => {
    const file = ChannelsFileSchema.parse({
      channels: [
        {
          channel: "default",
          trigger: { when: [{ kind: "mention" }], whileRunning: "passthrough" },
        },
        {
          channel: "C1",
          trigger: { when: [{ kind: "mention" }], whileRunning: "evaluate" },
        },
      ],
    });
    expect(
      resolveChannelConfig(file, "C1")?.channel.trigger?.whileRunning,
    ).toBe("evaluate");
    // trigger は丸ごと置換なので、書かないチャンネルは default の値を引き継ぐ
    expect(
      resolveChannelConfig(file, "C_NOT_FOUND")?.channel.trigger?.whileRunning,
    ).toBe("passthrough");
  });
});
