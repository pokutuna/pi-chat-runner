import { describe, expect, it } from "vitest";
import {
	extractReply,
	extractTurnErrors,
	isAgentEnd,
	isToolExecutionEnd,
	JsonlDecoder,
	parsePiOutputLine,
	type ToolExecutionEndEvent,
} from "../../src/session/rpc.js";

describe("JsonlDecoder", () => {
	it("splits complete lines on LF", () => {
		const decoder = new JsonlDecoder();
		expect(decoder.push('{"a":1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
	});

	it("buffers partial lines across chunks", () => {
		const decoder = new JsonlDecoder();
		expect(decoder.push('{"type":"agent')).toEqual([]);
		expect(decoder.push('_end"}\n{"x":')).toEqual(['{"type":"agent_end"}']);
		expect(decoder.push("1}\n")).toEqual(['{"x":1}']);
	});

	it("strips trailing CR (CRLF input)", () => {
		const decoder = new JsonlDecoder();
		expect(decoder.push('{"a":1}\r\n')).toEqual(['{"a":1}']);
	});

	it("does not split on U+2028/U+2029 inside JSON strings", () => {
		// Node readline はこれらを改行扱いするため使えない (docs/rpc.md の Framing)
		const line = `{"text":"a\u2028b\u2029c"}`;
		const decoder = new JsonlDecoder();
		expect(decoder.push(`${line}\n`)).toEqual([line]);
		expect(JSON.parse(line).text).toBe("a\u2028b\u2029c");
	});

	it("skips empty lines", () => {
		const decoder = new JsonlDecoder();
		expect(decoder.push('\n\n{"a":1}\n\n')).toEqual(['{"a":1}']);
	});

	it("flush returns the trailing incomplete line", () => {
		const decoder = new JsonlDecoder();
		decoder.push('{"a":1}\n{"partial"');
		expect(decoder.flush()).toBe('{"partial"');
		expect(decoder.flush()).toBeNull();
	});
});

describe("parsePiOutputLine", () => {
	it("classifies type=response lines as responses", () => {
		const parsed = parsePiOutputLine(
			'{"type":"response","command":"prompt","success":true,"id":"req-1"}',
		);
		expect(parsed).toEqual({
			kind: "response",
			response: {
				type: "response",
				command: "prompt",
				success: true,
				id: "req-1",
			},
		});
	});

	it("classifies any other typed object as an event", () => {
		const parsed = parsePiOutputLine('{"type":"agent_start"}');
		expect(parsed.kind).toBe("event");
		if (parsed.kind === "event") expect(parsed.event.type).toBe("agent_start");
	});

	it("identifies tool_execution_end and agent_end", () => {
		const end = parsePiOutputLine(
			'{"type":"tool_execution_end","toolCallId":"c1","toolName":"reply","result":{"content":[]},"isError":false}',
		);
		expect(end.kind === "event" && isToolExecutionEnd(end.event)).toBe(true);

		const agentEnd = parsePiOutputLine('{"type":"agent_end","messages":[]}');
		expect(agentEnd.kind === "event" && isAgentEnd(agentEnd.event)).toBe(true);
	});

	it("reports invalid JSON lines", () => {
		expect(parsePiOutputLine("not json").kind).toBe("invalid");
		expect(parsePiOutputLine('"just a string"').kind).toBe("invalid");
		expect(parsePiOutputLine('{"no_type":1}').kind).toBe("invalid");
	});
});

describe("extractReply", () => {
	const base: ToolExecutionEndEvent = {
		type: "tool_execution_end",
		toolCallId: "call_1",
		toolName: "reply",
		result: {
			content: [
				{ type: "text", text: "Reply queued for delivery to thread t1." },
			],
			details: { thread_key: "t1", text: "hello" },
		},
		isError: false,
	};

	it("extracts thread_key and text from a reply tool result", () => {
		expect(extractReply(base)).toEqual({ thread_key: "t1", text: "hello" });
	});

	it("returns null for other tools", () => {
		expect(extractReply({ ...base, toolName: "bash" })).toBeNull();
	});

	it("returns null for errored executions", () => {
		expect(extractReply({ ...base, isError: true })).toBeNull();
	});

	it("returns null when details are malformed", () => {
		expect(extractReply({ ...base, result: { content: [] } })).toBeNull();
		expect(
			extractReply({
				...base,
				result: { content: [], details: { thread_key: 1 } },
			}),
		).toBeNull();
	});
});

describe("extractTurnErrors", () => {
	it("collects errorMessage from assistant messages with stopReason error", () => {
		const errors = extractTurnErrors({
			type: "agent_end",
			messages: [
				{ role: "user", content: [] },
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "Could not load the default credentials",
				},
			],
		});
		expect(errors).toEqual(["Could not load the default credentials"]);
	});

	it("returns empty for a normally finished turn", () => {
		const errors = extractTurnErrors({
			type: "agent_end",
			messages: [
				{ role: "user", content: [] },
				{ role: "assistant", stopReason: "stop", content: [] },
			],
		});
		expect(errors).toEqual([]);
	});

	it("falls back to a placeholder when errorMessage is missing", () => {
		const errors = extractTurnErrors({
			type: "agent_end",
			messages: [{ role: "assistant", stopReason: "error" }],
		});
		expect(errors).toEqual(["unknown error"]);
	});
});
