#!/usr/bin/env node
// pi のスタブ (SessionRunner 統合テスト用)。実 LLM なしで RPC の入出力を再現する。
//
// - stdin の JSONL コマンドをすべて `<workdir>/commands.jsonl` に追記する
//   (workdir は --session の親ディレクトリ)。テストはこれを読んで assert する
// - prompt コマンドへの応答はメッセージ本文のマーカーで切り替える:
//     "NO_REPLY"       … reply を呼ばず agent_end だけ吐く (沈黙ケース)
//     "WAIT_FOR_STEER" … steer コマンドが届くまで待ち、届いたら steer の内容を
//                        echo する reply → agent_end を吐く (steering ケース)
//     "FAIL_PROMPT"    … success:false の response だけ返し、agent_end は吐かない
//                        (pi 側が動けないケース。runner の異常終了処理を検証する)
//     "HANG_FOREVER"   … response も agent_end も一切返さない (pi が無応答になる
//                        ケース。runner の turn timeout 処理を検証する)
//     "CRASH_NOW"      … running のまま即 process.exit(1) する (pi プロセスの
//                        クラッシュ。runner の proc.on("exit") 異常分岐を検証する)
//     "SLOW_TOOL"      … tool_execution_start ("dummy_tool") を吐いた後、steer が
//                        届くまで待つ (runner の進捗通知タイマーが currentTool を
//                        観測できる状態を維持する。progress-notice.md)
//     "WITH_FILES"     … reply の details.files に ["ok.txt", "../escape.txt",
//                        "/etc/passwd"] を積む (runner の workdir 境界チェックを検証する)
//     "ALL_ESCAPE_FILES" … reply の details.files が全件 workdir 外 (["../escape.txt",
//                        "/etc/passwd"])。全件除外後に files を素の相対パスへ戻さない
//                        ことを検証する
//     それ以外          … `echo: <本文>` の reply → agent_end を吐く
// - agent_end.messages には固定の usage 付き assistant message を 1 件含める
//   (SessionRunner の usage 集計ロジックをテストから確認するため)
// - thread_key はまず prompt/steer の message 本文中の "(thread_key: <key>):" を拾う
//   (session-model.md §3: メッセージごとの thread_key)。見つからなければ
//   --append-system-prompt 末尾の "Fallback thread_key for this session: <key>" を使う
// - stdin が閉じたら終了する (PiProcess.stop の graceful パス)
// - 起動時に <workdir>/env-seen.json へ process.env のスナップショットを書く
//   (SessionRunner → PiProcess の extraEnv 透過をテストから確認するため)
// - 起動時に <workdir>/argv-seen.json へ process.argv (先頭 2 要素を除く実引数) を書く
//   (SessionRunner → PiProcess → buildPiArgs の --skill 等の透過をテストから確認するため)

import { appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

const sessionPath = argValue("--session");
if (!sessionPath) {
  console.error("fake-pi: --session is required");
  process.exit(1);
}
const workdir = dirname(sessionPath);
const commandsLog = join(workdir, "commands.jsonl");
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

/** message 本文中の直近の "(thread_key: <key>):" を拾う。無ければ session の
 * fallback thread_key を使う (buildSystemPrompt の指示と同じ規則) */
function threadKeyFromMessage(message) {
  const matches = [...message.matchAll(/\(thread_key: (\S+)\):/g)];
  const last = matches.at(-1);
  return last ? last[1] : fallbackThreadKey;
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function emitReply(threadKey, text, files) {
  emit({
    type: "tool_execution_end",
    toolCallId: `tc-${Date.now()}`,
    toolName: "reply",
    result: {
      content: [{ type: "text", text: "Reply queued." }],
      details: {
        thread_key: threadKey,
        text,
        ...(files !== undefined ? { files } : {}),
      },
    },
    isError: false,
  });
}

function emitToolExecutionStart(toolName, args) {
  emit({
    type: "tool_execution_start",
    toolCallId: `tc-${Date.now()}`,
    toolName,
    ...(args !== undefined ? { args } : {}),
  });
}

function emitAgentEnd() {
  emit({
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        usage: {
          input: 100,
          output: 50,
          cacheRead: 10,
          cacheWrite: 5,
          totalTokens: 150,
          cost: { total: 0.01 },
        },
      },
    ],
  });
}

let waitingForSteer = false;

function handleCommand(command) {
  appendFileSync(commandsLog, `${JSON.stringify(command)}\n`);

  if (command.type === "prompt") {
    if (command.message.includes("WAIT_FOR_STEER")) {
      waitingForSteer = true;
      return;
    }
    if (command.message.includes("NO_REPLY")) {
      emitAgentEnd();
      return;
    }
    if (command.message.includes("FAIL_PROMPT")) {
      emit({
        type: "response",
        command: "prompt",
        success: false,
        error: "No API key found for google-vertex",
      });
      return;
    }
    if (command.message.includes("HANG_FOREVER")) {
      // 何も返さない。runner 側の turn timeout がタイマーで kill するまで
      // このプロセスは生き続ける (SIGKILL を受けて終了する)
      return;
    }
    if (command.message.includes("CRASH_NOW")) {
      // response も agent_end も返さず、running のまま即クラッシュする。
      // runner の proc.on("exit") 異常分岐 (item を捨てる処理) を検証する
      process.exit(1);
    }
    if (command.message.includes("SLOW_TOOL")) {
      emitToolExecutionStart("dummy_tool", { command: "sleep 300" });
      waitingForSteer = true;
      return;
    }
    if (command.message.includes("WITH_FILES")) {
      emitReply(
        threadKeyFromMessage(command.message),
        `echo: ${command.message}`,
        ["ok.txt", "../escape.txt", "/etc/passwd"],
      );
      emitAgentEnd();
      return;
    }
    if (command.message.includes("ALL_ESCAPE_FILES")) {
      emitReply(
        threadKeyFromMessage(command.message),
        `echo: ${command.message}`,
        ["../escape.txt", "/etc/passwd"],
      );
      emitAgentEnd();
      return;
    }
    emitReply(
      threadKeyFromMessage(command.message),
      `echo: ${command.message}`,
    );
    emitAgentEnd();
    return;
  }

  if (command.type === "steer" && waitingForSteer) {
    waitingForSteer = false;
    emitReply(
      threadKeyFromMessage(command.message),
      `steered: ${command.message}`,
    );
    emitAgentEnd();
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length > 0) handleCommand(JSON.parse(line));
    index = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  process.exit(0);
});
