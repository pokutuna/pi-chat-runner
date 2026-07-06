/**
 * pi RPC プロトコル (stdin/stdout JSONL) の型とパース。
 * 参照: pi-coding-agent docs/rpc.md
 */

import type { ReplyPayload } from "../reply/router.js";

/** stdin に書く RPC コマンド (Step 2 で使う部分のみ) */
export type RpcCommand =
	| {
			type: "prompt";
			message: string;
			id?: string;
			streamingBehavior?: "steer" | "followUp";
	  }
	| { type: "steer"; message: string; id?: string }
	| { type: "follow_up"; message: string; id?: string }
	| { type: "abort"; id?: string }
	| { type: "get_state"; id?: string }
	| { type: "bash"; command: string; id?: string };

/** コマンドへの応答行 (id で相関) */
export interface RpcResponse {
	type: "response";
	command: string;
	success: boolean;
	id?: string;
	data?: unknown;
	error?: string;
}

export interface ToolResultContentText {
	type: "text";
	text: string;
}

export interface ToolExecutionEndEvent {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	result: {
		content: Array<
			ToolResultContentText | { type: string; [key: string]: unknown }
		>;
		details?: unknown;
	};
	isError: boolean;
}

export interface AgentEndEvent {
	type: "agent_end";
	messages: unknown[];
}

/** その他のイベントは型名だけ識別して素通しする */
export interface UnknownPiEvent {
	type: string;
	[key: string]: unknown;
}

export type PiEvent = ToolExecutionEndEvent | AgentEndEvent | UnknownPiEvent;

export type PiOutputLine =
	| { kind: "response"; response: RpcResponse }
	| { kind: "event"; event: PiEvent }
	| { kind: "invalid"; raw: string; error: string };

/**
 * stdout の 1 行をパースして response / event に振り分ける。
 * pi の多重化は「type === "response" なら応答、それ以外は全部イベント」という規約。
 */
export function parsePiOutputLine(line: string): PiOutputLine {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (e) {
		return {
			kind: "invalid",
			raw: line,
			error: e instanceof Error ? e.message : String(e),
		};
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { kind: "invalid", raw: line, error: "not a JSON object" };
	}
	const obj = parsed as Record<string, unknown>;
	if (typeof obj.type !== "string") {
		return { kind: "invalid", raw: line, error: "missing type field" };
	}
	if (obj.type === "response") {
		return { kind: "response", response: obj as unknown as RpcResponse };
	}
	return { kind: "event", event: obj as PiEvent };
}

export function isToolExecutionEnd(
	event: PiEvent,
): event is ToolExecutionEndEvent {
	return event.type === "tool_execution_end";
}

export function isAgentEnd(event: PiEvent): event is AgentEndEvent {
	return event.type === "agent_end";
}

/** tool_execution_end イベントから reply の引数を取り出す。reply 以外や形不正は null */
export function extractReply(
	event: ToolExecutionEndEvent,
): ReplyPayload | null {
	if (event.toolName !== "reply" || event.isError) return null;
	const details = event.result?.details;
	if (typeof details !== "object" || details === null) return null;
	const d = details as Record<string, unknown>;
	if (typeof d.thread_key !== "string" || typeof d.text !== "string")
		return null;
	return { thread_key: d.thread_key, text: d.text };
}

/**
 * agent_end の messages から assistant ターンのエラーを取り出す。
 * LLM 呼び出しが失敗しても (例: ADC 不備、ネットワーク遮断) pi はターンを
 * stopReason: "error" の assistant メッセージとして「正常に」完走させ agent_end を
 * 返すため、ここで拾ってログに出さないと「✅ は付くが返信が無い」という
 * 症状だけが残り、原因が transcript を直接読むまで分からない。
 */
export function extractTurnErrors(event: AgentEndEvent): string[] {
	const errors: string[] = [];
	for (const message of event.messages) {
		if (typeof message !== "object" || message === null) continue;
		const m = message as Record<string, unknown>;
		if (m.role !== "assistant" || m.stopReason !== "error") continue;
		errors.push(
			typeof m.errorMessage === "string" ? m.errorMessage : "unknown error",
		);
	}
	return errors;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	costTotal: number;
}

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * agent_end.messages (毎回「全履歴」を返す) から usage を合算する。
 * そのため戻り値はターン単位の増分ではなく「セッション累計」になる点に注意。
 */
