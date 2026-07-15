import { describe, expect, it, vi } from "vitest";

import type {
  ClassificationResult,
  ClassifierClient,
} from "../../../src/classifier/client.js";
import { ClassifierGate } from "../../../src/gate/gates/classifier.js";
import type { InboundMessage } from "../../../src/ingress/chat-event.js";
import type { Logger } from "../../../src/logger.js";

function makeMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    kind: "message",
    id: "m1",
    conversation: { channelId: "C1" },
    sender: { id: "U1", isBot: false },
    text: "hello",
    mentionsBot: false,
    attachments: [],
    timestamp: new Date("2026-07-05T00:00:00Z"),
    metadata: {},
    ...overrides,
  };
}

/** classify の呼び出しを記録し、scripted な結果を返す/throw する fake。 */
class FakeClassifierClient implements ClassifierClient {
  calls: { criteria: string; text: string; model?: string }[] = [];
  constructor(
    private readonly behavior:
      | { kind: "result"; value: ClassificationResult }
      | { kind: "throw"; error: Error },
  ) {}
  async classify(input: {
    criteria: string;
    text: string;
    model?: string;
  }): Promise<ClassificationResult> {
    this.calls.push(input);
    if (this.behavior.kind === "throw") throw this.behavior.error;
    return this.behavior.value;
  }
}

describe("ClassifierGate", () => {
  it("triggers when the client returns result=true", async () => {
    const client = new FakeClassifierClient({
      kind: "result",
      value: { result: true, reason: "looks like a task" },
    });
    const gate = new ClassifierGate("trigger on task requests", client);
    const decision = await gate.decide({
      event: makeMessage({ text: "please fix the build" }),
    });
    expect(decision.trigger).toBe(true);
    expect(decision.reason).toContain("classifier:");
    expect(decision.reason).toContain("looks like a task");
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.text).toBe("please fix the build");
    expect(client.calls[0]?.criteria).toBe("trigger on task requests");
  });

  it("does not trigger when the client returns result=false", async () => {
    const client = new FakeClassifierClient({
      kind: "result",
      value: { result: false, reason: "just chatting" },
    });
    const gate = new ClassifierGate("trigger on task requests", client);
    const decision = await gate.decide({
      event: makeMessage({ text: "hey how are you" }),
    });
    expect(decision.trigger).toBe(false);
  });

  it("does not trigger for non-message events and does not call the client", async () => {
    const client = new FakeClassifierClient({
      kind: "result",
      value: { result: true, reason: "n/a" },
    });
    const gate = new ClassifierGate("criteria", client);
    const decision = await gate.decide({
      event: { kind: "system", subtype: "channel_joined" },
    });
    expect(decision.trigger).toBe(false);
    expect(decision.reason).toContain("not a message event");
    expect(client.calls).toHaveLength(0);
  });

  it("fails closed (trigger=false) when the client throws", async () => {
    const client = new FakeClassifierClient({
      kind: "throw",
      error: new Error("vertex unavailable"),
    });
    const gate = new ClassifierGate("criteria", client);
    const decision = await gate.decide({
      event: makeMessage(),
    });
    expect(decision.trigger).toBe(false);
    expect(decision.reason).toContain("fail-closed");
    expect(client.calls).toHaveLength(1);
  });

  it("passes the per-gate model override to the client", async () => {
    const client = new FakeClassifierClient({
      kind: "result",
      value: { result: true, reason: "ok" },
    });
    const gate = new ClassifierGate("criteria", client, {
      model: "gemini-x",
    });
    await gate.decide({ event: makeMessage() });
    expect(client.calls[0]?.model).toBe("gemini-x");
  });

  it("logs the decision via the provided logger", async () => {
    const client = new FakeClassifierClient({
      kind: "result",
      value: { result: true, reason: "matched" },
    });
    const info = vi.fn<(obj: unknown, msg?: string) => void>();
    // Logger のうち decide が使う info/warn だけをスタブする
    const logger = {
      info,
      warn: vi.fn<(obj: unknown, msg?: string) => void>(),
    } as unknown as Logger;
    const gate = new ClassifierGate("criteria", client, { logger });
    await gate.decide({ event: makeMessage() });
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: true, reason: "matched" }),
      "classifier decision",
    );
  });
});
