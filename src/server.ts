// エントリポイント (Step 1: Socket Mode 疎通)
//
// Gate も pi も無し。mention への固定文字列返信 + トリガーメッセージへの 👀 リアクションのみ。
// docs/build-plan.md Step 1 / docs/design/architecture.md §1, §6。

import { WebClient } from "@slack/web-api";
import type { ChatEvent } from "./ingress/chat-event.js";
import type { Ack } from "./ingress/event-source.js";
import { SocketEventSource } from "./ingress/event-source.js";

const REPLY_TEXT = "hi, I'm pi-chat-runner (Step 1)";

function requireEnv(name: string): string {
	const value = process.env[name];
	if (value === undefined || value === "") {
		console.error(`Missing required environment variable: ${name}`);
		console.error("");
		console.error("Step 1 動作確認には以下の環境変数が必要です:");
		console.error(
			"  SLACK_BOT_TOKEN     xoxb-... (OAuth & Permissions で取得)",
		);
		console.error(
			"  SLACK_APP_TOKEN     xapp-... (Basic Information > App-Level Tokens, connections:write scope)",
		);
		console.error(
			"  SLACK_BOT_USER_ID   U...     (bot の User ID。App Home や `auth.test` で確認可能)",
		);
		console.error("");
		console.error("例 (.env ファイル推奨):");
		console.error("  cp .env.example .env  # 値を埋める");
		console.error(
			"  pnpm run dev          # --env-file-if-exists=.env で読み込まれる",
		);
		process.exit(1);
	}
	return value;
}

async function main() {
	const botToken = requireEnv("SLACK_BOT_TOKEN");
	const appToken = requireEnv("SLACK_APP_TOKEN");
	const botUserId = requireEnv("SLACK_BOT_USER_ID");

	const web = new WebClient(botToken);
	const eventSource = new SocketEventSource({ appToken, botUserId });

	// 同一メッセージは app_mention と message の 2 イベントで届く (event_id は別) ため、
	// メッセージ ts で重複排除する。Step 3 以降は inbox の dedupe に置き換わる暫定措置
	const seenMessages = new Set<string>();

	await eventSource.start(async (event: ChatEvent, ack: Ack) => {
		await ack();

		if (event.kind !== "message") {
			console.log(`[ignored] kind=${event.kind}`);
			return;
		}

		const messageKey = `${event.conversation.channelId}:${event.id}`;
		if (seenMessages.has(messageKey)) {
			console.log(`[ignored] duplicate delivery id=${event.id}`);
			return;
		}
		seenMessages.add(messageKey);
		if (seenMessages.size > 1000) {
			seenMessages.clear();
		}

		if (event.sender.isBot) {
			console.log(`[ignored] bot message id=${event.id}`);
			return;
		}

		if (!event.mentionsBot) {
			console.log(`[ignored] no mention id=${event.id}`);
			return;
		}

		const { channelId, threadTs } = event.conversation;
		const replyThreadTs = threadTs ?? event.id;

		console.log(
			`[mention] channel=${channelId} thread=${replyThreadTs} text=${JSON.stringify(event.text)}`,
		);

		await web.reactions.add({
			channel: channelId,
			timestamp: event.id,
			name: "eyes",
		});

		await web.chat.postMessage({
			channel: channelId,
			thread_ts: replyThreadTs,
			text: REPLY_TEXT,
		});
	});

	console.log("pi-chat-runner: Socket Mode connected. Waiting for events...");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
