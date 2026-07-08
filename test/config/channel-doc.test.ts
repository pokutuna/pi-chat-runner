import { describe, expect, it } from "vitest";
import {
	ChannelDocSchema,
	ChannelEntrySchema,
	ChannelsFileSchema,
} from "../../src/config/channel-doc.js";

describe("ChannelDocSchema", () => {
	it("accepts a minimal empty doc", () => {
		const result = ChannelDocSchema.safeParse({});
		expect(result.success).toBe(true);
	});

	it("accepts a full doc with mention/keyword/classifier/passthrough gates", () => {
		const result = ChannelDocSchema.safeParse({
			systemPrompt: "be nice",
			context: ["note1", "note2"],
			trigger: {
				when: [
					{ kind: "mention" },
					{ kind: "keyword", pattern: "(ALERT|ERROR)" },
					{ kind: "classifier", criteria: "infra alert" },
					{ kind: "passthrough" },
				],
				debounceSec: 30,
				cooldownSec: 60,
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
				when: [{ kind: "mention" }],
				unknownField: true,
			},
		});
		expect(result.success).toBe(false);
	});

	it("rejects unknown keys inside a gate (strict)", () => {
		const result = ChannelDocSchema.safeParse({
			trigger: {
				when: [{ kind: "mention", extra: "nope" }],
			},
		});
		expect(result.success).toBe(false);
	});

	it("rejects keyword gate without pattern", () => {
		const result = ChannelDocSchema.safeParse({
			trigger: {
				when: [{ kind: "keyword" }],
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
				when: [{ kind: "classifier" }],
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
				when: [
					{ kind: "classifier", criteria: "infra alert", model: "gemini-x" },
				],
			},
		});
		expect(result.success).toBe(true);
		if (result.success) {
			const gate = result.data.trigger?.when[0];
			expect(gate).toMatchObject({ kind: "classifier", model: "gemini-x" });
		}
	});

	it("accepts a reaction gate with a non-empty emoji list", () => {
		const result = ChannelDocSchema.safeParse({
			trigger: {
				when: [{ kind: "reaction", emoji: ["eyes"] }],
			},
		});
		expect(result.success).toBe(true);
	});

	it("rejects reaction gate without emoji", () => {
		const result = ChannelDocSchema.safeParse({
			trigger: {
				when: [{ kind: "reaction" }],
			},
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(
				result.error.issues.some((issue) =>
					issue.path.join(".").includes("emoji"),
				),
			).toBe(true);
		}
	});

	it("rejects reaction gate with an empty emoji list", () => {
		const result = ChannelDocSchema.safeParse({
			trigger: {
				when: [{ kind: "reaction", emoji: [] }],
			},
		});
		expect(result.success).toBe(false);
	});

	it("accepts mention/passthrough gates without extra params", () => {
		const result = ChannelDocSchema.safeParse({
			trigger: {
				when: [{ kind: "mention" }, { kind: "passthrough" }],
			},
		});
		expect(result.success).toBe(true);
	});

	it("rejects cooldown kind", () => {
		const result = ChannelDocSchema.safeParse({
			trigger: {
				when: [{ kind: "cooldown" }],
			},
		});
		expect(result.success).toBe(false);
	});

	it("accepts an 'and' node combining gates", () => {
		const result = ChannelDocSchema.safeParse({
			trigger: {
				when: [
					{ and: [{ kind: "mention" }, { kind: "keyword", pattern: "x" }] },
				],
			},
		});
		expect(result.success).toBe(true);
	});

	it("accepts an 'or' node combining gates", () => {
		const result = ChannelDocSchema.safeParse({
			trigger: {
				when: [
					{ or: [{ kind: "mention" }, { kind: "keyword", pattern: "x" }] },
				],
			},
		});
		expect(result.success).toBe(true);
	});

	it("rejects an 'and' node with unknown keys (strict)", () => {
		const result = ChannelDocSchema.safeParse({
			trigger: {
				when: [{ and: [], unknownKey: 1 }],
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

describe("ChannelEntrySchema", () => {
	it("requires the channel field", () => {
		const result = ChannelEntrySchema.safeParse({});
		expect(result.success).toBe(false);
	});

	it("accepts a doc with channel plus ChannelDoc fields", () => {
		const result = ChannelEntrySchema.safeParse({
			channel: "#ask-ai",
			systemPrompt: "./prompts/ask-ai.md",
		});
		expect(result.success).toBe(true);
	});

	it("still rejects unknown keys (strict) alongside channel", () => {
		const result = ChannelEntrySchema.safeParse({
			channel: "C123",
			unknown: "nope",
		});
		expect(result.success).toBe(false);
	});
});

describe("ChannelsFileSchema", () => {
	it("accepts a file containing a 'default' entry", () => {
		const result = ChannelsFileSchema.safeParse({
			channels: [{ channel: "default" }, { channel: "C1" }],
		});
		expect(result.success).toBe(true);
	});

	it("rejects an empty channels array", () => {
		const result = ChannelsFileSchema.safeParse({ channels: [] });
		expect(result.success).toBe(false);
	});

	it("rejects a file missing the 'default' entry", () => {
		const result = ChannelsFileSchema.safeParse({
			channels: [{ channel: "C1" }],
		});
		expect(result.success).toBe(false);
	});

	it("rejects unknown top-level keys (strict)", () => {
		const result = ChannelsFileSchema.safeParse({
			channels: [{ channel: "default" }],
			extra: 1,
		});
		expect(result.success).toBe(false);
	});
});