export function extractUsageTotals(event: AgentEndEvent): UsageTotals {
	const totals: UsageTotals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		costTotal: 0,
	};
	for (const message of event.messages) {
		if (typeof message !== "object" || message === null) continue;
		const m = message as Record<string, unknown>;
		if (m.role !== "assistant") continue;
		if (typeof m.usage !== "object" || m.usage === null) continue;
		const usage = m.usage as Record<string, unknown>;
		totals.input += numberOrZero(usage.input);
		totals.output += numberOrZero(usage.output);
		totals.cacheRead += numberOrZero(usage.cacheRead);
		totals.cacheWrite += numberOrZero(usage.cacheWrite);
		totals.totalTokens += numberOrZero(usage.totalTokens);
		const cost = usage.cost;
		if (typeof cost === "object" && cost !== null) {
			totals.costTotal += numberOrZero((cost as Record<string, unknown>).total);
		}
	}
	return totals;
}

function preview(value: unknown, maxChars = 200): string {
	let text: string;
	try {
		text = typeof value === "string" ? value : JSON.stringify(value);
	} catch {
		text = String(value);
	}
	return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

/**
 * pi イベントの debug ログ用概要フィールド。ペイロード全体は大きく機微も含みうる
 * ため出さず、デバッグに効く要点だけ抜き出す。null を返したイベント
 * (message_update / tool_execution_update のストリーミング差分) はログしない —
 * 1 ターンで数百行出て他のログを埋めてしまうため。
 */
export function piEventLogFields(
	event: PiEvent,
): Record<string, unknown> | null {
	const e = event as Record<string, unknown>;
	switch (event.type) {
		case "message_update":
		case "tool_execution_update":
			return null;
		case "tool_execution_start":
			return {
				toolName: e.toolName,
				toolCallId: e.toolCallId,
				args: preview(e.args),
			};
		case "tool_execution_end": {
			const end = event as ToolExecutionEndEvent;
			const resultChars = (end.result?.content ?? []).reduce(
				(sum, c) =>
					sum + (c.type === "text" ? (c as { text: string }).text.length : 0),
				0,
			);
			return {
				toolName: end.toolName,
				toolCallId: end.toolCallId,
				isError: end.isError,
				resultChars,
			};
		}
		case "message_end": {
			const message = e.message;
			if (typeof message !== "object" || message === null) return {};
			const m = message as Record<string, unknown>;
			return {
				role: m.role,
				...(m.stopReason !== undefined ? { stopReason: m.stopReason } : {}),
				...(typeof m.errorMessage === "string"
					? { errorMessage: preview(m.errorMessage) }
					: {}),
			};
		}
		case "queue_update":
			return {
				steering: Array.isArray(e.steering) ? e.steering.length : 0,
				followUp: Array.isArray(e.followUp) ? e.followUp.length : 0,
			};
		case "compaction_start":
			return { reason: e.reason };
		case "extension_error":
			return { error: preview(e.error) };
		default:
			return {};
	}
}

/**
 * 厳密 JSONL のインクリメンタルデコーダ。
 * rpc.md の指定どおり LF のみをレコード区切りにする (Node readline は
 * U+2028/U+2029 も改行扱いするため不可)。末尾の CR は落とす。
 */
export class JsonlDecoder {
	private buffer = "";

	/** チャンクを追加し、完成した行 (空行は除く) を返す */
	push(chunk: string): string[] {
		this.buffer += chunk;
		const lines: string[] = [];
		let index = this.buffer.indexOf("\n");
		while (index !== -1) {
			let line = this.buffer.slice(0, index);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (line.length > 0) lines.push(line);
			this.buffer = this.buffer.slice(index + 1);
			index = this.buffer.indexOf("\n");
		}
		return lines;
	}

	/** ストリーム終端で残っている未完行を返す */
	flush(): string | null {
		const rest = this.buffer.endsWith("\r")
			? this.buffer.slice(0, -1)
			: this.buffer;
		this.buffer = "";
		return rest.length > 0 ? rest : null;
	}
}
