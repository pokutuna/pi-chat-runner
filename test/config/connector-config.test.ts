import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ConnectorConfigSchema,
  loadConnectorConfig,
} from "../../src/config/connector-config.js";

describe("ConnectorConfigSchema", () => {
  it("accepts a fully populated slack config", () => {
    const result = ConnectorConfigSchema.safeParse({
      slack: {
        mode: "events",
        botToken: "xoxb-...",
        botUserId: "U123",
        events: { signingSecret: "shhh", port: 8080 },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty object (all fields omitted)", () => {
    expect(ConnectorConfigSchema.safeParse({}).success).toBe(true);
  });

  it("defaults mode to socket and port to 8080", () => {
    const data = ConnectorConfigSchema.parse({
      slack: { botToken: "xoxb-...", botUserId: "U123" },
    });
    expect(data.slack?.mode).toBe("socket");
    expect(data.slack?.events.port).toBe(8080);
  });

  it("coerces a string port to a number", () => {
    const data = ConnectorConfigSchema.parse({
      slack: {
        botToken: "xoxb-...",
        botUserId: "U123",
        events: { port: "9090" },
      },
    });
    expect(data.slack?.events.port).toBe(9090);
  });

  it("rejects unknown top-level keys", () => {
    expect(ConnectorConfigSchema.safeParse({ unknown: true }).success).toBe(
      false,
    );
  });

  it("rejects unknown keys under slack", () => {
    expect(
      ConnectorConfigSchema.safeParse({
        slack: { botToken: "x", botUserId: "U1", unknown: true },
      }).success,
    ).toBe(false);
  });

  it("rejects unknown keys under slack.socket", () => {
    expect(
      ConnectorConfigSchema.safeParse({
        slack: {
          botToken: "x",
          botUserId: "U1",
          socket: { unknown: true },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects unknown keys under slack.events", () => {
    expect(
      ConnectorConfigSchema.safeParse({
        slack: {
          botToken: "x",
          botUserId: "U1",
          events: { unknown: true },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects the old flat appToken/port/signingSecret placement", () => {
    expect(
      ConnectorConfigSchema.safeParse({
        slack: {
          botToken: "x",
          botUserId: "U1",
          appToken: "xapp-...",
        },
      }).success,
    ).toBe(false);
  });

  it("rejects an invalid mode", () => {
    expect(
      ConnectorConfigSchema.safeParse({
        slack: { mode: "webhook", botToken: "x", botUserId: "U1" },
      }).success,
    ).toBe(false);
  });

  it("requires botToken and botUserId", () => {
    expect(ConnectorConfigSchema.safeParse({ slack: {} }).success).toBe(false);
  });
});

describe("loadConnectorConfig", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "connector-config-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns {} when agent.yaml does not exist", async () => {
    expect(await loadConnectorConfig(join(dir, "agent.yaml"))).toEqual({});
  });

  it("returns {} when agent.yaml has no connector block", async () => {
    await writeFile(
      join(dir, "agent.yaml"),
      "agent:\n  provider: google-vertex\n",
    );
    expect(await loadConnectorConfig(join(dir, "agent.yaml"))).toEqual({});
  });

  it("returns {} when agent.yaml contains only comments", async () => {
    await writeFile(join(dir, "agent.yaml"), "# just a comment\n");
    expect(await loadConnectorConfig(join(dir, "agent.yaml"))).toEqual({});
  });

  it("parses a valid connector block with literal values", async () => {
    await writeFile(
      join(dir, "agent.yaml"),
      [
        "connector:",
        "  slack:",
        "    mode: socket",
        "    botToken: xoxb-literal",
        "    botUserId: U123",
        "    socket:",
        "      appToken: xapp-literal",
      ].join("\n"),
    );
    expect(await loadConnectorConfig(join(dir, "agent.yaml"))).toEqual({
      slack: {
        mode: "socket",
        botToken: "xoxb-literal",
        botUserId: "U123",
        socket: { appToken: "xapp-literal" },
        events: { port: 8080 },
      },
    });
  });

  it("resolves ${env.X} references against the given env before validating", async () => {
    await writeFile(
      join(dir, "agent.yaml"),
      [
        "connector:",
        "  slack:",
        "    mode: ${env.SLACK_MODE:-socket}",
        "    botToken: ${env.SLACK_BOT_TOKEN}",
        "    botUserId: ${env.SLACK_BOT_USER_ID}",
        "    socket:",
        "      appToken: ${env.SLACK_APP_TOKEN}",
        "    events:",
        "      port: ${env.PORT:-8080}",
      ].join("\n"),
    );
    const result = await loadConnectorConfig(join(dir, "agent.yaml"), {
      SLACK_APP_TOKEN: "xapp-from-env",
      SLACK_BOT_TOKEN: "xoxb-from-env",
      SLACK_BOT_USER_ID: "U999",
    });
    expect(result).toEqual({
      slack: {
        mode: "socket",
        botToken: "xoxb-from-env",
        botUserId: "U999",
        socket: { appToken: "xapp-from-env" },
        events: { port: 8080 },
      },
    });
  });

  it("throws with the file path when a referenced env var is unset", async () => {
    await writeFile(
      join(dir, "agent.yaml"),
      [
        "connector:",
        "  slack:",
        "    botToken: ${env.SLACK_BOT_TOKEN}",
        "    botUserId: U123",
      ].join("\n"),
    );
    // agent-config.ts の loadAgentConfig と同じ流儀: 外側メッセージはファイルパスまで、
    // 参照先の env 変数名 (SLACK_BOT_TOKEN) は cause チェーン (env-ref.ts 側) に載る。
    await expect(
      loadConnectorConfig(join(dir, "agent.yaml"), {}),
    ).rejects.toThrow(/agent\.yaml/);
  });

  it("throws with the file path for malformed YAML", async () => {
    await writeFile(join(dir, "agent.yaml"), "connector:\n  - broken: [\n");
    await expect(loadConnectorConfig(join(dir, "agent.yaml"))).rejects.toThrow(
      /agent\.yaml/,
    );
  });

  it("throws with the file path and zod issue for schema violations", async () => {
    await writeFile(
      join(dir, "agent.yaml"),
      "connector:\n  slack:\n    mode: webhook\n    botToken: x\n    botUserId: U1\n",
    );
    await expect(loadConnectorConfig(join(dir, "agent.yaml"))).rejects.toThrow(
      /agent\.yaml/,
    );
  });

  it("throws when required fields (botToken/botUserId) are missing", async () => {
    await writeFile(join(dir, "agent.yaml"), "connector:\n  slack: {}\n");
    await expect(loadConnectorConfig(join(dir, "agent.yaml"))).rejects.toThrow(
      /agent\.yaml/,
    );
  });
});
