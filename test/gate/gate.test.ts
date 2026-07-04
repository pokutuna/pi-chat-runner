import { describe, expect, it } from "vitest";
import {
	createGate,
	defaultGates,
	evaluateTrigger,
	type Gate,
	type GateContext,
} from "../../src/gate/gate.js";
import { KeywordGate } from "../../src/gate/gates/keyword.js";
import { MentionGate } from "../../src/gate/gates/mention.js";
import { PassthroughGate } from "../../src/gate/gates/passthrough.js";
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

	it("throws for unknown kind", () => {
		expect(() =>
			// @ts-expect-error intentionally invalid kind for the error-path test
			createGate({ kind: "classifier" }),
		).toThrow(/unknown gate kind/);
	});
});

describe("defaultGates", () => {
	it("returns mention-only gates", () => {
		const gates = defaultGates();
		expect(gates).toHaveLength(1);
		expect(gates[0]).toBeInstanceOf(MentionGate);
	});
});

describe("evaluateTrigger", () => {
	const triggering: Gate = {
		name: "always-true",
		decide: () => ({ trigger: true, reason: "t" }),
	};
	const nonTriggering: Gate = {
		name: "always-false",
		decide: () => ({ trigger: false, reason: "f" }),
	};
	const ctx = ctxFor(makeMessage());

	it("any: triggers if at least one gate triggers", async () => {
		const result = await evaluateTrigger(
			[nonTriggering, triggering],
			"any",
			ctx,
		);
		expect(result.trigger).toBe(true);
		expect(result.reason).toContain("always-true");
	});

	it("any: does not trigger if no gate triggers", async () => {
		const result = await evaluateTrigger(
			[nonTriggering, nonTriggering],
			"any",
			ctx,
		);
		expect(result.trigger).toBe(false);
	});

	it("all: triggers only if every gate triggers", async () => {
		const result = await evaluateTrigger([triggering, triggering], "all", ctx);
		expect(result.trigger).toBe(true);
	});

	it("all: does not trigger if any gate fails", async () => {
		const result = await evaluateTrigger(
			[triggering, nonTriggering],
			"all",
			ctx,
		);
		expect(result.trigger).toBe(false);
		expect(result.reason).toContain("always-false");
	});

	it("short-circuits any evaluation once a gate triggers", async () => {
		let calledSecond = false;
		const second: Gate = {
			name: "second",
			decide: () => {
				calledSecond = true;
				return { trigger: true, reason: "t" };
			},
		};
		await evaluateTrigger([triggering, second], "any", ctx);
		expect(calledSecond).toBe(false);
	});

	it("short-circuits all evaluation once a gate fails", async () => {
		let calledSecond = false;
		const second: Gate = {
			name: "second",
			decide: () => {
				calledSecond = true;
				return { trigger: true, reason: "t" };
			},
		};
		await evaluateTrigger([nonTriggering, second], "all", ctx);
		expect(calledSecond).toBe(false);
	});
});
