import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  type ChannelDoc,
  ChannelsFileSchema,
} from "../../src/config/channel-doc.js";
import {
  FileConfigSource,
  mergeChannelDoc,
  resolveChannelConfig,
} from "../../src/config/config-source.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "fixtures");

describe("FileConfigSource", () => {
  it("returns the matching channel doc by channel ID and inlines file references", async () => {
    const source = new FileConfigSource(join(FIXTURES_DIR, "config"));
    const doc = await source.channel("C0000000001");

    expect(doc).not.toBeNull();
    expect(doc?.systemPrompt).toBe(
      "You are a friendly assistant for this channel.\n",
    );
    expect(doc?.context).toEqual([
      "Extra context note inlined from a file reference.\n",
      "inline text without file reference",
    ]);
    expect(doc?.model).toBe("gemini-3-pro");
    expect(doc?.trigger?.when).toEqual([{ kind: "mention" }]);
    // channel field must not leak into the runtime ChannelDoc
    expect(doc).not.toHaveProperty("channel");
  });

  it("matches by '#name' form as a plain string", async () => {
    const source = new FileConfigSource(join(FIXTURES_DIR, "config"));
    const doc = await source.channel("#keyword-demo");

    expect(doc).not.toBeNull();
    expect(doc?.trigger?.when).toEqual([
      { kind: "keyword", pattern: "(?i)(help|error)" },
      { kind: "mention" },
    ]);
  });

  it("merges into the 'default' doc when no channel entry matches", async () => {
    const source = new FileConfigSource(join(FIXTURES_DIR, "config-default"));
    const doc = await source.channel("C_NOT_FOUND");
    expect(doc).not.toBeNull();
    expect(doc?.systemPrompt).toBe("default fallback prompt");
    expect(doc?.model).toBe("gemini-default");
  });

  it("merges the matching entry over 'default' (own keys win, unset inherit)", async () => {
    const source = new FileConfigSource(join(FIXTURES_DIR, "config-default"));
    const doc = await source.channel("C0000000001");
    expect(doc?.systemPrompt).toBe("specific channel prompt");
    expect(doc?.model).toBe("gemini-default");
  });

  it("does not fall back to the 'default' doc for the reserved DM name", async () => {
    // default doc は通常チャンネル向けの土台。dm エントリが無ければ DM は passthrough に
    // 落ちる必要があり、default を継承してはいけない (config.md §2.2)
    const source = new FileConfigSource(join(FIXTURES_DIR, "config-default"));
    const doc = await source.channel("dm");
    expect(doc).toBeNull();
  });

  it("returns the 'dm' doc by exact match when present", async () => {
    const source = new FileConfigSource(join(FIXTURES_DIR, "config-dm"));
    const doc = await source.channel("dm");
    expect(doc?.systemPrompt).toBe("dm prompt");
  });

  it("passes tools/excludeTools through from the channel doc", async () => {
    const source = new FileConfigSource(join(FIXTURES_DIR, "config-tools"));
    const doc = await source.channel("C0000000TOOLS");

    expect(doc?.tools).toEqual(["read", "grep"]);
    expect(doc?.excludeTools).toEqual(["write", "edit"]);
  });

  it("passes session/reply through from the channel doc", async () => {
    const source = new FileConfigSource(join(FIXTURES_DIR, "config-tools"));
    const doc = await source.channel("C0000000TOOLS");

    expect(doc?.session).toEqual({ mode: "channel", idleResetMinutes: 30 });
    expect(doc?.reply).toEqual({ mode: "flat" });
  });

  it("merges into 'default' when no entry matches (non-null)", async () => {
    const source = new FileConfigSource(join(FIXTURES_DIR, "config"));
    const doc = await source.channel("C_NOT_FOUND");
    expect(doc).not.toBeNull();
    expect(doc?.trigger?.when).toEqual([{ kind: "mention" }]);
  });

  it("throws when channels.yaml does not exist", async () => {
    const source = new FileConfigSource(join(FIXTURES_DIR, "does-not-exist"));
    await expect(source.channel("C0000000001")).rejects.toThrow(
      /channels\.yaml/,
    );
  });

  it("throws with file name and zod issue for schema violations", async () => {
    const source = new FileConfigSource(join(FIXTURES_DIR, "config-invalid"));
    await expect(source.channel("C0000000009")).rejects.toThrow(
      /channels\.yaml/,
    );
  });

  it("throws for malformed YAML", async () => {
    const source = new FileConfigSource(
      join(FIXTURES_DIR, "config-malformed-yaml"),
    );
    await expect(source.channel("C1")).rejects.toThrow(/channels\.yaml/);
  });

  it("throws when a referenced file is missing", async () => {
    const source = new FileConfigSource(
      join(FIXTURES_DIR, "config-missing-ref"),
    );
    await expect(source.channel("C0000000002")).rejects.toThrow(
      /does-not-exist\.md/,
    );
  });

  it("re-reads from disk on every call (no caching)", async () => {
    const source = new FileConfigSource(join(FIXTURES_DIR, "config"));
    const first = await source.channel("C0000000001");
    const second = await source.channel("C0000000001");
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });
});

