import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AgentConfigSchema,
	collectPassthroughEnv,
	loadAgentConfig,
	resolveAgentConfig,
} from "../../src/config/agent-config.js";

describe("AgentConfigSchema", () => {
	it("accepts a fully populated config", () => {
		const result = AgentConfigSchema.safeParse({
			pi: {
				provider: "google-vertex",
				model: "gemini-3.5-flash",
				turnTimeoutMs: 600000,
				envPassthrough: ["GH_TOKEN"],
			},
		});
		expect(result.success).toBe(true);
	});

	it("accepts an empty object (all fields omitted)", () => {
		expect(AgentConfigSchema.safeParse({}).success).toBe(true);
	});

	it("rejects unknown top-level keys", () => {
		expect(AgentConfigSchema.safeParse({ unknown: true }).success).toBe(false);
	});

	it("rejects unknown keys under pi", () => {
		expect(AgentConfigSchema.safeParse({ pi: { unknown: true } }).success).toBe(
			false,
		);
	});

	it("rejects a negative turnTimeoutMs", () => {
		expect(
			AgentConfigSchema.safeParse({ pi: { turnTimeoutMs: -1 } }).success,
		).toBe(false);
	});

	it("rejects a non-integer turnTimeoutMs", () => {
		expect(
			AgentConfigSchema.safeParse({ pi: { turnTimeoutMs: 1.5 } }).success,
		).toBe(false);
	});

	it("accepts a classifier block with a model", () => {
		expect(
			AgentConfigSchema.safeParse({ classifier: { model: "gemini-x" } })
				.success,
		).toBe(true);
	});

	it("rejects unknown keys under classifier", () => {
		expect(
			AgentConfigSchema.safeParse({ classifier: { unknown: true } }).success,
		).toBe(false);
	});
});

describe("loadAgentConfig", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "agent-config-test-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("returns {} when agent.yaml does not exist", async () => {
		expect(await loadAgentConfig(dir)).toEqual({});
	});

	it("returns {} when agent.yaml contains only comments", async () => {
		await writeFile(join(dir, "agent.yaml"), "# just a comment\n");
		expect(await loadAgentConfig(dir)).toEqual({});
	});

	it("parses a valid agent.yaml", async () => {
		await writeFile(
			join(dir, "agent.yaml"),
			"pi:\n  provider: google-vertex\n  model: gemini-3.5-flash\n",
		);
		expect(await loadAgentConfig(dir)).toEqual({
			pi: { provider: "google-vertex", model: "gemini-3.5-flash" },
		});
	});

	it("throws with the file path for malformed YAML", async () => {
		await writeFile(join(dir, "agent.yaml"), "pi:\n  - broken: [\n");
		await expect(loadAgentConfig(dir)).rejects.toThrow(/agent\.yaml/);
	});

	it("throws with the file path and zod issue for schema violations", async () => {
		await writeFile(join(dir, "agent.yaml"), "pi:\n  unknownKey: 1\n");
		await expect(loadAgentConfig(dir)).rejects.toThrow(/agent\.yaml/);
	});
});

