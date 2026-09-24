// srt (sandbox-runtime) 向け settings の組み立て (docs/design/runtime.md §5.5)。
//
// 利用者が書いた srt の設定 (config/sandbox-config.ts で正規化し、Channel が足す要素を
// union 済み) に、Runner が Session ごとに決める書き込み先を足して srt に渡す最終形
// にする。ここは純粋関数だけ — ファイルの書き出しは Session (session/session.ts) が、
// spawn 引数への展開は pi-args.ts の wrapWithSrt が行う。

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

import type { SandboxRules } from "../config/sandbox-config.js";

/** PiProcess に渡す、srt CLI で pi を包むための起動パラメタ。 */
export interface SandboxSpawnConfig {
  /** srt の dist/cli.js の絶対パス (RuntimeConfig.srtEntrypoint) */
  srtEntrypoint: string;
  /** `--settings` に渡す、Session 用に合成済みの settings ファイルの絶対パス */
  settingsPath: string;
  /** true なら `--debug` を付ける (srt の [SandboxDebug] 行が pi の stderr に混ざる)。
   * Runner のログレベルが debug のときに立てる */
  debug: boolean;
}

/** Session 用 settings ファイルの置き場: `<workdirRoot>/srt/<sessionKey>.json`。
 * workdir の外に置く — agent が自分のポリシーファイルを書き換えられないように
 * (workdir は agent 所有、workdirRoot 直下は Runner 所有)。sessionKey は
 * `<channelId>:<threadTs>` 形で `/` を含まないが、ファイル名として安全な形に
 * エンコードしておく */
export function sandboxSettingsPath(
  workdirRoot: string,
  sessionKey: string,
): string {
  return join(workdirRoot, "srt", `${encodeURIComponent(sessionKey)}.json`);
}

/** 利用者ルール + Runner が足す読み書きの範囲を合成する (runtime.md §5.5)。
 *
 * - `filesystem.allowWrite` に allowWrite (Session の workdir・TMPDIR・agentHome・
 *   shared staging) を足す (additive、
 *   利用者は外せない)。network には何も足さない — provider の到達先も利用者ファイルの
 *   責任 (config.md §1.3)
 * - 読み取りは Channel 単位で分ける。`filesystem.denyRead` に workdirRoot を足し、
 *   同じ Channel の他 Session の workdir を `filesystem.allowRead` で読めるように戻す。
 *   srt の read は allowRead が denyRead より優先されるので、他 Channel の workdir・
 *   TMPDIR・shared staging と `<workdirRoot>/srt/` の settings ファイルは読めない。
 *   全 Session が同じ agent uid で動くため、UID 分離ではこの境界を作れない
 * - 書き込み先そのものも allowRead に足す。srt (macOS) は denyRead の中の書き込み先を
 *   読み取り可に戻さないので、足さないと pi が自分の cwd を読めない。srt (Linux) は
 *   書き込み先の中にある allowRead を読み取り専用で重ねずに飛ばすので、書き込み可のまま残る
 * - Channel のディレクトリごと allowRead にはしない。srt (Linux) は denyRead の中の
 *   書き込み先を書き込み可で戻した後に allowRead を読み取り専用で重ねるので、
 *   書き込み先を含むディレクトリを allowRead にすると書き込み先まで読み取り専用になる。
 *   そのため Channel 直下のエントリのうち、書き込み先を含まないもの (他 Session の
 *   workdir) だけを戻す。一覧は Session 起動時のもので、後から作られた同じ Channel の
 *   Session の workdir は見えない */
export function buildSandboxSettings(input: {
  rules: SandboxRules;
  allowWrite: string[];
  /** Session 群のルート (realpath 済み)。丸ごと denyRead にする */
  workdirRoot: string;
  /** 自分の Channel のディレクトリ `<workdirRoot>/<channelId>` 直下にあるディレクトリ
   * (realpath 済みの絶対パス)。allowWrite のどれかを含むものを除いて allowRead に足す */
  channelEntries: string[];
}): SandboxRuntimeConfig {
  const { rules, allowWrite, workdirRoot, channelEntries } = input;
  const readableEntries = channelEntries.filter(
    (entry) =>
      !allowWrite.some((w) => w === entry || w.startsWith(`${entry}/`)),
  );
  return {
    ...rules,
    filesystem: {
      ...rules.filesystem,
      denyRead: [...new Set([...rules.filesystem.denyRead, workdirRoot])],
      allowRead: [
        ...new Set([
          ...(rules.filesystem.allowRead ?? []),
          ...readableEntries,
          ...allowWrite,
        ]),
      ],
      allowWrite: [...new Set([...rules.filesystem.allowWrite, ...allowWrite])],
    },
  };
}

/** srt が実際に起動できるかを、最小の settings で trivial なコマンドを 1 回包んで
 * 確かめる (boot 時チェック用。runtime.md §5.5)。srt は起動時に自分で OS ごとの依存
 * (Linux なら bwrap / socat / rg、macOS なら sandbox-exec) や namespace の可用性を検査して
 * stderr に理由を出すので、Runner はその一覧を持たず結果だけを見る。失敗時は srt の
 * stderr を返す。srt 自身も Session 起動時に同じ検査で失敗するが、それは最初のメッセージ
 * が来てからなので、イメージや実行環境の取りこぼしは boot で先に落とす */
export async function probeSandboxRuntime(
  srtEntrypoint: string,
  timeoutMs = 30_000,
): Promise<{ ok: true } | { ok: false; stderr: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-chat-runner-srt-probe-"));
  const settingsPath = join(dir, "settings.json");
  const settings: SandboxRuntimeConfig = {
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
  };
  try {
    await writeFile(settingsPath, JSON.stringify(settings));
    return await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [srtEntrypoint, "--settings", settingsPath, "--", "true"],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        stderr += `\nsrt probe timed out after ${timeoutMs}ms`;
      }, timeoutMs);
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ ok: false, stderr: `${stderr}\n${err.message}`.trim() });
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve({ ok: true });
        else resolve({ ok: false, stderr: stderr.trim() });
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
