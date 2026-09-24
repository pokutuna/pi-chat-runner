#!/usr/bin/env node
// srt CLI (@anthropic-ai/sandbox-runtime dist/cli.js) のスタブ。bwrap を持たない
// ホストで、Session → PiProcess → wrapWithSrt の配線 (settings ファイルの位置と中身、
// `--` 以降の内側コマンド) を観測するためのもの。実際の遮断は何もしない。
//
// 引数の形は本物と同じ: `[--debug] --settings <file> -- <command> <args...>`
// - 内側コマンドに `--session <path>` があれば workdir (= dirname) を求め、
//   `<workdir>/srt-seen.json` に { settingsPath, settings, debug, inner } を書く
//   (無ければ書かない。boot 時の probe は `-- true` だけを包む)
// - 内側コマンドを stdio 継承で spawn し、終了コードを転送する。SIGTERM は子へ転送する

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep === -1) {
  console.error("fake-srt: missing --");
  process.exit(2);
}
const own = argv.slice(0, sep);
const inner = argv.slice(sep + 1);
const settingsIndex = own.indexOf("--settings");
const settingsPath = settingsIndex === -1 ? undefined : own[settingsIndex + 1];
if (settingsPath === undefined) {
  console.error("fake-srt: --settings is required");
  process.exit(2);
}
const sessionIndex = inner.indexOf("--session");
const sessionPath = sessionIndex === -1 ? undefined : inner[sessionIndex + 1];
if (sessionPath !== undefined) {
  writeFileSync(
    join(dirname(sessionPath), "srt-seen.json"),
    JSON.stringify({
      settingsPath,
      settings: JSON.parse(readFileSync(settingsPath, "utf-8")),
      debug: own.includes("--debug"),
      inner,
    }),
  );
}

const [command, ...args] = inner;
const child = spawn(command, args, { stdio: "inherit" });
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
