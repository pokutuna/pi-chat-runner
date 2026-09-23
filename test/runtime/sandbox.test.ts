import { describe, expect, it } from "vitest";

import { SandboxRulesSchema } from "../../src/config/sandbox-config.js";
import {
  buildSandboxSettings,
  probeSandboxRuntime,
  sandboxSettingsPath,
} from "../../src/runtime/sandbox.js";
import { FAKE_SRT } from "../helpers/session-harness.js";

const HOME = "/home/agent";
const CWD = "/data/work/C01/1700000000.000100";

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
    const { settings } = buildSandboxSettings({
      rules,
      allowWrite: [CWD, `${CWD}-tmp`, HOME],
      home: HOME,
      cwd: CWD,
    });
    expect(settings.filesystem.allowWrite).toEqual([
      "/scratch",
      CWD,
      `${CWD}-tmp`,
      HOME,
    ]);
    expect(settings.filesystem.denyRead).toEqual(["~/.ssh"]);
    expect(settings.network).toEqual(rules.network);
    expect(settings.credentials).toEqual(rules.credentials);
  });

  it("dedupes a runner path the user already listed", () => {
    const rules = SandboxRulesSchema.parse({
      filesystem: { allowWrite: [HOME] },
    });
    const { settings } = buildSandboxSettings({
      rules,
      allowWrite: [CWD, HOME],
      home: HOME,
      cwd: CWD,
    });
    expect(settings.filesystem.allowWrite).toEqual([HOME, CWD]);
  });

  it("mirrors only the user's allowRead/allowWrite into Permission Model patterns", () => {
    const rules = SandboxRulesSchema.parse({
      filesystem: {
        allowRead: ["/data/knowledge", "~/.config/gh", "notes", "~"],
        allowWrite: ["/scratch/**/*.log"],
      },
    });
    const { permission } = buildSandboxSettings({
      rules,
      allowWrite: [CWD, HOME],
      home: HOME,
      cwd: CWD,
    });
    expect(permission.allowRead).toEqual([
      "/data/knowledge",
      "/data/knowledge/*",
      `${HOME}/.config/gh`,
      `${HOME}/.config/gh/*`,
      `${CWD}/notes`,
      `${CWD}/notes/*`,
      HOME,
      `${HOME}/*`,
    ]);
    // グロブを含むエントリは展開せずそのまま
    expect(permission.allowWrite).toEqual(["/scratch/**/*.log"]);
  });

  it("returns empty permission lists when the user granted nothing", () => {
    const rules = SandboxRulesSchema.parse({});
    const { permission } = buildSandboxSettings({
      rules,
      allowWrite: [CWD],
      home: HOME,
      cwd: CWD,
    });
    expect(permission).toEqual({ allowRead: [], allowWrite: [] });
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
