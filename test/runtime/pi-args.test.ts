import { describe, expect, it } from "vitest";

import {
  buildPiArgs,
  buildPiEnv,
  buildSpawnCommand,
  wrapWithSrt,
} from "../../src/runtime/pi-args.js";

describe("buildPiArgs", () => {
  it("builds minimal rpc mode args", () => {
    expect(
      buildPiArgs({
        sessionPath: "/tmp/s/session.jsonl",
        extensionPaths: ["/app/extensions/reply.ts"],
      }),
    ).toEqual([
      "--mode",
      "rpc",
      "--session",
      "/tmp/s/session.jsonl",
      "--offline",
      "--extension",
      "/app/extensions/reply.ts",
    ]);
  });

  it("expands --extension once per path in extensionPaths (reply + permission-gate)", () => {
    const args = buildPiArgs({
      sessionPath: "/tmp/s/session.jsonl",
      extensionPaths: [
        "/app/extensions/reply.ts",
        "/app/extensions/permission-gate.ts",
      ],
    });
    expect(args).toEqual([
      "--mode",
      "rpc",
      "--session",
      "/tmp/s/session.jsonl",
      "--offline",
      "--extension",
      "/app/extensions/reply.ts",
      "--extension",
      "/app/extensions/permission-gate.ts",
    ]);
  });

  it("appends optional model/system-prompt/skill args", () => {
    const args = buildPiArgs({
      sessionPath: "/tmp/s.jsonl",
      extensionPaths: ["/e/reply.ts"],
      model: "google/gemini-2.5-flash-lite",
      appendSystemPrompt: "thread_key is t1",
      skillPaths: ["/app/skills/gc-logging", "/app/skills/reporting"],
    });
    // provider は --model の shorthand (provider/model-id) に含めて渡す。
    // --provider フラグ自体を組み立てない
    expect(args).not.toContain("--provider");
    expect(args[args.indexOf("--model") + 1]).toBe(
      "google/gemini-2.5-flash-lite",
    );
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe(
      "thread_key is t1",
    );
    // --skill は複数回展開される (pi 側で additive)
    const skillIndices = args
      .map((arg, i) => (arg === "--skill" ? i : -1))
      .filter((i) => i >= 0);
    expect(skillIndices.map((i) => args[i + 1])).toEqual([
      "/app/skills/gc-logging",
      "/app/skills/reporting",
    ]);
  });

  it("passes the ADC marker as --api-key only for a google-vertex model prefix", () => {
    const vertex = buildPiArgs({
      sessionPath: "/s.jsonl",
      extensionPaths: ["/e.ts"],
      model: "google-vertex/gemini-3.5-flash",
    });
    expect(vertex[vertex.indexOf("--api-key") + 1]).toBe(
      "gcp-vertex-credentials",
    );

    // thinking level suffix が付いていても provider prefix の判定は変わらない
    const vertexThinking = buildPiArgs({
      sessionPath: "/s.jsonl",
      extensionPaths: ["/e.ts"],
      model: "google-vertex/gemini-3.1-pro:high",
    });
    expect(vertexThinking[vertexThinking.indexOf("--api-key") + 1]).toBe(
      "gcp-vertex-credentials",
    );

    const other = buildPiArgs({
      sessionPath: "/s.jsonl",
      extensionPaths: ["/e.ts"],
      model: "anthropic/claude-opus-4-8",
    });
    expect(other).not.toContain("--api-key");

    // model-id 内に / を含む provider (openrouter 等) でも先頭 segment で判定する
    const openrouter = buildPiArgs({
      sessionPath: "/s.jsonl",
      extensionPaths: ["/e.ts"],
      model: "openrouter/moonshotai/kimi-k2.6",
    });
    expect(openrouter).not.toContain("--api-key");

    const noModel = buildPiArgs({
      sessionPath: "/s.jsonl",
      extensionPaths: ["/e.ts"],
    });
    expect(noModel).not.toContain("--api-key");
  });

  it("omits optional args when not specified", () => {
    const args = buildPiArgs({
      sessionPath: "/s.jsonl",
      extensionPaths: ["/e.ts"],
    });
    for (const flag of [
      "--provider",
      "--model",
      "--append-system-prompt",
      "--skill",
      "--tools",
      "--exclude-tools",
    ]) {
      expect(args).not.toContain(flag);
    }
  });

  it("appends --tools with reply auto-added when not included", () => {
    const args = buildPiArgs({
      sessionPath: "/s.jsonl",
      extensionPaths: ["/e.ts"],
      tools: ["read", "grep"],
    });
    expect(args[args.indexOf("--tools") + 1]).toBe("read,grep,reply");
  });

  it("does not duplicate reply when --tools already includes it", () => {
    const args = buildPiArgs({
      sessionPath: "/s.jsonl",
      extensionPaths: ["/e.ts"],
      tools: ["read", "reply", "grep"],
    });
    expect(args[args.indexOf("--tools") + 1]).toBe("read,reply,grep");
  });

  it("omits --tools when tools is an empty array", () => {
    const args = buildPiArgs({
      sessionPath: "/s.jsonl",
      extensionPaths: ["/e.ts"],
      tools: [],
    });
    expect(args).not.toContain("--tools");
  });

  it("strips reply from --exclude-tools", () => {
    const args = buildPiArgs({
      sessionPath: "/s.jsonl",
      extensionPaths: ["/e.ts"],
      excludeTools: ["write", "reply", "edit"],
    });
    expect(args[args.indexOf("--exclude-tools") + 1]).toBe("write,edit");
  });

  it("omits --exclude-tools entirely when only reply was excluded", () => {
    const args = buildPiArgs({
      sessionPath: "/s.jsonl",
      extensionPaths: ["/e.ts"],
      excludeTools: ["reply"],
    });
    expect(args).not.toContain("--exclude-tools");
  });
});

