#!/usr/bin/env node
// pi のスタブ (sandbox E2E 用。test/e2e-sandbox/)。fake-pi と同じ RPC の形で動くが、
// 応答は決まり文句ではなく「prompt に書かれた shell コマンドを実行した結果」。
// LLM を使わずに Runner の本物の spawn 経路 (settings 書き出し → srt → bwrap →
// この process) の内側から見えるものを観測する。
//
// - prompt 本文の `PROBE <json>` 行 (json: { "cmds": ["...", ...] }) を拾い、各コマンドを
//   `bash -c` で順に実行する。stdin は閉じる。1 コマンド 20 秒で打ち切る
// - 結果 [{ cmd, code, out, err }] (out/err は 400 文字に切る) を JSON 文字列にして
//   reply → agent_end で返す。PROBE 行が無ければ `no probe` を返す
// - env / argv のスナップショットを workdir (= --session の親) に書くのは fake-pi と同じ
//
// fs や network の観測はすべて bash 側のコマンドで行う (pi の bash tool と同じ経路)。

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

const sessionPath = argValue("--session");
if (!sessionPath) {
  console.error("probe-pi: --session is required");
  process.exit(1);
}
const workdir = dirname(sessionPath);
writeFileSync(join(workdir, "env-seen.json"), JSON.stringify(process.env));
writeFileSync(
  join(workdir, "argv-seen.json"),
  JSON.stringify(process.argv.slice(2)),
);

const systemPrompt = argValue("--append-system-prompt") ?? "";
const fallbackMatch = systemPrompt.match(
  /Fallback thread_key for this session: (\S+)/,
);
const fallbackThreadKey = fallbackMatch ? fallbackMatch[1] : "unknown";

function threadKeyFromMessage(message) {
  const matches = [...message.matchAll(/^thread_key: (\S+)$/gm)];
  const last = matches.at(-1);
  return last ? last[1] : fallbackThreadKey;
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function clip(text) {
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

function runProbe(cmds) {
  return cmds.map((cmd) => {
    const result = spawnSync("bash", ["-c", cmd], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    });
    return {
      cmd,
      code: result.status,
      signal: result.signal ?? null,
      out: clip(result.stdout ?? ""),
      err: clip(result.stderr ?? (result.error ? String(result.error) : "")),
    };
  });
}

function handlePrompt(message) {
  const line = message.match(/^PROBE (.+)$/m);
  const text =
    line === null
      ? "no probe"
      : JSON.stringify(runProbe(JSON.parse(line[1]).cmds));
  emit({
    type: "tool_execution_end",
    toolCallId: `tc-${Date.now()}`,
    toolName: "reply",
    result: {
      content: [{ type: "text", text: "Reply queued." }],
      details: { thread_key: threadKeyFromMessage(message), text },
    },
    isError: false,
  });
  emit({
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        stopReason: "stop",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { total: 0 },
        },
      },
    ],
  });
}

let buffer = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const raw = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (raw.trim() === "") continue;
    const command = JSON.parse(raw);
    emit({ type: "response", command: command.type, success: true });
    if (command.type === "prompt") handlePrompt(command.message);
  }
});
process.stdin.on("end", () => process.exit(0));
