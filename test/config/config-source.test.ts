import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FileConfigSource } from "../../src/config/config-source.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "fixtures");

describe("FileConfigSource", () => {
	it("returns the matching channel doc by channel ID and inlines file references", async () => {
		const source = new FileConfigSource(join(FIXTURES_DIR, "config"));
		const doc = await source.channel("C0000000001");

		expect(doc).not.toBeNull();
		expect(doc?.systemPrompt).toBe(
			"You are a friendly assistant for this channel.\n",
		);
		expect(doc?.context).toEqual([
			"Extra context note inlined from a file reference.\n",
			"inline text without file reference",
		]);
		expect(doc?.model).toBe("gemini-3-pro");
		expect(doc?.trigger?.gates).toEqual([{ kind: "mention" }]);
		// channel field must not leak into the runtime ChannelDoc
		expect(doc).not.toHaveProperty("channel");
	});

	it("matches by '#name' form as a plain string", async () => {
		const source = new FileConfigSource(join(FIXTURES_DIR, "config"));
		const doc = await source.channel("#keyword-demo");

		expect(doc).not.toBeNull();
		expect(doc?.trigger?.gates).toEqual([
			{ kind: "keyword", pattern: "(?i)(help|error)" },
			{ kind: "mention" },
		]);
	});

	it("falls back to the 'default' doc when no channel doc matches", async () => {
		const source = new FileConfigSource(join(FIXTURES_DIR, "config-default"));
		const doc = await source.channel("C_NOT_FOUND");
		expect(doc?.systemPrompt).toBe("default fallback prompt");
	});

	it("prefers an exact ID match over the 'default' doc", async () => {
		const source = new FileConfigSource(join(FIXTURES_DIR, "config-default"));
		const doc = await source.channel("C0000000001");
		expect(doc?.systemPrompt).toBe("specific channel prompt");
	});

	it("does not fall back to the 'default' doc for the reserved DM name", async () => {
		// default doc は通常チャンネル向けフォールバック。dm に適用すると DM の既定
		// (passthrough) が default の trigger で上書きされてしまう (config.md §2)
		const source = new FileConfigSource(join(FIXTURES_DIR, "config-default"));
		const doc = await source.channel("dm");
		expect(doc).toBeNull();
	});

	it("returns the 'dm' doc by exact match when present", async () => {
		const source = new FileConfigSource(join(FIXTURES_DIR, "config-dm"));
		const doc = await source.channel("dm");
		expect(doc?.systemPrompt).toBe("dm prompt");
	});

	it("passes tools/excludeTools through from the channel doc", async () => {
		const source = new FileConfigSource(join(FIXTURES_DIR, "config-tools"));
		const doc = await source.channel("C0000000TOOLS");

		expect(doc?.tools).toEqual(["read", "grep"]);
		expect(doc?.excludeTools).toEqual(["write", "edit"]);
	});

	it("passes session/reply through from the channel doc", async () => {
		const source = new FileConfigSource(join(FIXTURES_DIR, "config-tools"));
		const doc = await source.channel("C0000000TOOLS");

		expect(doc?.session).toEqual({ mode: "channel", idleResetMinutes: 30 });
		expect(doc?.reply).toEqual({ mode: "flat" });
	});

	it("returns null when no channel doc matches", async () => {
		const source = new FileConfigSource(join(FIXTURES_DIR, "config"));
		const doc = await source.channel("C_NOT_FOUND");
		expect(doc).toBeNull();
	});

	it("returns null when the channels directory does not exist", async () => {
		const source = new FileConfigSource(join(FIXTURES_DIR, "does-not-exist"));
		const doc = await source.channel("C0000000001");
		expect(doc).toBeNull();
	});

	it("throws with file name and zod issue for schema violations", async () => {
		const source = new FileConfigSource(join(FIXTURES_DIR, "config-invalid"));
		await expect(source.channel("C0000000009")).rejects.toThrow(/broken\.yaml/);
	});

	it("throws for malformed YAML", async () => {
		const source = new FileConfigSource(
			join(FIXTURES_DIR, "config-malformed-yaml"),
		);
		await expect(source.channel("C1")).rejects.toThrow(/bad\.yaml/);
	});

	it("throws when a referenced file is missing", async () => {
		const source = new FileConfigSource(
			join(FIXTURES_DIR, "config-missing-ref"),
		);
		await expect(source.channel("C0000000002")).rejects.toThrow(
			/does-not-exist\.md/,
		);
	});

	it("re-reads from disk on every call (no caching)", async () => {
		const source = new FileConfigSource(join(FIXTURES_DIR, "config"));
		const first = await source.channel("C0000000001");
		const second = await source.channel("C0000000001");
		expect(first).toEqual(second);
		expect(first).not.toBe(second);
	});
});
