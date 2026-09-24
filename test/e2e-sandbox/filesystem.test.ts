// ファイルシステム境界 (runtime.md §5.5): 書けるのは自分の workdir / TMPDIR / HOME だけ。
// 読み取りは Channel 単位で分かれ、同じ Channel の他 Session の workdir は読めるが、
// 他 Channel の workdir と settings ファイルは読めない。
import { access, readFile } from "node:fs/promises";

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
    "同じ Channel の他 Session の workdir は読めるが書けない",
    async () => {
      const runner = await startSandboxRunner({
        agent: { sandbox: SandboxRulesSchema.parse({}) },
        channels: mentionChannels(A),
      });
      const first = await runner.probe(A, ["echo a > a.txt"]);
      const workdirFirst = runner.workdirFor(A, first.ts);

      // 同じ Channel の別スレッド = 別 Session
      const { results } = await runner.probe(A, [
        'touch "$PWD/x" && echo own-ok',
        `cat ${workdirFirst}/a.txt`,
        `touch ${workdirFirst}/x 2>&1; echo "exit=$?"`,
        'touch /usr/local/x 2>&1; echo "exit=$?"',
      ]);
      // 対照: 自分の workdir には書ける
      expect(results[0]).toMatchObject({ code: 0, out: "own-ok\n" });
      expect(results[1]).toMatchObject({ code: 0, out: "a\n" });
      expect(results[2]?.out).toMatch(
        /Read-only file system|Permission denied/,
      );
      expect(results[3]?.out).toMatch(
        /Read-only file system|Permission denied/,
      );
    },
    SANDBOX_TEST_TIMEOUT_MS,
  );

  it(
    "他 Channel の workdir は読めず、書き込もうとしても実体に届かない",
    async () => {
      const runner = await startSandboxRunner({
        agent: { sandbox: SandboxRulesSchema.parse({}) },
        channels: mentionChannels(A, B),
      });
      const a = await runner.probe(A, ["echo a > a.txt"]);
      const workdirA = runner.workdirFor(A, a.ts);

      const b = await runner.probe(B, [
        `cat ${workdirA}/a.txt`,
        `touch ${workdirA}/x`,
      ]);
      // bwrap は隠したディレクトリを空の tmpfs に差し替えるので、エラーの種類は見ず、
      // 中身が見えないことと実体側にファイルができていないことを見る
      expect(b.results[0]?.code).not.toBe(0);
      expect(b.results[0]?.out).not.toContain("a");
      await expect(access(`${workdirA}/x`)).rejects.toMatchObject({
        code: "ENOENT",
      });
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
    "settings ファイルは読めず、書き換えようとしても実体は変わらない",
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
          `{ echo tampered >> ${settings}; } 2>&1; true`,
          `{ rm ${settings}; } 2>&1; true`,
        ],
        { threadTs: first.ts },
      );
      expect(results[0]?.out).not.toContain("settings-probe.example.com");
      // 対照: Runner 側からは読めて、中身は書き換わっていない
      const onHost = await readFile(settings, "utf-8");
      expect(onHost).toContain("settings-probe.example.com");
      expect(onHost).not.toContain("tampered");
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
