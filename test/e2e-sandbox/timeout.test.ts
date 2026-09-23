// turn timeout で srt / bwrap / proxy まで後始末されるか (PLAN §2-4 の stop 経路)。
// PiProcess.stop は stdin close → SIGTERM → SIGKILL を srt に対して行う。srt の内側
// (bwrap → bash → probe → sleep) と srt が host 側に立てる socat が残らないことを
// Runner 側の ps で確認する。
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
    "turn timeout 後に pi / srt / bwrap / socat のプロセスが残らない",
    async () => {
      const runner = await startSandboxRunner({
        agent: { sandbox: SandboxRulesSchema.parse({}) },
        channels: mentionChannels(C),
        turnTimeoutMs: 3_000,
      });
      const ts = await runner.post(C, [MARKER]);
      // 対照: timeout 前は sleep が (sandbox の中で) 生きている
      await runner.waitForLog("session started");
      await sleep(1_000);
      expect(await processesMatching(new RegExp(MARKER))).not.toEqual([]);

      await runner.waitForLog("turn timed out");
      // stop の猶予 (stdin close 10s + SIGTERM 5s) を超えて待つ
      await sleep(17_000);
      expect(await processesMatching(new RegExp(MARKER))).toEqual([]);
      expect(await processesMatching(/probe-pi\.mjs/)).toEqual([]);
      expect(await processesMatching(/\bbwrap\b/)).toEqual([]);
      expect(await processesMatching(/\bsocat\b/)).toEqual([]);
      expect(
        await processesMatching(
          new RegExp(
            `sandbox-runtime/dist/cli\\.js.*${runner.settingsPathFor(C, ts).replace(/[.:]/g, "\\$&")}`,
          ),
        ),
      ).toEqual([]);
    },
    SANDBOX_TEST_TIMEOUT_MS,
  );
});
