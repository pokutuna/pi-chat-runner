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
//     それ以外          … `echo: <本文>` の reply → agent_end を吐く
// - agent_end.messages には固定の usage 付き assistant message を 1 件含める
//   (SessionRunner の usage 集計ロジックをテストから確認するため)
// - thread_key は --append-system-prompt に埋め込まれた "thread_key: <key>" を拾う
// - stdin が閉じたら終了する (PiProcess.stop の graceful パス)
// - 起動時に <workdir>/env-seen.json へ process.env のスナップショットを書く
//   (SessionRunner → PiProcess の extraEnv 透過をテストから確認するため)

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

const systemPrompt = argValue("--append-system-prompt") ?? "";
const threadKeyMatch = systemPrompt.match(/thread_key: (\S+)/);
const threadKey = threadKeyMatch ? threadKeyMatch[1] : "unknown";

function emit(event) {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

function emitReply(text) {
	emit({
		type: "tool_execution_end",
		toolCallId: `tc-${Date.now()}`,
		toolName: "reply",
		result: {
			content: [{ type: "text", text: "Reply queued." }],
			details: { thread_key: threadKey, text },
		},
		isError: false,
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
		emitReply(`echo: ${command.message}`);
		emitAgentEnd();
		return;
	}

	if (command.type === "steer" && waitingForSteer) {
		waitingForSteer = false;
		emitReply(`steered: ${command.message}`);
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
