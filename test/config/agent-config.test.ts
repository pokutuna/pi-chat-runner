import { describe, expect, it } from "vitest";

import { AgentConfigSchema } from "../../src/config/agent-config.js";

describe("AgentConfigSchema", () => {
  it("accepts an empty object (all fields omitted)", () => {
    expect(AgentConfigSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a fully populated config", () => {
    const result = AgentConfigSchema.safeParse({
      systemPrompt: "./prompts/ask-ai.md",
      context: ["./prompts/note.md", "inline text"],
      model: "google-vertex/gemini-3.5-flash",
      tools: ["read", "grep"],
      excludeTools: ["write", "edit"],
      skills: ["/app/skills/gc-logging", "./skills/local"],
      extensions: ["/app/extensions/bq-runner.ts", "../ext/local.ts"],
      memory: false,
      env: { GH_TOKEN: "${env.GH_TOKEN}", TEAM: "salmon" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown keys (strict)", () => {
    expect(AgentConfigSchema.safeParse({ unknown: true }).success).toBe(false);
  });

  // System Config 側のフィールドが agent ブロックへ紛れ込むのを弾く
  // (runtime / turnTimeoutMs 等は system の管轄で、agent には存在しない)。
  it.each([
    "runtime",
    "turnTimeoutMs",
    "progressNoticeIntervalMs",
    "provider",
    "envPassthrough",
  ])("rejects the removed/moved %s field", (key) => {
    expect(AgentConfigSchema.safeParse({ [key]: 1 }).success).toBe(false);
  });

  describe("model", () => {
    it("accepts a canonical provider/model-id", () => {
      expect(
        AgentConfigSchema.safeParse({ model: "google-vertex/gemini-3-pro" })
          .success,
      ).toBe(true);
    });

    it("accepts a model with a thinking-level suffix", () => {
      expect(
        AgentConfigSchema.safeParse({
          model: "google-vertex/gemini-3.1-pro:high",
        }).success,
      ).toBe(true);
    });

    it("rejects a bare model id without a provider prefix", () => {
      expect(
        AgentConfigSchema.safeParse({ model: "gemini-3.5-flash" }).success,
      ).toBe(false);
    });
  });

  describe("skills / extensions paths", () => {
    it.each(["skills", "extensions"])(
      "accepts absolute and ./ ../ relative paths under %s",
      (key) => {
        expect(
          AgentConfigSchema.safeParse({
            [key]: ["/app/x", "./x", "../x"],
          }).success,
        ).toBe(true);
      },
    );

    it.each(["skills", "extensions"])(
      "rejects a bare relative path under %s",
      (key) => {
        expect(
          AgentConfigSchema.safeParse({ [key]: ["foo/bar"] }).success,
        ).toBe(false);
      },
    );
  });

  describe("memory", () => {
    it.each([true, false])("accepts memory: %s", (memory) => {
      const result = AgentConfigSchema.safeParse({ memory });
      expect(result.success).toBe(true);
      expect(result.data?.memory).toBe(memory);
    });

    it("rejects a non-boolean memory", () => {
      expect(AgentConfigSchema.safeParse({ memory: "false" }).success).toBe(
        false,
      );
    });
  });

  describe("env", () => {
    it("accepts a string map", () => {
      const result = AgentConfigSchema.safeParse({
        env: { GH_TOKEN: "secret" },
      });
      expect(result.success).toBe(true);
      expect(result.data?.env).toEqual({ GH_TOKEN: "secret" });
    });

    it("rejects non-string values", () => {
      expect(AgentConfigSchema.safeParse({ env: { FOO: 1 } }).success).toBe(
        false,
      );
    });

    // ${env.X} の解決はローダー (config-source.ts) の仕事で、schema は素通しする。
    it("accepts an unresolved ${env.X} reference as a plain string", () => {
      const result = AgentConfigSchema.safeParse({
        env: { GH_TOKEN: "${env.GH_TOKEN}" },
      });
      expect(result.success).toBe(true);
      expect(result.data?.env?.GH_TOKEN).toBe("${env.GH_TOKEN}");
    });
  });
});
