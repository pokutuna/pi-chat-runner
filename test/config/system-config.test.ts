import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadSystemConfig,
  resolveSystemConfig,
  SystemConfigSchema,
} from "../../src/config/system-config.js";

describe("SystemConfigSchema", () => {
  it("accepts a fully populated config", () => {
    const result = SystemConfigSchema.safeParse({
      chat: {
        slack: {
          mode: "events",
          botToken: "xoxb-...",
          botUserId: "U123",
          socket: { appToken: "xapp-..." },
          events: { signingSecret: "shhh", port: 8080 },
        },
      },
      state: {
        control: {
          backend: "sqlite",
          sqlite: { path: "/data/state.db" },
          firestore: {
            projectId: "my-project",
            database: "my-db",
            rootDoc: "myapp/agent",
          },
        },
        agent: {
          workdirDir: "/var/workdirs",
          sharedDir: "/var/shared",
          sharedWarnBytes: 1024,
        },
      },
      runtime: {
        uid: 1001,
        gid: 1001,
        home: "/home/agent",
        permissionMode: true,
        allowAddons: false,
      },
      turnTimeoutMs: 600000,
      progressNoticeIntervalMs: 20000,
      leaseTtlMs: 60000,
      lingerMs: 3000,
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty object and fills in defaults", () => {
    const data = SystemConfigSchema.parse({});
    expect(data.chat.slack).toBeUndefined();
    expect(data.state.control.backend).toBe("memory");
    expect(data.state.control.sqlite.path).toBe("/tmp/pi-chat-runner/state.db");
    expect(data.state.control.firestore.projectId).toBe("");
    expect(data.state.control.firestore.database).toBe("(default)");
    expect(data.state.control.firestore.rootDoc).toBe("pi-chat-runner/default");
    expect(data.state.agent.workdirDir).toBeUndefined();
    expect(data.turnTimeoutMs).toBeUndefined();
  });

  it("rejects unknown top-level keys", () => {
    expect(SystemConfigSchema.safeParse({ unknown: true }).success).toBe(false);
  });

  // system の下に許される子ブロックは chat / state / runtime のみ。
  it.each(["connector", "store", "agent", "channels"])(
    "rejects an unknown %s block nested under system",
    (key) => {
      expect(SystemConfigSchema.safeParse({ [key]: {} }).success).toBe(false);
    },
  );

  describe("chat.slack", () => {
    it("defaults mode to socket and port to 8080", () => {
      const data = SystemConfigSchema.parse({
        chat: { slack: { botToken: "xoxb-...", botUserId: "U123" } },
      });
      expect(data.chat.slack?.mode).toBe("socket");
      expect(data.chat.slack?.events.port).toBe(8080);
    });

    it("coerces a string port to a number", () => {
      const data = SystemConfigSchema.parse({
        chat: {
          slack: {
            botToken: "xoxb-...",
            botUserId: "U123",
            events: { port: "9090" },
          },
        },
      });
      expect(data.chat.slack?.events.port).toBe(9090);
    });

    it("requires botToken and botUserId", () => {
      expect(
        SystemConfigSchema.safeParse({ chat: { slack: {} } }).success,
      ).toBe(false);
    });

    it("rejects the old flat appToken placement", () => {
      expect(
        SystemConfigSchema.safeParse({
          chat: {
            slack: { botToken: "x", botUserId: "U1", appToken: "xapp-..." },
          },
        }).success,
      ).toBe(false);
    });

    it("rejects an invalid mode", () => {
      expect(
        SystemConfigSchema.safeParse({
          chat: { slack: { mode: "webhook", botToken: "x", botUserId: "U1" } },
        }).success,
      ).toBe(false);
    });

    it.each(["chat", "chat.slack", "chat.slack.socket", "chat.slack.events"])(
      "rejects unknown keys under %s",
      (path) => {
        const slack: Record<string, unknown> = {
          botToken: "x",
          botUserId: "U1",
        };
        const raw: Record<string, unknown> = { chat: { slack } };
        if (path === "chat")
          (raw.chat as Record<string, unknown>).unknown = true;
        if (path === "chat.slack") slack.unknown = true;
        if (path === "chat.slack.socket") slack.socket = { unknown: true };
        if (path === "chat.slack.events") slack.events = { unknown: true };
        expect(SystemConfigSchema.safeParse(raw).success).toBe(false);
      },
    );
  });

  describe("state.control", () => {
    it("rejects an invalid backend", () => {
      expect(
        SystemConfigSchema.safeParse({
          state: { control: { backend: "redis" } },
        }).success,
      ).toBe(false);
    });

    it("rejects a rootDoc that is not a document path", () => {
      for (const rootDoc of ["", "collection-only", "a/b/c", "a//b", "/a/b"]) {
        expect(
          SystemConfigSchema.safeParse({
            state: { control: { firestore: { rootDoc } } },
          }).success,
          `rootDoc: ${JSON.stringify(rootDoc)}`,
        ).toBe(false);
      }
    });

    it("accepts a nested rootDoc document path", () => {
      expect(
        SystemConfigSchema.safeParse({
          state: { control: { firestore: { rootDoc: "apps/pi/envs/prod" } } },
        }).success,
      ).toBe(true);
    });

    it.each(["sqlite", "firestore"])("rejects unknown keys under %s", (key) => {
      expect(
        SystemConfigSchema.safeParse({
          state: { control: { [key]: { unknown: true } } },
        }).success,
      ).toBe(false);
    });
  });

  describe("state.agent", () => {
    // ${env.X:-} で「未設定」を書くと空文字で届くため、"" は undefined と同義。
    it("treats empty strings as unset", () => {
      const data = SystemConfigSchema.parse({
        state: {
          agent: { workdirDir: "", sharedDir: "", sharedWarnBytes: "" },
        },
      });
      expect(data.state.agent.workdirDir).toBeUndefined();
      expect(data.state.agent.sharedDir).toBeUndefined();
      expect(data.state.agent.sharedWarnBytes).toBeUndefined();
    });

    it("coerces a string sharedWarnBytes to a number", () => {
      const data = SystemConfigSchema.parse({
        state: { agent: { sharedWarnBytes: "52428800" } },
      });
      expect(data.state.agent.sharedWarnBytes).toBe(52428800);
    });

    it("rejects a non-positive sharedWarnBytes", () => {
      expect(
        SystemConfigSchema.safeParse({
          state: { agent: { sharedWarnBytes: 0 } },
        }).success,
      ).toBe(false);
    });

    it("rejects unknown keys", () => {
      expect(
        SystemConfigSchema.safeParse({ state: { agent: { unknown: true } } })
          .success,
      ).toBe(false);
    });
  });

  describe("runtime", () => {
    it("coerces string uid/gid", () => {
      const data = SystemConfigSchema.parse({
        runtime: { uid: "1001", gid: "1001" },
      });
      expect(data.runtime.uid).toBe(1001);
      expect(data.runtime.gid).toBe(1001);
    });

    it("treats empty-string uid/gid as unset", () => {
      const data = SystemConfigSchema.parse({ runtime: { uid: "", gid: "" } });
      expect(data.runtime.uid).toBeUndefined();
      expect(data.runtime.gid).toBeUndefined();
    });

    it("rejects unknown keys", () => {
      expect(
        SystemConfigSchema.safeParse({ runtime: { unknown: true } }).success,
      ).toBe(false);
    });

    // ${env.X} 参照は文字列で来るため、"false"/"0"/"" を false と解釈できないと
    // sandbox を OFF にできない。z.coerce.boolean() だとこれらが truthy に化ける。
    it.each([
      ["false", false],
      ["0", false],
      ["", false],
      ["FALSE", false],
      ["true", true],
      ["1", true],
    ])("interprets permissionMode string %j as %s", (input, expected) => {
      const data = SystemConfigSchema.parse({
        runtime: { permissionMode: input },
      });
      expect(data.runtime.permissionMode).toBe(expected);
    });

    it.each([
      ["false", false],
      ["0", false],
      ["", false],
      ["true", true],
      ["1", true],
    ])("interprets allowAddons string %j as %s", (input, expected) => {
      const data = SystemConfigSchema.parse({
        runtime: { allowAddons: input },
      });
      expect(data.runtime.allowAddons).toBe(expected);
    });
  });

  describe("timing fields", () => {
    it("rejects a non-positive turnTimeoutMs", () => {
      expect(SystemConfigSchema.safeParse({ turnTimeoutMs: -1 }).success).toBe(
        false,
      );
      expect(SystemConfigSchema.safeParse({ turnTimeoutMs: 0 }).success).toBe(
        false,
      );
    });

    it("rejects a non-integer turnTimeoutMs", () => {
      expect(SystemConfigSchema.safeParse({ turnTimeoutMs: 1.5 }).success).toBe(
        false,
      );
    });

    it("accepts a zero progressNoticeIntervalMs (disables the feature)", () => {
      expect(
        SystemConfigSchema.safeParse({ progressNoticeIntervalMs: 0 }).success,
      ).toBe(true);
    });

    it("rejects a negative progressNoticeIntervalMs", () => {
      expect(
        SystemConfigSchema.safeParse({ progressNoticeIntervalMs: -1 }).success,
      ).toBe(false);
    });

    it("coerces string timing values (they arrive as strings via ${env.X})", () => {
      const data = SystemConfigSchema.parse({
        turnTimeoutMs: "600000",
        progressNoticeIntervalMs: "20000",
        leaseTtlMs: "60000",
        lingerMs: "3000",
      });
      expect(data.turnTimeoutMs).toBe(600000);
      expect(data.progressNoticeIntervalMs).toBe(20000);
      expect(data.leaseTtlMs).toBe(60000);
      expect(data.lingerMs).toBe(3000);
    });
  });
});

describe("loadSystemConfig", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "system-config-test-"));
    path = join(dir, "agent.yaml");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns schema defaults when the file does not exist", async () => {
    const config = await loadSystemConfig(join(dir, "missing.yaml"), {});
    expect(config.state.control.backend).toBe("memory");
  });

  it("returns schema defaults when the file has no system block", async () => {
    await writeFile(
      path,
      "channels:\n  - channel: default\n    trigger:\n      when: []\n",
    );
    const config = await loadSystemConfig(path, {});
    expect(config.state.control.backend).toBe("memory");
  });

  it("parses a system block", async () => {
    await writeFile(
      path,
      "system:\n  state:\n    control:\n      backend: sqlite\n",
    );
    const config = await loadSystemConfig(path, {});
    expect(config.state.control.backend).toBe("sqlite");
  });

  it("resolves ${env.X} references before schema validation", async () => {
    await writeFile(
      path,
      "system:\n  state:\n    control:\n      backend: ${env.TEST_BACKEND}\n",
    );
    const config = await loadSystemConfig(path, { TEST_BACKEND: "sqlite" });
    expect(config.state.control.backend).toBe("sqlite");
  });

  it("applies ${env.X:-default} fallbacks", async () => {
    await writeFile(
      path,
      "system:\n  state:\n    control:\n      backend: ${env.TEST_UNSET_BACKEND:-firestore}\n",
    );
    const config = await loadSystemConfig(path, {});
    expect(config.state.control.backend).toBe("firestore");
  });

  it("throws with the file path when a required ${env.X} reference is unset", async () => {
    await writeFile(
      path,
      "system:\n  chat:\n    slack:\n      botToken: ${env.TEST_UNSET_TOKEN}\n      botUserId: U1\n",
    );
    await expect(loadSystemConfig(path, {})).rejects.toThrow(/agent\.yaml/);
  });

  it("omitChat drops system.chat before env resolution (local mode)", async () => {
    await writeFile(
      path,
      "system:\n  chat:\n    slack:\n      botToken: ${env.TEST_UNSET_TOKEN}\n      botUserId: U1\n  state:\n    control:\n      backend: sqlite\n",
    );
    const config = await loadSystemConfig(path, {}, { omitChat: true });
    expect(config.chat.slack).toBeUndefined();
    expect(config.state.control.backend).toBe("sqlite");
  });

  it("throws with the file path for malformed YAML", async () => {
    await writeFile(path, "system:\n  - broken: [\n");
    await expect(loadSystemConfig(path, {})).rejects.toThrow(/agent\.yaml/);
  });

  it("throws with the file path and zod issue for schema violations", async () => {
    await writeFile(path, "system:\n  unknownKey: 1\n");
    await expect(loadSystemConfig(path, {})).rejects.toThrow(
      /invalid system config schema/,
    );
  });

  // system ブロックだけを読む — agent / channels の内容には触れない。
  it("ignores the agent and channels blocks", async () => {
    await writeFile(
      path,
      [
        "system:",
        "  state:",
        "    control:",
        "      backend: sqlite",
        "agent:",
        "  env:",
        "    SECRET: ${env.TEST_UNSET_SECRET}",
        "channels:",
        "  - channel: default",
        "    trigger:",
        "      when: []",
        "",
      ].join("\n"),
    );
    const config = await loadSystemConfig(path, {});
    expect(config.state.control.backend).toBe("sqlite");
  });
});

