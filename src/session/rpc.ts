/**
 * pi RPC プロトコル (stdin/stdout JSONL) の型とパース。
 * 参照: pi-coding-agent docs/rpc.md
 */

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
