import { describe, expect, it } from "vitest";
import {
	ChannelDocFileSchema,
	ChannelDocSchema,
} from "../../src/config/channel-doc.js";

describe("ChannelDocSchema", () => {
	it("accepts a minimal empty doc", () => {
		const result = ChannelDocSchema.safeParse({});
		expect(result.success).toBe(true);
	});

	it("accepts a full doc with mention/keyword/classifier gates", () => {
		const result = ChannelDocSchema.safeParse({
			systemPrompt: "be nice",
			context: ["note1", "note2"],
			trigger: {
				combinator: "all",
				debounceSec: 30,
				cooldownSec: 60,
				gates: [
					{ kind: "mention" },
					{ kind: "keyword", pattern: "(ALERT|ERROR)" },
					{ kind: "classifier", criteria: "infra alert" },
					{ kind: "passthrough" },
					{ kind: "cooldown" },
				],
			},
			model: "gemini-3-pro",
		});
		expect(result.success).toBe(true);
	});

	it("rejects unknown top-level keys (strict)", () => {
		const result = ChannelDocSchema.safeParse({
			systemPrompt: "hi",
			piSettings: { foo: "bar" },
		});
		expect(result.success).toBe(false);
	});

	it("rejects unknown keys inside trigger (strict)", () => {
		const result = ChannelDocSchema.safeParse({
			trigger: {
				combinator: "any",
				gates: [{ kind: "mention" }],
				unknownField: true,
			},
		});
		expect(result.success).toBe(false);
	});

	it("rejects unknown keys inside a gate (strict)", () => {
		const result = ChannelDocSchema.safeParse({
			trigger: {
				combinator: "any",
				gates: [{ kind: "mention", extra: "nope" }],
			},
		});
		expect(result.success).toBe(false);
	});

	it("rejects keyword gate without pattern", () => {
		const result = ChannelDocSchema.safeParse({
			trigger: {
				combinator: "any",
				gates: [{ kind: "keyword" }],
			},
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(
				result.error.issues.some((issue) =>
					issue.path.join(".").includes("pattern"),
				),
			).toBe(true);
		}
	});

	it("rejects classifier gate without criteria", () => {
		const result = ChannelDocSchema.safeParse({
			trigger: {
				combinator: "any",
				gates: [{ kind: "classifier" }],
			},
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(
				result.error.issues.some((issue) =>
					issue.path.join(".").includes("criteria"),
				),
			).toBe(true);
		}
	});

	it("accepts a classifier gate with a per-gate model override", () => {
		const result = ChannelDocSchema.safeParse({
			trigger: {
				combinator: "any",
				gates: [
					{ kind: "classifier", criteria: "infra alert", model: "gemini-x" },
				],
			},
		});
		expect(result.success).toBe(true);
		if (result.success) {
			const gate = result.data.trigger?.gates[0];
			expect(gate).toMatchObject({ kind: "classifier", model: "gemini-x" });
		}
	});

	it("accepts mention/passthrough/cooldown gates without extra params", () => {
		const result = ChannelDocSchema.safeParse({
			trigger: {
				combinator: "any",
				gates: [
					{ kind: "mention" },
					{ kind: "passthrough" },
					{ kind: "cooldown" },
				],
			},
		});
		expect(result.success).toBe(true);
	});

	it("rejects invalid combinator value", () => {
		const result = ChannelDocSchema.safeParse({
			trigger: {
				combinator: "xor",
				gates: [{ kind: "mention" }],
			},
		});
		expect(result.success).toBe(false);
	});

	it("accepts session/reply fields", () => {
		const result = ChannelDocSchema.safeParse({
			session: { mode: "channel", idleResetMinutes: 30, maxTranscriptKb: 512 },
			reply: { mode: "flat" },
		});
		expect(result.success).toBe(true);
	});

	it("rejects invalid session.mode value", () => {
		const result = ChannelDocSchema.safeParse({
			session: { mode: "invalid" },
		});
		expect(result.success).toBe(false);
	});

	it("rejects invalid reply.mode value", () => {
		const result = ChannelDocSchema.safeParse({
			reply: { mode: "invalid" },
		});
		expect(result.success).toBe(false);
	});

	it("rejects unknown keys inside session (strict)", () => {
		const result = ChannelDocSchema.safeParse({
			session: { mode: "thread", unknownField: true },
		});
		expect(result.success).toBe(false);
	});
});

describe("ChannelDocFileSchema", () => {
	it("requires the channel field", () => {
		const result = ChannelDocFileSchema.safeParse({});
		expect(result.success).toBe(false);
	});

	it("accepts a doc with channel plus ChannelDoc fields", () => {
		const result = ChannelDocFileSchema.safeParse({
			channel: "#ask-ai",
			systemPrompt: "./prompts/ask-ai.md",
		});
		expect(result.success).toBe(true);
	});

	it("still rejects unknown keys (strict) alongside channel", () => {
		const result = ChannelDocFileSchema.safeParse({
			channel: "C123",
			unknown: "nope",
		});
		expect(result.success).toBe(false);
	});
});
