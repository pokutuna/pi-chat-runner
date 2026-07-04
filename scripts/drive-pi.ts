/**
 * Step 2 検証用の使い捨て駆動スクリプト。Slack にはつながない。
 *
 * 使い方:
 *   pnpm exec tsx scripts/drive-pi.ts [--session /tmp/pi-drive/s1.jsonl] \
 *     [--model gemini-2.5-flash-lite] [--provider google-vertex] [--pi-bin pi] \
 *     "プロンプト本文"
 *
 * 実行中に標準入力へ行を打つと steer として送る。
 * agent_end 後の入力行は prompt として新しいターンを起こす。
 * Ctrl-D (stdin EOF) または Ctrl-C で終了。
 * --once 指定時は最初の agent_end で pi を止めて終了する (非対話検証用)。
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	extractReply,
	isAgentEnd,
	isToolExecutionEnd,
} from "../src/session/rpc.js";
import { PiProcess } from "../src/session/runtime.js";

const { values, positionals } = parseArgs({
	options: {
		session: { type: "string" },
		model: { type: "string" },
		provider: { type: "string" },
		"pi-bin": { type: "string" },
		"thread-key": { type: "string", default: "local-test-thread" },
		once: { type: "boolean", default: false },
	},
	allowPositionals: true,
});

const promptText = positionals.join(" ").trim();
if (!promptText) {
	console.error('usage: tsx scripts/drive-pi.ts [options] "prompt text"');
	process.exit(1);
}

const sessionPath = resolve(
	values.session ?? `/tmp/pi-drive/session-${Date.now()}.jsonl`,
);
mkdirSync(dirname(sessionPath), { recursive: true });

const extensionPath = resolve(import.meta.dirname, "../extensions/reply.ts");
const threadKey = values["thread-key"];

const pi = new PiProcess({
	sessionPath,
	extensionPath,
	...(values["pi-bin"] ? { piBinary: values["pi-bin"] } : {}),
	...(values.model ? { model: values.model } : {}),
	...(values.provider ? { provider: values.provider } : {}),
	appendSystemPrompt: `You are running in a chat runner test. The current thread_key is "${threadKey}".`,
	logger: (line) => console.error(`\x1b[31m[stderr]\x1b[0m ${line}`),
});

let agentRunning = false;

pi.on("response", (res) => {
	console.log(
		`\x1b[36m[response]\x1b[0m ${res.command} success=${res.success}`,
	);
	if (!res.success && res.error) console.log(`  error: ${res.error}`);
});

pi.on("event", (event) => {
	if (isToolExecutionEnd(event)) {
		const reply = extractReply(event);
		if (reply) {
			console.log(
				`\x1b[32m[REPLY]\x1b[0m thread_key=${reply.thread_key}\n  ${reply.text.replaceAll("\n", "\n  ")}`,
			);
		} else {
			console.log(
				`\x1b[33m[tool_execution_end]\x1b[0m ${event.toolName} isError=${event.isError}`,
			);
		}
		return;
	}
	if (isAgentEnd(event)) {
		agentRunning = false;
		console.log(
			`\x1b[35m[agent_end]\x1b[0m messages=${event.messages.length} (type a line to follow up, Ctrl-D to exit)`,
		);
		if (values.once) {
			console.log("[--once] stopping pi...");
			void pi.stop();
		}
		return;
	}
	switch (event.type) {
		case "agent_start":
			agentRunning = true;
			console.log("\x1b[35m[agent_start]\x1b[0m");
			break;
		case "turn_start":
		case "turn_end":
			console.log(`\x1b[35m[${event.type}]\x1b[0m`);
			break;
		case "tool_execution_start":
			console.log(
				`\x1b[33m[tool_execution_start]\x1b[0m ${String((event as { toolName?: unknown }).toolName)} args=${JSON.stringify((event as { args?: unknown }).args)}`,
			);
			break;
		case "message_update":
			break; // streaming delta は流さない
		default:
			console.log(`\x1b[90m[${event.type}]\x1b[0m`);
	}
});

pi.on("invalid", (raw, error) => {
	console.error(`\x1b[31m[invalid line]\x1b[0m ${error}: ${raw.slice(0, 200)}`);
});

pi.on("exit", (code, signal) => {
	console.log(`\x1b[35m[exit]\x1b[0m code=${code} signal=${signal}`);
	process.exit(code ?? 0);
});

console.log(`session: ${sessionPath}`);
console.log(`extension: ${extensionPath}`);
pi.start();
pi.prompt(promptText);

// 標準入力の行を steer (実行中) / prompt (待機中) として送る
process.stdin.setEncoding("utf8");
let stdinBuffer = "";
process.stdin.on("data", (chunk: string) => {
	stdinBuffer += chunk;
	let index = stdinBuffer.indexOf("\n");
	while (index !== -1) {
		const line = stdinBuffer.slice(0, index).trim();
		stdinBuffer = stdinBuffer.slice(index + 1);
		index = stdinBuffer.indexOf("\n");
		if (!line) continue;
		if (agentRunning) {
			console.log(`\x1b[34m[steer ->]\x1b[0m ${line}`);
			pi.steer(line);
		} else {
			console.log(`\x1b[34m[prompt ->]\x1b[0m ${line}`);
			pi.prompt(line);
		}
	}
});
process.stdin.on("end", async () => {
	// --once では agent_end 側で止めるので stdin EOF は無視する
	if (values.once) return;
	console.log("[stdin closed] stopping pi...");
	await pi.stop();
});
