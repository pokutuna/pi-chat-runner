// turn timeout で Session のために立てたプロセスが全部消えるか (runtime.md §5.5)。
// srt の内側 (probe → sleep) も、srt が host 側に立てる補助プロセスも、コマンドラインに
// この Session のディレクトリ (workdirRoot 配下: workdir / tmp / settings) を持つので、
// srt の実装 (bwrap / socat / …) の名前には依らず「Session のパスを参照するプロセスが
// 残っていない」ことを Runner 側の ps で確認する。
import { expect, it } from "vitest";

import { SandboxRulesSchema } from "../../src/config/sandbox-config.js";
import {
  describeSandbox,
  mentionChannels,
  processesMatching,
  SANDBOX_TEST_TIMEOUT_MS,
  sleep,
  startSandboxRunner,
} from "./helpers/sandbox-runner.js";

const C = "C_TIMEOUT";
const MARKER = "sleep 600";

describeSandbox("sandbox e2e: turn timeout", () => {
  it(
    "turn timeout 後に Session のために立てたプロセスが残らない",
    async () => {
      const runner = await startSandboxRunner({
        agent: { sandbox: SandboxRulesSchema.parse({}) },
        channels: mentionChannels(C),
        turnTimeoutMs: 3_000,
      });
      await runner.post(C, [MARKER]);
      // 対照: timeout 前は sleep が (sandbox の中で) 生きている
      await runner.waitForLog("session started");
      await sleep(1_000);
      expect(await processesMatching(new RegExp(MARKER))).not.toEqual([]);

      // 対照: timeout 前は Session のパスを参照するプロセス (srt 自身など) もいる
      const sessionPaths = new RegExp(
        runner.workdirRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      );
      expect(await processesMatching(sessionPaths)).not.toEqual([]);

      await runner.waitForLog("turn timed out");
      // stop の猶予 (stdin close 10s + SIGTERM 5s) を超えて待つ
      await sleep(17_000);
      expect(await processesMatching(new RegExp(MARKER))).toEqual([]);
      expect(await processesMatching(/probe-pi\.mjs/)).toEqual([]);
      expect(await processesMatching(sessionPaths)).toEqual([]);
    },
    SANDBOX_TEST_TIMEOUT_MS,
  );
});
