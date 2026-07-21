import { describe, expect, it } from "vitest";

import {
  extractReply,
  extractTurnErrors,
  extractUsageTotals,
  piEventLogFields,
  turnStatusFromAgentEnd,
} from "../../src/session/pi-events.js";
import type { ToolExecutionEndEvent } from "../../src/session/rpc.js";

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

  it("extracts files when details.files is a string array", () => {
    const event = {
      ...base,
      result: {
        ...base.result,
        details: { thread_key: "t1", text: "hello", files: ["a.txt", "b.png"] },
      },
    };
    expect(extractReply(event)).toEqual({
      thread_key: "t1",
      text: "hello",
      files: ["a.txt", "b.png"],
    });
  });

  it("omits files when details.files is not an array", () => {
    const event = {
      ...base,
      result: {
        ...base.result,
        details: { thread_key: "t1", text: "hello", files: "a.txt" },
      },
    };
    expect(extractReply(event)).toEqual({ thread_key: "t1", text: "hello" });
  });

  it("omits files when an element is not a string", () => {
    const event = {
      ...base,
      result: {
        ...base.result,
        details: { thread_key: "t1", text: "hello", files: ["a.txt", 1] },
      },
    };
    expect(extractReply(event)).toEqual({ thread_key: "t1", text: "hello" });
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

describe("turnStatusFromAgentEnd", () => {
  it("returns ok when the last assistant message stopped normally", () => {
    expect(
      turnStatusFromAgentEnd({
        type: "agent_end",
        messages: [
          { role: "user", content: [] },
          { role: "assistant", stopReason: "stop", content: [] },
        ],
      }),
    ).toBe("ok");
  });

  it("returns error when the last assistant message ended with error", () => {
    expect(
      turnStatusFromAgentEnd({
        type: "agent_end",
        messages: [{ role: "assistant", stopReason: "error" }],
      }),
    ).toBe("error");
  });

  it("treats non-stop stopReasons (e.g. length) as error", () => {
    expect(
      turnStatusFromAgentEnd({
        type: "agent_end",
        messages: [{ role: "assistant", stopReason: "length" }],
      }),
    ).toBe("error");
  });

  it("judges by the last assistant message, ignoring earlier ones", () => {
    expect(
      turnStatusFromAgentEnd({
        type: "agent_end",
        messages: [
          { role: "assistant", stopReason: "error" },
          { role: "user", content: [] },
          { role: "assistant", stopReason: "stop" },
        ],
      }),
    ).toBe("ok");
  });

  it("returns ok for a turn with no assistant message (silent success)", () => {
    expect(
      turnStatusFromAgentEnd({
        type: "agent_end",
        messages: [{ role: "user", content: [] }],
      }),
    ).toBe("ok");
  });
});

describe("extractUsageTotals", () => {
  it("sums usage across multiple assistant messages", () => {
    const totals = extractUsageTotals({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          usage: {
            input: 10,
            output: 20,
            cacheRead: 1,
            cacheWrite: 2,
            totalTokens: 30,
            cost: { total: 0.01 },
          },
        },
        {
          role: "assistant",
          usage: {
            input: 5,
            output: 15,
            cacheRead: 3,
            cacheWrite: 4,
            totalTokens: 20,
            cost: { total: 0.02 },
          },
        },
      ],
    });
    expect(totals).toEqual({
      input: 15,
      output: 35,
      cacheRead: 4,
      cacheWrite: 6,
      totalTokens: 50,
      costTotal: 0.03,
    });
  });

  it("ignores assistant messages without a usage field", () => {
    const totals = extractUsageTotals({
      type: "agent_end",
      messages: [
        { role: "assistant", content: [] },
        {
          role: "assistant",
          usage: {
            input: 1,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 3,
            cost: { total: 0.001 },
          },
        },
      ],
    });
    expect(totals).toEqual({
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      costTotal: 0.001,
    });
  });

  it("ignores non-assistant messages even if they carry usage", () => {
    const totals = extractUsageTotals({
      type: "agent_end",
      messages: [
        {
          role: "user",
          usage: {
            input: 100,
            output: 100,
            cacheRead: 100,
            cacheWrite: 100,
            totalTokens: 100,
            cost: { total: 100 },
          },
        },
      ],
    });
    expect(totals).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      costTotal: 0,
    });
  });

  it("treats a missing usage.cost.total as 0", () => {
    const totals = extractUsageTotals({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
          },
        },
      ],
    });
    expect(totals.costTotal).toBe(0);
  });
});

describe("piEventLogFields", () => {
  it("returns null for streaming delta events", () => {
    expect(piEventLogFields({ type: "message_update" })).toBeNull();
    expect(piEventLogFields({ type: "tool_execution_update" })).toBeNull();
  });

  it("extracts toolName and args preview from tool_execution_start", () => {
    const fields = piEventLogFields({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "bash",
      args: { command: "ls -la" },
    });
    expect(fields).toEqual({
      toolName: "bash",
      toolCallId: "call_1",
      args: '{"command":"ls -la"}',
    });
  });

  it("truncates long args in tool_execution_start", () => {
    const fields = piEventLogFields({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "bash",
      args: { command: "x".repeat(500) },
    });
    expect((fields?.args as string | undefined)?.length).toBeLessThanOrEqual(
      203,
    );
    expect(fields?.args).toMatch(/\.\.\.$/);
  });

  it("extracts result size and error flag from tool_execution_end", () => {
    const event: ToolExecutionEndEvent = {
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "read",
      result: {
        content: [
          { type: "text", text: "hello" },
          { type: "image", data: "..." },
        ],
      },
      isError: false,
    };
    expect(piEventLogFields(event)).toEqual({
      toolName: "read",
      toolCallId: "call_1",
      isError: false,
      resultChars: 5,
    });
  });

  it("extracts role and stopReason from message_end", () => {
    const fields = piEventLogFields({
      type: "message_end",
      message: { role: "assistant", stopReason: "toolUse" },
    });
    expect(fields).toEqual({ role: "assistant", stopReason: "toolUse" });
  });

  it("includes errorMessage from message_end when present", () => {
    const fields = piEventLogFields({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "boom",
      },
    });
    expect(fields).toEqual({
      role: "assistant",
      stopReason: "error",
      errorMessage: "boom",
    });
  });

  it("reports queue lengths for queue_update", () => {
    const fields = piEventLogFields({
      type: "queue_update",
      steering: ["a", "b"],
      followUp: [],
    });
    expect(fields).toEqual({ steering: 2, followUp: 0 });
  });

  it("returns empty fields for other event types", () => {
    expect(piEventLogFields({ type: "agent_start" })).toEqual({});
    expect(piEventLogFields({ type: "turn_end" })).toEqual({});
  });
});
