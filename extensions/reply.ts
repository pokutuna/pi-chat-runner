/**
 * reply extension
 *
 * pi の extension API で `reply(thread_key, text)` ツールを登録する。
 * execute は Slack を叩かず、引数をそのまま result (details) に詰めて返すだけ。
 * 実際のチャットへの投稿は、ホスト (Runner) が RPC の `tool_execution_end`
 * イベントを拾って行う (docs/design/session-runtime.md §2)。
 * この設計により pi 子プロセスには接続設定も秘匿値も一切要らない。
 *
 * pi が `--extension` でソースのまま直接ロードするため、ビルド対象外。
 * `@earendil-works/pi-coding-agent` / `typebox` の import は pi のローダが
 * 自身のバンドル済みインスタンスへエイリアスする (依存はここでは型のためだけ)。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface ReplyToolDetails {
	thread_key: string;
	text: string;
	files?: string[];
}

export default function replyExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "reply",
		label: "Reply",
		description: [
			"Send a finalized answer to the user in the chat thread.",
			"This is the ONLY way your response reaches the user; plain assistant text is not delivered.",
			"You may call this tool multiple times in a single turn,",
			"e.g. to post an interim finding first and the final answer later.",
			"Optionally attach files by passing workdir-relative paths.",
		].join(" "),
		// promptSnippet が無いと system prompt の Available tools 節にツールが
		// 載らない (pi の ToolDefinition の仕様)。reply は唯一の出力経路なので必ず載せる
		promptSnippet: [
			"reply(thread_key, text, files?): Send your answer to the user.",
			"This is the only way to reach the user; plain assistant text is not delivered.",
			"Use the thread_key annotated on the message you are replying to.",
			"files is an optional list of workdir-relative paths to attach.",
		].join(" "),
		parameters: Type.Object({
			thread_key: Type.String({
				description:
					"Thread key identifying the conversation thread to reply to. Use the thread_key given in the prompt.",
			}),
			text: Type.String({
				description: "Message text to post to the user.",
			}),
			files: Type.Optional(
				Type.Array(
					Type.String({
						description:
							"Optional workdir-relative paths of files to attach to this reply.",
					}),
				),
			),
		}),
		async execute(_toolCallId, params) {
			// Slack へは投稿しない。ホストが tool_execution_end で args/details を受け取る。
			const details: ReplyToolDetails = {
				thread_key: params.thread_key,
				text: params.text,
				...(params.files !== undefined ? { files: params.files } : {}),
			};
			return {
				content: [
					{
						type: "text",
						text: `Reply queued for delivery to thread ${params.thread_key}.`,
					},
				],
				details,
			};
		},
	});
}
