import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	loadStoreConfig,
	StoreConfigSchema,
} from "../../src/config/store-config.js";

describe("StoreConfigSchema", () => {
	it("accepts a fully populated config", () => {
		const result = StoreConfigSchema.safeParse({
			backend: "sqlite",
			sqlitePath: "/data/state.db",
		});
		expect(result.success).toBe(true);
	});

	it("accepts an empty object and fills in defaults", () => {
		const result = StoreConfigSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.backend).toBe("memory");
			expect(result.data.sqlitePath).toBe("/tmp/pi-chat-runner/state.db");
		}
	});

	it("rejects unknown top-level keys", () => {
		expect(StoreConfigSchema.safeParse({ unknown: true }).success).toBe(false);
	});

	it("rejects an invalid backend", () => {
		expect(StoreConfigSchema.safeParse({ backend: "redis" }).success).toBe(
			false,
		);
	});
});

describe("loadStoreConfig", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "store-config-test-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("returns default (memory) when agent.yaml does not exist", async () => {
		expect(await loadStoreConfig(dir)).toEqual({
			backend: "memory",
			sqlitePath: "/tmp/pi-chat-runner/state.db",
		});
	});

	it("returns default (memory) when agent.yaml has no store block", async () => {
		await writeFile(
			join(dir, "agent.yaml"),
			"pi:\n  provider: google-vertex\n",
		);
		expect(await loadStoreConfig(dir)).toEqual({
			backend: "memory",
			sqlitePath: "/tmp/pi-chat-runner/state.db",
		});
	});

	it("returns default (memory) when agent.yaml contains only comments", async () => {
		await writeFile(join(dir, "agent.yaml"), "# just a comment\n");
		expect(await loadStoreConfig(dir)).toEqual({
			backend: "memory",
			sqlitePath: "/tmp/pi-chat-runner/state.db",
		});
	});

	it("parses a valid store block with an explicit sqlite backend and path", async () => {
		await writeFile(
			join(dir, "agent.yaml"),
			["store:", "  backend: sqlite", "  sqlitePath: /data/state.db"].join(
				"\n",
			),
		);
		expect(await loadStoreConfig(dir)).toEqual({
			backend: "sqlite",
			sqlitePath: "/data/state.db",
		});
	});

	it("resolves ${env.X} references against the given env before validating", async () => {
		await writeFile(
			join(dir, "agent.yaml"),
			[
				"store:",
				"  backend: ${env.STORE_BACKEND:-memory}",
				"  sqlitePath: ${env.SQLITE_PATH:-/tmp/pi-chat-runner/state.db}",
			].join("\n"),
		);
		const result = await loadStoreConfig(dir, {
			STORE_BACKEND: "sqlite",
			SQLITE_PATH: "/var/data/state.db",
		});
		expect(result).toEqual({
			backend: "sqlite",
			sqlitePath: "/var/data/state.db",
		});
	});

	it("throws with the file path for malformed YAML", async () => {
		await writeFile(join(dir, "agent.yaml"), "store:\n  - broken: [\n");
		await expect(loadStoreConfig(dir)).rejects.toThrow(/agent\.yaml/);
	});

	it("throws with the file path and zod issue for an invalid backend value", async () => {
		await writeFile(join(dir, "agent.yaml"), "store:\n  backend: redis\n");
		await expect(loadStoreConfig(dir)).rejects.toThrow(/agent\.yaml/);
	});
});