describe("resolveAgentConfig", () => {
	it("prefers env over file for provider/model", () => {
		const resolved = resolveAgentConfig(
			{ pi: { provider: "file-provider", model: "file-model" } },
			{ PI_PROVIDER: "env-provider", PI_MODEL: "env-model" },
		);
		expect(resolved.provider).toBe("env-provider");
		expect(resolved.model).toBe("env-model");
	});

	it("falls back to file values when env is unset", () => {
		const resolved = resolveAgentConfig(
			{ pi: { provider: "file-provider", model: "file-model" } },
			{},
		);
		expect(resolved.provider).toBe("file-provider");
		expect(resolved.model).toBe("file-model");
	});

	it("leaves provider/model/turnTimeoutMs undefined when neither env nor file set them", () => {
		const resolved = resolveAgentConfig({}, {});
		expect(resolved.provider).toBeUndefined();
		expect(resolved.model).toBeUndefined();
		expect(resolved.turnTimeoutMs).toBeUndefined();
		expect(resolved.envPassthrough).toEqual([]);
	});

	it("parses TURN_TIMEOUT_MS from env and prefers it over file", () => {
		const resolved = resolveAgentConfig(
			{ pi: { turnTimeoutMs: 1000 } },
			{ TURN_TIMEOUT_MS: "5000" },
		);
		expect(resolved.turnTimeoutMs).toBe(5000);
	});

	it("throws for an invalid TURN_TIMEOUT_MS", () => {
		expect(() => resolveAgentConfig({}, { TURN_TIMEOUT_MS: "-1" })).toThrow(
			/TURN_TIMEOUT_MS/,
		);
		expect(() =>
			resolveAgentConfig({}, { TURN_TIMEOUT_MS: "not-a-number" }),
		).toThrow(/TURN_TIMEOUT_MS/);
	});

	it("replaces the file envPassthrough list wholesale with PI_ENV_PASSTHROUGH", () => {
		const resolved = resolveAgentConfig(
			{ pi: { envPassthrough: ["FILE_TOKEN"] } },
			{ PI_ENV_PASSTHROUGH: "ENV_TOKEN_A, ENV_TOKEN_B" },
		);
		expect(resolved.envPassthrough).toEqual(["ENV_TOKEN_A", "ENV_TOKEN_B"]);
	});

	it("trims and drops empty elements in PI_ENV_PASSTHROUGH", () => {
		const resolved = resolveAgentConfig(
			{},
			{ PI_ENV_PASSTHROUGH: " A , ,B ,," },
		);
		expect(resolved.envPassthrough).toEqual(["A", "B"]);
	});

	it("uses the file envPassthrough when PI_ENV_PASSTHROUGH is unset", () => {
		const resolved = resolveAgentConfig(
			{ pi: { envPassthrough: ["GH_TOKEN"] } },
			{},
		);
		expect(resolved.envPassthrough).toEqual(["GH_TOKEN"]);
	});

	it("throws when a SLACK_-prefixed name is listed via agent.yaml", () => {
		expect(() =>
			resolveAgentConfig({ pi: { envPassthrough: ["SLACK_BOT_TOKEN"] } }, {}),
		).toThrow(/SLACK_BOT_TOKEN/);
	});

	it("throws when a BRIDGE_-prefixed name is listed via env", () => {
		expect(() =>
			resolveAgentConfig({}, { PI_ENV_PASSTHROUGH: "BRIDGE_SECRET,GH_TOKEN" }),
		).toThrow(/BRIDGE_SECRET/);
	});

	it("resolves classifier.model from the file (no env path)", () => {
		const resolved = resolveAgentConfig(
			{ classifier: { model: "gemini-x" } },
			{ CLASSIFIER_MODEL: "env-ignored" },
		);
		expect(resolved.classifierModel).toBe("gemini-x");
	});

	it("leaves classifierModel undefined when the classifier block is absent", () => {
		const resolved = resolveAgentConfig({}, {});
		expect(resolved.classifierModel).toBeUndefined();
	});
});

describe("collectPassthroughEnv", () => {
	it("resolves listed names to their values", () => {
		const result = collectPassthroughEnv(["GH_TOKEN", "FOO_API_KEY"], {
			GH_TOKEN: "gh-secret",
			FOO_API_KEY: "foo-secret",
		});
		expect(result.env).toEqual({
			GH_TOKEN: "gh-secret",
			FOO_API_KEY: "foo-secret",
		});
		expect(result.missing).toEqual([]);
	});

	it("reports missing names without including them in env", () => {
		const result = collectPassthroughEnv(["GH_TOKEN", "MISSING_KEY"], {
			GH_TOKEN: "gh-secret",
		});
		expect(result.env).toEqual({ GH_TOKEN: "gh-secret" });
		expect(result.missing).toEqual(["MISSING_KEY"]);
	});

	it("returns empty results for an empty name list", () => {
		const result = collectPassthroughEnv([], { GH_TOKEN: "gh-secret" });
		expect(result.env).toEqual({});
		expect(result.missing).toEqual([]);
	});
});
