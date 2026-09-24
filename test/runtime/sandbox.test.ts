import { describe, expect, it } from "vitest";

import { SandboxRulesSchema } from "../../src/config/sandbox-config.js";
import {
  buildSandboxSettings,
  probeSandboxRuntime,
  sandboxSettingsPath,
} from "../../src/runtime/sandbox.js";
import { FAKE_SRT } from "../helpers/session-harness.js";

const HOME = "/home/agent";
const ROOT = "/data/work";
const CHANNEL_DIR = `${ROOT}/C01`;
const CWD = `${CHANNEL_DIR}/1700000000.000100`;

describe("sandboxSettingsPath", () => {
  it.each([
    ["C01:1700000000.000100", "/data/work/srt/C01%3A1700000000.000100.json"],
    ["C01", "/data/work/srt/C01.json"],
  ])(
    "places %s under <workdirRoot>/srt (outside every workdir) as a safe file name",
    (sessionKey, expected) => {
      expect(sandboxSettingsPath("/data/work", sessionKey)).toBe(expected);
    },
  );
});

describe("buildSandboxSettings", () => {
  it("appends the runner's write paths after the user's allowWrite and keeps other keys", () => {
    const rules = SandboxRulesSchema.parse({
      network: {
        allowedDomains: ["aiplatform.googleapis.com:443"],
        strictAllowlist: true,
      },
      filesystem: { allowWrite: ["/scratch"], denyRead: ["~/.ssh"] },
      credentials: { envVars: [{ name: "GH_TOKEN", mode: "deny" }] },
    });
    const settings = buildSandboxSettings({
      rules,
      allowWrite: [CWD, `${CWD}-tmp`, HOME],
      workdirRoot: ROOT,
      channelEntries: [],
    });
    expect(settings.filesystem.allowWrite).toEqual([
      "/scratch",
      CWD,
      `${CWD}-tmp`,
      HOME,
    ]);
    expect(settings.filesystem.denyRead).toEqual(["~/.ssh", ROOT]);
    expect(settings.network).toEqual(rules.network);
    expect(settings.credentials).toEqual(rules.credentials);
  });

  it("hides the workdir root and re-allows only Channel entries that hold no write path", () => {
    const rules = SandboxRulesSchema.parse({
      filesystem: { allowRead: ["/data/knowledge"] },
    });
    const settings = buildSandboxSettings({
      rules,
      allowWrite: [CWD, `${CHANNEL_DIR}/tmp/1700000000.000100`, HOME],
      workdirRoot: ROOT,
      channelEntries: [
        CWD,
        `${CHANNEL_DIR}/tmp`,
        `${CHANNEL_DIR}/1700000000.000200`,
      ],
    });
    expect(settings.filesystem.denyRead).toEqual([ROOT]);
    expect(settings.filesystem.allowRead).toEqual([
      "/data/knowledge",
      `${CHANNEL_DIR}/1700000000.000200`,
    ]);
  });

  it("dedupes a runner path the user already listed", () => {
    const rules = SandboxRulesSchema.parse({
      filesystem: { allowWrite: [HOME] },
    });
    const settings = buildSandboxSettings({
      rules,
      allowWrite: [CWD, HOME],
      workdirRoot: ROOT,
      channelEntries: [],
    });
    expect(settings.filesystem.allowWrite).toEqual([HOME, CWD]);
  });
});

describe("probeSandboxRuntime", () => {
  it("reports ok when srt wraps a trivial command successfully", async () => {
    await expect(probeSandboxRuntime(FAKE_SRT)).resolves.toEqual({ ok: true });
  });

  it("reports failure with srt's stderr when srt cannot start", async () => {
    await expect(
      probeSandboxRuntime("/nonexistent/srt/cli.js"),
    ).resolves.toMatchObject({
      ok: false,
      stderr: expect.stringMatching(/nonexistent\/srt\/cli\.js/),
    });
  });
});