describe("mergeChannelDoc", () => {
  it("uses own's value for keys own writes, base's value for keys own omits", () => {
    const base: ChannelDoc = {
      model: "m1",
      trigger: { when: [{ kind: "mention" }] },
    };
    const own: ChannelDoc = { model: "m2" };
    expect(mergeChannelDoc(base, own)).toEqual({
      model: "m2",
      trigger: { when: [{ kind: "mention" }] },
    });
  });

  it("replaces the whole trigger field wholesale (no inner merge)", () => {
    const base: ChannelDoc = {
      trigger: { when: [{ kind: "mention" }], debounceSec: 5 },
    };
    const own: ChannelDoc = {
      trigger: { when: [{ kind: "passthrough" }] },
    };
    expect(mergeChannelDoc(base, own)).toEqual({
      trigger: { when: [{ kind: "passthrough" }] },
    });
  });

  it("returns an empty doc when both base and own omit a key", () => {
    expect(mergeChannelDoc({}, {})).toEqual({});
  });
});

describe("resolveChannelConfig", () => {
  it("marks own-written keys as 'channel' and omitted keys as 'default'", () => {
    const file = ChannelsFileSchema.parse({
      channels: [
        {
          channel: "default",
          systemPrompt: "default prompt",
          trigger: { when: [{ kind: "mention" }] },
        },
        { channel: "C1", model: "gemini-x" },
      ],
    });
    const resolved = resolveChannelConfig(file, "C1");
    expect(resolved).not.toBeNull();
    expect(resolved?.doc.model).toBe("gemini-x");
    expect(resolved?.doc.systemPrompt).toBe("default prompt");
    expect(resolved?.provenance.model).toBe("channel");
    expect(resolved?.provenance.systemPrompt).toBe("default");
  });

  it("resolves the dm entry without inheriting from 'default'", () => {
    const file = ChannelsFileSchema.parse({
      channels: [
        {
          channel: "default",
          systemPrompt: "default prompt",
          model: "gemini-default",
        },
        { channel: "dm", systemPrompt: "dm prompt" },
      ],
    });
    const resolved = resolveChannelConfig(file, "dm");
    expect(resolved).not.toBeNull();
    // DM は dm エントリ単独。default の model は継承せず、dm 由来のフィールドは
    // provenance "dm" (channel ではない) になる (config.md §2.1, §6)。
    expect(resolved?.doc).toEqual({ systemPrompt: "dm prompt" });
    expect(resolved?.provenance).toEqual({ systemPrompt: "dm" });
  });

  it("returns the default doc alone (all provenance 'default') when id has no matching entry", () => {
    const file = ChannelsFileSchema.parse({
      channels: [
        {
          channel: "default",
          systemPrompt: "default prompt",
          model: "gemini-default",
        },
      ],
    });
    const resolved = resolveChannelConfig(file, "C_NOT_FOUND");
    expect(resolved).not.toBeNull();
    expect(resolved?.doc).toEqual({
      systemPrompt: "default prompt",
      model: "gemini-default",
    });
    expect(resolved?.provenance).toEqual({
      systemPrompt: "default",
      model: "default",
    });
  });

  it("returns null for dm when no dm entry exists", () => {
    const file = ChannelsFileSchema.parse({
      channels: [{ channel: "default", systemPrompt: "default prompt" }],
    });
    expect(resolveChannelConfig(file, "dm")).toBeNull();
  });
});
