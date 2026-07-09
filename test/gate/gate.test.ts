import { describe, expect, it } from "vitest";

import type { ClassifierClient } from "../../src/classifier/client.js";
import {
  buildWhen,
  createGate,
  defaultWhen,
  type EvaluableNode,
  evaluateWhen,
  type Gate,
  type GateContext,
} from "../../src/gate/gate.js";
import { ClassifierGate } from "../../src/gate/gates/classifier.js";
import { KeywordGate } from "../../src/gate/gates/keyword.js";
import { MentionGate } from "../../src/gate/gates/mention.js";
import { PassthroughGate } from "../../src/gate/gates/passthrough.js";
import { ReactionGate } from "../../src/gate/gates/reaction.js";
import type { InboundMessage } from "../../src/ingress/chat-event.js";

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

function ctxFor(event: InboundMessage): GateContext {
  return { event, recent: [] };
}

describe("createGate (registry)", () => {
  it("creates a MentionGate for kind=mention", () => {
    const gate = createGate({ kind: "mention" });
    expect(gate).toBeInstanceOf(MentionGate);
  });

  it("creates a KeywordGate for kind=keyword with pattern", () => {
    const gate = createGate({ kind: "keyword", pattern: "foo" });
    expect(gate).toBeInstanceOf(KeywordGate);
  });

  it("creates a PassthroughGate for kind=passthrough", () => {
    const gate = createGate({ kind: "passthrough" });
    expect(gate).toBeInstanceOf(PassthroughGate);
  });

  it("creates a ClassifierGate for kind=classifier when a client is injected", () => {
    const client: ClassifierClient = {
      classify: async () => ({ result: true, reason: "ok" }),
    };
    const gate = createGate(
      { kind: "classifier", criteria: "trigger on tasks" },
      { classifierClient: client },
    );
    expect(gate).toBeInstanceOf(ClassifierGate);
  });

  it("throws for kind=classifier without an injected client", () => {
    expect(() => createGate({ kind: "classifier", criteria: "c" })).toThrow(
      /requires a classifierClient/,
    );
  });

  it("creates a ReactionGate for kind=reaction with emoji", () => {
    const gate = createGate({ kind: "reaction", emoji: ["eyes"] });
    expect(gate).toBeInstanceOf(ReactionGate);
  });

  it("throws for unknown kind", () => {
    expect(() =>
      // @ts-expect-error intentionally invalid kind for the error-path test
      createGate({ kind: "cooldown" }),
    ).toThrow(/unknown gate kind/);
  });
});

describe("defaultWhen", () => {
  it("returns mention-only when node for non-DM", () => {
    expect(defaultWhen(false)).toEqual([{ kind: "mention" }]);
  });

  it("returns passthrough when node for DM", () => {
    expect(defaultWhen(true)).toEqual([{ kind: "passthrough" }]);
  });
});

describe("evaluateWhen", () => {
  const triggering: Gate = {
    name: "always-true",
    decide: () => ({ trigger: true, reason: "t" }),
  };
  const nonTriggering: Gate = {
    name: "always-false",
    decide: () => ({ trigger: false, reason: "f" }),
  };
  const ctx = ctxFor(makeMessage());

  it("OR (top-level array): triggers if at least one gate triggers", async () => {
    const result = await evaluateWhen(
      [{ gate: nonTriggering }, { gate: triggering }],
      ctx,
    );
    expect(result.trigger).toBe(true);
    expect(result.reason).toContain("always-true");
  });

  it("OR (top-level array): does not trigger if no gate triggers", async () => {
    const result = await evaluateWhen(
      [{ gate: nonTriggering }, { gate: nonTriggering }],
      ctx,
    );
    expect(result.trigger).toBe(false);
  });

  it("AND: triggers only if every gate triggers", async () => {
    const result = await evaluateWhen(
      [{ and: [{ gate: triggering }, { gate: triggering }] }],
      ctx,
    );
    expect(result.trigger).toBe(true);
  });

  it("AND: does not trigger if any gate fails", async () => {
    const result = await evaluateWhen(
      [{ and: [{ gate: triggering }, { gate: nonTriggering }] }],
      ctx,
    );
    expect(result.trigger).toBe(false);
    expect(result.reason).toContain("always-false");
  });

  it("nested: AND containing an OR triggers when the OR branch resolves true", async () => {
    const node: EvaluableNode = {
      and: [
        { gate: triggering },
        { or: [{ gate: nonTriggering }, { gate: triggering }] },
      ],
    };
    const result = await evaluateWhen([node], ctx);
    expect(result.trigger).toBe(true);
  });

  it("short-circuits OR evaluation once a gate triggers", async () => {
    let calledSecond = false;
    const second: Gate = {
      name: "second",
      decide: () => {
        calledSecond = true;
        return { trigger: true, reason: "t" };
      },
    };
    await evaluateWhen([{ gate: triggering }, { gate: second }], ctx);
    expect(calledSecond).toBe(false);
  });

  it("short-circuits AND evaluation once a gate fails", async () => {
    let calledSecond = false;
    const second: Gate = {
      name: "second",
      decide: () => {
        calledSecond = true;
        return { trigger: true, reason: "t" };
      },
    };
    await evaluateWhen(
      [{ and: [{ gate: nonTriggering }, { gate: second }] }],
      ctx,
    );
    expect(calledSecond).toBe(false);
  });

  it("empty array (top-level OR) does not trigger", async () => {
    const result = await evaluateWhen([], ctx);
    expect(result.trigger).toBe(false);
  });
});

describe("buildWhen", () => {
  it("builds a Gate tree from WhenNode[] whose leaves createGate can construct", async () => {
    const nodes = buildWhen([{ kind: "keyword", pattern: "[Hh]elp" }]);
    const result = await evaluateWhen(
      nodes,
      ctxFor(makeMessage({ text: "help me" })),
    );
    expect(result.trigger).toBe(true);
  });
});
