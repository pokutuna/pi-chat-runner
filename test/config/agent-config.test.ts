import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AgentConfigSchema,
  loadAgentConfig,
  resolveAgentConfig,
} from "../../src/config/agent-config.js";

describe("AgentConfigSchema", () => {
  it("accepts a fully populated config", () => {
    const result = AgentConfigSchema.safeParse({
      pi: {
        provider: "google-vertex",
        turnTimeoutMs: 600000,
      },
      agent: {
        env: { GH_TOKEN: "${env.GH_TOKEN}" },
        runtime: {
          uid: 1001,
          gid: 1001,
          permissionMode: true,
          home: "/home/agent",
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty object (all fields omitted)", () => {
    expect(AgentConfigSchema.safeParse({}).success).toBe(true);
  });

  it("rejects unknown top-level keys", () => {
    expect(AgentConfigSchema.safeParse({ unknown: true }).success).toBe(false);
  });

  it("rejects unknown keys under pi", () => {
    expect(AgentConfigSchema.safeParse({ pi: { unknown: true } }).success).toBe(
      false,
    );
  });

  it("rejects a negative turnTimeoutMs", () => {
    expect(
      AgentConfigSchema.safeParse({ pi: { turnTimeoutMs: -1 } }).success,
    ).toBe(false);
  });

  it("rejects a non-integer turnTimeoutMs", () => {
    expect(
      AgentConfigSchema.safeParse({ pi: { turnTimeoutMs: 1.5 } }).success,
    ).toBe(false);
  });

  it("rejects a model field under pi (removed)", () => {
    expect(
      AgentConfigSchema.safeParse({ pi: { model: "gemini-x" } }).success,
    ).toBe(false);
  });

  it("rejects envPassthrough under pi (removed in favor of agent.env)", () => {
    expect(
      AgentConfigSchema.safeParse({ pi: { envPassthrough: ["GH_TOKEN"] } })
        .success,
    ).toBe(false);
  });

  it("rejects unknown keys under agent", () => {
    expect(
      AgentConfigSchema.safeParse({ agent: { unknown: true } }).success,
    ).toBe(false);
  });

  it("rejects unknown keys under agent.runtime", () => {
    expect(
      AgentConfigSchema.safeParse({ agent: { runtime: { unknown: true } } })
        .success,
    ).toBe(false);
  });

  it("rejects non-string values in agent.env", () => {
    expect(
      AgentConfigSchema.safeParse({ agent: { env: { FOO: 1 } } }).success,
    ).toBe(false);
  });

  it("coerces string uid/gid/permissionMode under agent.runtime", () => {
    const data = AgentConfigSchema.parse({
      agent: {
        runtime: { uid: "1001", gid: "1001", permissionMode: "true" },
      },
    });
    expect(data.agent?.runtime?.uid).toBe(1001);
    expect(data.agent?.runtime?.gid).toBe(1001);
    expect(data.agent?.runtime?.permissionMode).toBe(true);
  });

  // ${env.X} 参照は文字列で来るため、"false"/"0"/"" を false と解釈できないと
  // sandbox を OFF にできない。z.coerce.boolean() だとこれらが truthy に化ける
  // (PermissionModeSchema がその罠を回避している)。
  it.each([
    ["false", false],
    ["0", false],
    ["", false],
    ["FALSE", false],
    ["true", true],
    ["1", true],
  ])("interprets permissionMode string %j as %s", (input, expected) => {
    const data = AgentConfigSchema.parse({
      agent: { runtime: { permissionMode: input } },
    });
    expect(data.agent?.runtime?.permissionMode).toBe(expected);
  });
});

describe("loadAgentConfig", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agent-config-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns {} when agent.yaml does not exist", async () => {
    expect(await loadAgentConfig(dir)).toEqual({});
  });

  it("returns {} when agent.yaml contains only comments", async () => {
    await writeFile(join(dir, "agent.yaml"), "# just a comment\n");
    expect(await loadAgentConfig(dir)).toEqual({});
  });

  it("parses a valid agent.yaml", async () => {
    await writeFile(
      join(dir, "agent.yaml"),
      "pi:\n  provider: google-vertex\n",
    );
    expect(await loadAgentConfig(dir)).toEqual({
      pi: { provider: "google-vertex" },
    });
  });

  it("throws with the file path for malformed YAML", async () => {
    await writeFile(join(dir, "agent.yaml"), "pi:\n  - broken: [\n");
    await expect(loadAgentConfig(dir)).rejects.toThrow(/agent\.yaml/);
  });

  it("throws with the file path and zod issue for schema violations", async () => {
    await writeFile(join(dir, "agent.yaml"), "pi:\n  unknownKey: 1\n");
    await expect(loadAgentConfig(dir)).rejects.toThrow(/agent\.yaml/);
  });

  it("resolves ${env.X} references in agent.env before schema validation", async () => {
    await writeFile(
      join(dir, "agent.yaml"),
      'agent:\n  env:\n    GH_TOKEN: "${env.TEST_GH_TOKEN}"\n',
    );
    const original = process.env.TEST_GH_TOKEN;
    process.env.TEST_GH_TOKEN = "resolved-secret";
    try {
      const config = await loadAgentConfig(dir);
      expect(config.agent?.env).toEqual({ GH_TOKEN: "resolved-secret" });
    } finally {
      if (original === undefined) delete process.env.TEST_GH_TOKEN;
      else process.env.TEST_GH_TOKEN = original;
    }
  });

  it("throws when a required ${env.X} reference is unset", async () => {
    await writeFile(
      join(dir, "agent.yaml"),
      'agent:\n  env:\n    GH_TOKEN: "${env.TEST_UNSET_TOKEN_XYZ}"\n',
    );
    delete process.env.TEST_UNSET_TOKEN_XYZ;
    await expect(loadAgentConfig(dir)).rejects.toThrow(/agent\.yaml/);
  });
});

describe("resolveAgentConfig", () => {
  it("prefers env over file for provider", () => {
    const resolved = resolveAgentConfig(
      { pi: { provider: "file-provider" } },
      { PI_PROVIDER: "env-provider" },
    );
    expect(resolved.provider).toBe("env-provider");
  });

  it("falls back to file values when env is unset", () => {
    const resolved = resolveAgentConfig(
      { pi: { provider: "file-provider" } },
      {},
    );
    expect(resolved.provider).toBe("file-provider");
  });

  it("leaves provider/turnTimeoutMs undefined when neither env nor file set them", () => {
    const resolved = resolveAgentConfig({}, {});
    expect(resolved.provider).toBeUndefined();
    expect(resolved.turnTimeoutMs).toBeUndefined();
  });

  it("defaults env to {} when agent.env is omitted", () => {
    const resolved = resolveAgentConfig({}, {});
    expect(resolved.env).toEqual({});
  });

  it("uses agent.env as-is (additive model, no process.env merge)", () => {
    const resolved = resolveAgentConfig(
      { agent: { env: { GH_TOKEN: "gh-secret" } } },
      { GH_TOKEN: "should-not-be-used", UNRELATED: "x" },
    );
    expect(resolved.env).toEqual({ GH_TOKEN: "gh-secret" });
  });

  it("parses TURN_TIMEOUT_MS from env and prefers it over file", () => {
    const resolved = resolveAgentConfig(
      { pi: { turnTimeoutMs: 1000 } },
      { TURN_TIMEOUT_MS: "5000" },
    );
    expect(resolved.turnTimeoutMs).toBe(5000);
  });

  it("throws for an invalid TURN_TIMEOUT_MS", () => {
    expect(() => resolveAgentConfig({}, { TURN_TIMEOUT_MS: "-1" })).toThrow(
      /TURN_TIMEOUT_MS/,
    );
    expect(() =>
      resolveAgentConfig({}, { TURN_TIMEOUT_MS: "not-a-number" }),
    ).toThrow(/TURN_TIMEOUT_MS/);
  });

  describe("runtime.permissionMode", () => {
    it("defaults to true when neither env nor file set it", () => {
      expect(resolveAgentConfig({}, {}).runtime.permissionMode).toBe(true);
    });

    it("can be disabled via agent.yaml agent.runtime.permissionMode: false", () => {
      const resolved = resolveAgentConfig(
        { agent: { runtime: { permissionMode: false } } },
        {},
      );
      expect(resolved.runtime.permissionMode).toBe(false);
    });

    it("disables via env PI_PERMISSION_MODE=0", () => {
      const resolved = resolveAgentConfig({}, { PI_PERMISSION_MODE: "0" });
      expect(resolved.runtime.permissionMode).toBe(false);
    });

    it("env PI_PERMISSION_MODE overrides file value", () => {
      const resolved = resolveAgentConfig(
        { agent: { runtime: { permissionMode: false } } },
        { PI_PERMISSION_MODE: "1" },
      );
      expect(resolved.runtime.permissionMode).toBe(true);
    });

    it("any non-'0' env value enables permission mode", () => {
      const resolved = resolveAgentConfig({}, { PI_PERMISSION_MODE: "yes" });
      expect(resolved.runtime.permissionMode).toBe(true);
    });
  });

  describe("runtime.home", () => {
    it("defaults to /home/agent", () => {
      expect(resolveAgentConfig({}, {}).runtime.home).toBe("/home/agent");
    });

    it("falls back to file value when env is unset", () => {
      const resolved = resolveAgentConfig(
        { agent: { runtime: { home: "/custom/home" } } },
        {},
      );
      expect(resolved.runtime.home).toBe("/custom/home");
    });

    it("prefers env PI_AGENT_HOME over file", () => {
      const resolved = resolveAgentConfig(
        { agent: { runtime: { home: "/custom/home" } } },
        { PI_AGENT_HOME: "/env/home" },
      );
      expect(resolved.runtime.home).toBe("/env/home");
    });
  });

  describe("runtime.uid/gid", () => {
    it("are undefined when neither env nor file set them", () => {
      const resolved = resolveAgentConfig({}, {});
      expect(resolved.runtime.uid).toBeUndefined();
      expect(resolved.runtime.gid).toBeUndefined();
    });

    it("falls back to file values", () => {
      const resolved = resolveAgentConfig(
        { agent: { runtime: { uid: 1001, gid: 1001 } } },
        {},
      );
      expect(resolved.runtime.uid).toBe(1001);
      expect(resolved.runtime.gid).toBe(1001);
    });

    it("prefers env PI_AGENT_UID/GID over file", () => {
      const resolved = resolveAgentConfig(
        { agent: { runtime: { uid: 1001, gid: 1001 } } },
        { PI_AGENT_UID: "2000", PI_AGENT_GID: "2000" },
      );
      expect(resolved.runtime.uid).toBe(2000);
      expect(resolved.runtime.gid).toBe(2000);
    });

    it("throws when only PI_AGENT_UID is set", () => {
      expect(() => resolveAgentConfig({}, { PI_AGENT_UID: "1001" })).toThrow(
        /PI_AGENT_UID and PI_AGENT_GID/,
      );
    });

    it("throws when only PI_AGENT_GID is set", () => {
      expect(() => resolveAgentConfig({}, { PI_AGENT_GID: "1001" })).toThrow(
        /PI_AGENT_UID and PI_AGENT_GID/,
      );
    });

    it("throws when PI_AGENT_UID/GID are not integers", () => {
      expect(() =>
        resolveAgentConfig({}, { PI_AGENT_UID: "abc", PI_AGENT_GID: "abc" }),
      ).toThrow(/must be integers/);
    });
  });
});