describe("resolveSystemConfig", () => {
  const empty = () => SystemConfigSchema.parse({});

  it("leaves timing fields undefined when neither env nor file set them", () => {
    const resolved = resolveSystemConfig(empty(), {});
    expect(resolved.turnTimeoutMs).toBeUndefined();
    expect(resolved.progressNoticeIntervalMs).toBeUndefined();
    expect(resolved.leaseTtlMs).toBeUndefined();
    expect(resolved.lingerMs).toBeUndefined();
  });

  it("passes leaseTtlMs / lingerMs through from the file", () => {
    const resolved = resolveSystemConfig(
      SystemConfigSchema.parse({ leaseTtlMs: 60000, lingerMs: 3000 }),
      {},
    );
    expect(resolved.leaseTtlMs).toBe(60000);
    expect(resolved.lingerMs).toBe(3000);
  });

  it("parses TURN_TIMEOUT_MS from env and prefers it over file", () => {
    const resolved = resolveSystemConfig(
      SystemConfigSchema.parse({ turnTimeoutMs: 1000 }),
      { TURN_TIMEOUT_MS: "5000" },
    );
    expect(resolved.turnTimeoutMs).toBe(5000);
  });

  it("throws for an invalid TURN_TIMEOUT_MS", () => {
    expect(() =>
      resolveSystemConfig(empty(), { TURN_TIMEOUT_MS: "-1" }),
    ).toThrow(/TURN_TIMEOUT_MS/);
    expect(() =>
      resolveSystemConfig(empty(), { TURN_TIMEOUT_MS: "not-a-number" }),
    ).toThrow(/TURN_TIMEOUT_MS/);
  });

  it("parses PROGRESS_NOTICE_INTERVAL_MS from env and prefers it over file", () => {
    const resolved = resolveSystemConfig(
      SystemConfigSchema.parse({ progressNoticeIntervalMs: 1000 }),
      { PROGRESS_NOTICE_INTERVAL_MS: "5000" },
    );
    expect(resolved.progressNoticeIntervalMs).toBe(5000);
  });

  it("allows PROGRESS_NOTICE_INTERVAL_MS=0 to disable the feature via env", () => {
    const resolved = resolveSystemConfig(
      SystemConfigSchema.parse({ progressNoticeIntervalMs: 5000 }),
      { PROGRESS_NOTICE_INTERVAL_MS: "0" },
    );
    expect(resolved.progressNoticeIntervalMs).toBe(0);
  });

  it("throws for an invalid PROGRESS_NOTICE_INTERVAL_MS", () => {
    expect(() =>
      resolveSystemConfig(empty(), { PROGRESS_NOTICE_INTERVAL_MS: "-1" }),
    ).toThrow(/PROGRESS_NOTICE_INTERVAL_MS/);
    expect(() =>
      resolveSystemConfig(empty(), {
        PROGRESS_NOTICE_INTERVAL_MS: "not-a-number",
      }),
    ).toThrow(/PROGRESS_NOTICE_INTERVAL_MS/);
  });

  it("passes state through unchanged", () => {
    const file = SystemConfigSchema.parse({
      state: { agent: { workdirDir: "/var/workdirs" } },
    });
    expect(resolveSystemConfig(file, {}).state.agent.workdirDir).toBe(
      "/var/workdirs",
    );
  });

  describe("runtime.permissionMode", () => {
    it("defaults to true when neither env nor file set it", () => {
      expect(resolveSystemConfig(empty(), {}).runtime.permissionMode).toBe(
        true,
      );
    });

    it("can be disabled via system.runtime.permissionMode: false", () => {
      const resolved = resolveSystemConfig(
        SystemConfigSchema.parse({ runtime: { permissionMode: false } }),
        {},
      );
      expect(resolved.runtime.permissionMode).toBe(false);
    });

    it("disables via env PI_PERMISSION_MODE=0", () => {
      const resolved = resolveSystemConfig(empty(), {
        PI_PERMISSION_MODE: "0",
      });
      expect(resolved.runtime.permissionMode).toBe(false);
    });

    it("env PI_PERMISSION_MODE overrides file value", () => {
      const resolved = resolveSystemConfig(
        SystemConfigSchema.parse({ runtime: { permissionMode: false } }),
        { PI_PERMISSION_MODE: "1" },
      );
      expect(resolved.runtime.permissionMode).toBe(true);
    });

    it("any non-'0' env value enables permission mode", () => {
      const resolved = resolveSystemConfig(empty(), {
        PI_PERMISSION_MODE: "yes",
      });
      expect(resolved.runtime.permissionMode).toBe(true);
    });
  });

  describe("runtime.allowAddons", () => {
    it("defaults to false when neither env nor file set it", () => {
      expect(resolveSystemConfig(empty(), {}).runtime.allowAddons).toBe(false);
    });

    it("can be enabled via system.runtime.allowAddons: true", () => {
      const resolved = resolveSystemConfig(
        SystemConfigSchema.parse({ runtime: { allowAddons: true } }),
        {},
      );
      expect(resolved.runtime.allowAddons).toBe(true);
    });

    it("enables via env PI_ALLOW_ADDONS=1", () => {
      const resolved = resolveSystemConfig(empty(), { PI_ALLOW_ADDONS: "1" });
      expect(resolved.runtime.allowAddons).toBe(true);
    });

    it("env PI_ALLOW_ADDONS overrides file value", () => {
      const resolved = resolveSystemConfig(
        SystemConfigSchema.parse({ runtime: { allowAddons: true } }),
        { PI_ALLOW_ADDONS: "0" },
      );
      expect(resolved.runtime.allowAddons).toBe(false);
    });
  });

  describe("runtime.home", () => {
    it("defaults to /home/agent", () => {
      expect(resolveSystemConfig(empty(), {}).runtime.home).toBe("/home/agent");
    });

    it("falls back to the file value when env is unset", () => {
      const resolved = resolveSystemConfig(
        SystemConfigSchema.parse({ runtime: { home: "/custom/home" } }),
        {},
      );
      expect(resolved.runtime.home).toBe("/custom/home");
    });

    it("prefers env PI_AGENT_HOME over file", () => {
      const resolved = resolveSystemConfig(
        SystemConfigSchema.parse({ runtime: { home: "/custom/home" } }),
        { PI_AGENT_HOME: "/env/home" },
      );
      expect(resolved.runtime.home).toBe("/env/home");
    });
  });

  describe("runtime.uid/gid", () => {
    it("are undefined when neither env nor file set them", () => {
      const resolved = resolveSystemConfig(empty(), {});
      expect(resolved.runtime.uid).toBeUndefined();
      expect(resolved.runtime.gid).toBeUndefined();
    });

    it("falls back to file values", () => {
      const resolved = resolveSystemConfig(
        SystemConfigSchema.parse({ runtime: { uid: 1001, gid: 1001 } }),
        {},
      );
      expect(resolved.runtime.uid).toBe(1001);
      expect(resolved.runtime.gid).toBe(1001);
    });

    it("prefers env PI_AGENT_UID/GID over file", () => {
      const resolved = resolveSystemConfig(
        SystemConfigSchema.parse({ runtime: { uid: 1001, gid: 1001 } }),
        { PI_AGENT_UID: "2000", PI_AGENT_GID: "2000" },
      );
      expect(resolved.runtime.uid).toBe(2000);
      expect(resolved.runtime.gid).toBe(2000);
    });

    it("throws when only PI_AGENT_UID is set", () => {
      expect(() =>
        resolveSystemConfig(empty(), { PI_AGENT_UID: "1001" }),
      ).toThrow(/PI_AGENT_UID and PI_AGENT_GID/);
    });

    it("throws when only PI_AGENT_GID is set", () => {
      expect(() =>
        resolveSystemConfig(empty(), { PI_AGENT_GID: "1001" }),
      ).toThrow(/PI_AGENT_UID and PI_AGENT_GID/);
    });

    it("throws when PI_AGENT_UID/GID are not integers", () => {
      expect(() =>
        resolveSystemConfig(empty(), {
          PI_AGENT_UID: "abc",
          PI_AGENT_GID: "abc",
        }),
      ).toThrow(/must be integers/);
    });
  });
});
