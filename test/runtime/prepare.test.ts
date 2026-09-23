import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ResolvedChannel } from "../../src/config/config-source.js";
import { SandboxRulesSchema } from "../../src/config/sandbox-config.js";
import { buildSpawnOptions, sessionTmpDir } from "../../src/runtime/prepare.js";

describe("sessionTmpDir", () => {
  it("sits next to the workdir under <channel>/tmp, keyed by the workdir leaf", () => {
    expect(sessionTmpDir("/data/work/C01/1700000000.000100")).toBe(
      "/data/work/C01/tmp/1700000000.000100",
    );
    expect(sessionTmpDir("/data/work/C01/channel")).toBe(
      "/data/work/C01/tmp/channel",
    );
  });
});

describe("buildSpawnOptions (sandbox, runtime.md §5.5)", () => {
  let dir: string;
  let workdirReal: string;
  let tmpDirReal: string;
  let agentHomeReal: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "prepare-test-"));
    workdirReal = join(dir, "work");
    tmpDirReal = join(dir, "tmp");
    agentHomeReal = join(dir, "home");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const piPermission = {
    entrypoint: "/usr/local/lib/node_modules/pi/dist/cli.js",
    nodeModulesDir: "/usr/local/lib/node_modules",
  };

  function channelWith(sandbox: ResolvedChannel["agent"]["sandbox"]) {
    return {
      agent: { model: "google-vertex/gemini-3.5-flash", sandbox },
    } as ResolvedChannel;
  }

  async function build(channel: ResolvedChannel | null) {
    return buildSpawnOptions({
      agentHomeReal,
      workdirReal,
      tmpDirReal,
      sharedDirReal: undefined,
      channel,
      builtinExtensionPaths: [],
      memorySkillPath: undefined,
      piPermission,
    });
  }

  it("returns no sandbox settings when agent.sandbox is unset or false", async () => {
    expect((await build(null)).sandbox).toBeUndefined();
    expect((await build(channelWith(undefined))).sandbox).toBeUndefined();
    expect((await build(channelWith(false))).sandbox).toBeUndefined();
  });

  it("points the spill patterns at the session TMPDIR instead of /tmp", async () => {
    const { permission } = await build(null);
    expect(permission?.allowFsWrite).toContain(`${tmpDirReal}/*`);
    expect(permission?.allowFsRead).toContain(tmpDirReal);
    expect(permission?.allowFsWrite).not.toContain("/tmp/pi-bash-*");
  });

  it("adds workdir, TMPDIR and home to allowWrite and mirrors user paths into the Permission Model", async () => {
    const rules = SandboxRulesSchema.parse({
      network: { allowedDomains: ["aiplatform.googleapis.com:443"] },
      filesystem: { allowRead: ["/data/knowledge"], allowWrite: ["/scratch"] },
    });
    const { sandbox, permission } = await build(channelWith(rules));
    expect(sandbox?.filesystem.allowWrite).toEqual([
      "/scratch",
      workdirReal,
      tmpDirReal,
      agentHomeReal,
    ]);
    expect(sandbox?.network.allowedDomains).toEqual([
      "aiplatform.googleapis.com:443",
    ]);
    expect(permission?.allowFsRead).toContain("/data/knowledge/*");
    expect(permission?.allowFsWrite).toContain("/scratch/*");
  });

  it("includes the shared staging dir in allowWrite when present", async () => {
    const sharedDirReal = join(dir, "shared");
    const rules = SandboxRulesSchema.parse({});
    const { sandbox } = await buildSpawnOptions({
      agentHomeReal,
      workdirReal,
      tmpDirReal,
      sharedDirReal,
      channel: channelWith(rules),
      builtinExtensionPaths: [],
      memorySkillPath: undefined,
      piPermission,
    });
    expect(sandbox?.filesystem.allowWrite).toEqual([
      workdirReal,
      tmpDirReal,
      agentHomeReal,
      sharedDirReal,
    ]);
  });
});
