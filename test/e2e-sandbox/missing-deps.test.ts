// srt の依存 (socat) が PATH に無いイメージでは Session が起動しない (fail-closed) —
// Dockerfile の apt 行の欠落をここで検出する。イメージを 2 つ作らず、このファイルの
// プロセス env (vitest はファイルごとに worker を分ける) から socat を消して再現する。
import { mkdtemp, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { expect, it } from "vitest";

import { SandboxRulesSchema } from "../../src/config/sandbox-config.js";
import {
  describeSandbox,
  mentionChannels,
  SANDBOX_TEST_TIMEOUT_MS,
  startSandboxRunner,
} from "./helpers/sandbox-runner.js";

const C = "C_NOSOCAT";

/** PATH 上の全コマンドを 1 つのディレクトリに symlink し、socat だけ除く */
async function pathWithoutSocat(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "no-socat-bin-"));
  const seen = new Set<string>();
  for (const bin of (process.env.PATH ?? "").split(delimiter)) {
    let names: string[];
    try {
      names = await readdir(bin);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name === "socat" || seen.has(name)) continue;
      seen.add(name);
      await symlink(join(bin, name), join(dir, name)).catch(() => {});
    }
  }
  return dir;
}

describeSandbox("sandbox e2e: missing host dependency", () => {
  it(
    "socat が無いと srt が起動を拒み、Session は失敗する (Session なしで動かない)",
    async () => {
      process.env.PATH = await pathWithoutSocat();
      const runner = await startSandboxRunner({
        agent: { sandbox: SandboxRulesSchema.parse({}) },
        channels: mentionChannels(C),
      });
      await runner.post(C, ["echo should-not-run"]);
      // srt は依存チェックの失敗を stderr に出して exit する。Runner は pi の stderr を
      // debug で記録し、running のまま exit したことを warn する
      const stderr = await runner.waitForLog("pi stderr", (r) =>
        /socat/i.test(String(r.line)),
      );
      expect(String(stderr.line)).toMatch(/socat/);
      await runner.waitForLog("pi exited unexpectedly");
      expect(runner.chat.log().filter((m) => m.sender.isSelf)).toEqual([]);
    },
    SANDBOX_TEST_TIMEOUT_MS,
  );
});
