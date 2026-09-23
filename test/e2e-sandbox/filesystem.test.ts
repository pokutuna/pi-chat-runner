// ファイルシステム境界 (runtime.md §5.5): 書けるのは workdir / TMPDIR / HOME だけ、
// 他 Session の workdir と settings ファイルは読めても書けない。
import { readFile } from "node:fs/promises";

import { expect, it } from "vitest";

import { SandboxRulesSchema } from "../../src/config/sandbox-config.js";
import {
  describeSandbox,
  mentionChannels,
  SANDBOX_TEST_TIMEOUT_MS,
  startSandboxRunner,
} from "./helpers/sandbox-runner.js";

const A = "C_FS_A";
const B = "C_FS_B";

describeSandbox("sandbox e2e: filesystem", () => {
  it(
    "自分の workdir には書け、他 Session の workdir には書けない",
    async () => {
      const runner = await startSandboxRunner({
        agent: { sandbox: SandboxRulesSchema.parse({}) },
        channels: mentionChannels(A, B),
      });

      // Session A を起こして workdir を実在させる
      const a = await runner.probe(A, ["echo a > a.txt && cat a.txt"]);
      expect(a.results[0]).toMatchObject({ code: 0, out: "a\n" });
      const workdirA = runner.workdirFor(A, a.ts);

      const b = await runner.probe(B, [
        'touch "$PWD/x" && echo own-ok',
        `touch ${workdirA}/x 2>&1; echo "exit=$?"`,
        `cat ${workdirA}/a.txt 2>&1; echo "exit=$?"`,
        'touch /usr/local/x 2>&1; echo "exit=$?"',
      ]);
      // 対照: 自分の workdir には書ける
      expect(b.results[0]).toMatchObject({ code: 0, out: "own-ok\n" });
      // 他 Session の workdir は read-only (EROFS) — 読めるかは uid/mode 次第なので
      // 書けないことだけを見る
      expect(b.results[1]?.out).toMatch(
        /Read-only file system|Permission denied/,
      );
      expect(b.results[1]?.out).toMatch(/exit=1/);
      expect(b.results[3]?.out).toMatch(
        /Read-only file system|Permission denied/,
      );
    },
    SANDBOX_TEST_TIMEOUT_MS,
  );

  it(
    "TMPDIR は Session 専用ディレクトリを指し、書き込める",
    async () => {
      const runner = await startSandboxRunner({
        agent: { sandbox: SandboxRulesSchema.parse({}) },
        channels: mentionChannels(A),
      });
      const { ts, results } = await runner.probe(A, [
        'echo -n "$TMPDIR"',
        'echo spill > "$TMPDIR/pi-bash-probe.log" && cat "$TMPDIR/pi-bash-probe.log"',
        // 50KB 超えの出力を作ってもプロセスが死なない (pi の spill 相当の量)
        "head -c 70000 /dev/zero | base64 | wc -c",
      ]);
      expect(results[0]?.out).toBe(runner.tmpDirFor(A, ts));
      expect(results[1]).toMatchObject({ code: 0, out: "spill\n" });
      expect(results[2]?.code).toBe(0);
      // Runner 側からも同じファイルが見える (同じディレクトリを指している)
      expect(
        await readFile(`${runner.tmpDirFor(A, ts)}/pi-bash-probe.log`, "utf-8"),
      ).toBe("spill\n");
    },
    SANDBOX_TEST_TIMEOUT_MS,
  );

  it(
    "settings ファイルは読めるが書き換えられない",
    async () => {
      const runner = await startSandboxRunner({
        agent: {
          sandbox: SandboxRulesSchema.parse({
            network: { allowedDomains: ["settings-probe.example.com"] },
          }),
        },
        channels: mentionChannels(A),
      });
      // settings のパスは sessionKey から決まるので、最初の Turn の中で 2 回目の
      // probe を同じスレッドに投げてパスを知った状態で読み書きを試す
      const first = await runner.probe(A, ["true"]);
      const settings = runner.settingsPathFor(A, first.ts);
      const { results } = await runner.probe(
        A,
        [
          `cat ${settings}`,
          // リダイレクト自体のエラーは bash が出すのでブロックで包んで 2>&1 する
          `{ echo '{"network":{}}' >> ${settings}; } 2>&1; echo "exit=$?"`,
          `{ rm ${settings}; } 2>&1; echo "exit=$?"`,
        ],
        { threadTs: first.ts },
      );
      expect(results[0]?.code).toBe(0);
      expect(results[0]?.out).toContain("settings-probe.example.com");
      expect(results[1]?.out).toMatch(
        /Read-only file system|Permission denied/,
      );
      expect(results[2]?.out).toMatch(
        /Read-only file system|Permission denied/,
      );
    },
    SANDBOX_TEST_TIMEOUT_MS,
  );

  it(
    "pid namespace の外 (Runner の環境) は /proc から見えない",
    async () => {
      process.env.RUNNER_SECRET_MARKER = "runner-only-value";
      const runner = await startSandboxRunner({
        agent: { sandbox: SandboxRulesSchema.parse({}) },
        channels: mentionChannels(A),
      });
      const { results } = await runner.probe(A, [
        "cat /proc/1/environ 2>&1 | tr '\\0' '\\n' | grep -c RUNNER_SECRET_MARKER; true",
        "grep -l RUNNER_SECRET_MARKER /proc/*/environ 2>/dev/null | wc -l",
        "ls /proc | grep -c '^[0-9]'",
      ]);
      expect(results[0]?.out.trim()).toBe("0");
      expect(results[1]?.out.trim()).toBe("0");
      // pid ns の中には bwrap / bash / probe 程度しか居ない
      expect(Number(results[2]?.out.trim())).toBeLessThan(20);
    },
    SANDBOX_TEST_TIMEOUT_MS,
  );
});