describe("buildPiEnv", () => {
  it("passes only PATH and HOME from the base env", () => {
    const env = buildPiEnv({
      PATH: "/usr/bin",
      HOME: "/home/runner",
      SLACK_BOT_TOKEN: "xoxb-secret",
      SLACK_SIGNING_SECRET: "sig-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/runner" });
  });

  it("adds explicitly allowlisted extra env vars", () => {
    const env = buildPiEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/runner",
        SLACK_BOT_TOKEN: "xoxb-secret",
      },
      { GOOGLE_CLOUD_PROJECT: "my-project" },
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/runner",
      GOOGLE_CLOUD_PROJECT: "my-project",
    });
  });

  it("skips PATH/HOME when absent instead of injecting undefined", () => {
    expect(buildPiEnv({})).toEqual({});
  });
});

describe("buildSpawnCommand", () => {
  it("spawns piBinary directly", () => {
    expect(buildSpawnCommand(["--mode", "rpc"], { piBinary: "pi" })).toEqual({
      command: "pi",
      args: ["--mode", "rpc"],
    });
  });

  it('falls back to "pi" when no explicit executable is supplied', () => {
    expect(buildSpawnCommand(["--mode", "rpc"], {})).toEqual({
      command: "pi",
      args: ["--mode", "rpc"],
    });
  });

  it("runs the detected entrypoint through node", () => {
    const entrypoint =
      "/app/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
    expect(
      buildSpawnCommand(["--mode", "rpc"], { piEntrypoint: entrypoint }),
    ).toEqual({
      command: process.execPath,
      args: [entrypoint, "--mode", "rpc"],
    });
  });

  it("prefers an explicit piBinary override over the detected entrypoint", () => {
    expect(
      buildSpawnCommand(["--mode", "rpc"], {
        piBinary: "/tmp/fake-pi",
        piEntrypoint: "/app/node_modules/pi/dist/cli.js",
      }),
    ).toEqual({
      command: "/tmp/fake-pi",
      args: ["--mode", "rpc"],
    });
  });
});

describe("wrapWithSrt", () => {
  const inner = {
    command: "/usr/local/bin/node",
    args: ["/pi/cli.js", "--mode", "rpc"],
  };

  it("runs srt's cli.js with node and passes the inner command after --", () => {
    expect(
      wrapWithSrt(inner, {
        srtEntrypoint:
          "/app/node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js",
        settingsPath: "/data/work/srt/C01.json",
        debug: false,
      }),
    ).toEqual({
      command: process.execPath,
      args: [
        "/app/node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js",
        "--settings",
        "/data/work/srt/C01.json",
        "--",
        "/usr/local/bin/node",
        "/pi/cli.js",
        "--mode",
        "rpc",
      ],
    });
  });

  it("passes --debug to srt (not to the inner command) when requested", () => {
    const { args } = wrapWithSrt(inner, {
      srtEntrypoint: "/srt/cli.js",
      settingsPath: "/s.json",
      debug: true,
    });
    expect(args.slice(0, args.indexOf("--"))).toContain("--debug");
    expect(args.slice(args.indexOf("--") + 1)).toEqual([
      inner.command,
      ...inner.args,
    ]);
  });
});
