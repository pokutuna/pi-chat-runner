import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CopyWorkdirStorage,
	createWorkdirStorage,
	NoopWorkdirStorage,
} from "../../src/store/workdir.js";

const THREAD_KEY = "C123ABC:1720000000.123456";

let baseDir: string;
let workdir: string;

beforeEach(async () => {
	baseDir = await mkdtemp(join(tmpdir(), "workdir-storage-shelf-"));
	workdir = await mkdtemp(join(tmpdir(), "workdir-storage-workdir-"));
});

afterEach(async () => {
	await rm(baseDir, { recursive: true, force: true });
	await rm(workdir, { recursive: true, force: true });
});

async function writeWorkdirFiles(): Promise<void> {
	await mkdir(join(workdir, "workspace", "nested"), { recursive: true });
	await writeFile(join(workdir, "transcript.jsonl"), '{"type":"turn"}\n');
	await writeFile(join(workdir, "workspace", "note.txt"), "hello");
	await writeFile(
		join(workdir, "workspace", "nested", "deep.txt"),
		"deep content",
	);
}

describe("CopyWorkdirStorage", () => {
	it("flushes workdir to the shelf and restores it into a fresh workdir", async () => {
		const storage = new CopyWorkdirStorage(baseDir);
		await writeWorkdirFiles();

		await storage.flush(THREAD_KEY, workdir);

		// simulate workdir disposal (tmpfs teardown between sessions)
		await rm(workdir, { recursive: true, force: true });

		const restored = await storage.restore(THREAD_KEY, workdir);

		expect(restored).toBe(true);
		expect(await readFile(join(workdir, "transcript.jsonl"), "utf8")).toBe(
			'{"type":"turn"}\n',
		);
		expect(await readFile(join(workdir, "workspace", "note.txt"), "utf8")).toBe(
			"hello",
		);
		expect(
			await readFile(join(workdir, "workspace", "nested", "deep.txt"), "utf8"),
		).toBe("deep content");
	});

	it("returns false and does nothing when the shelf is empty", async () => {
		const storage = new CopyWorkdirStorage(baseDir);

		const restored = await storage.restore(THREAD_KEY, workdir);

		expect(restored).toBe(false);
		await expect(
			readFile(join(workdir, "transcript.jsonl"), "utf8"),
		).rejects.toThrow();
	});

	it("does not restore when the shelf has other files but no transcript.jsonl", async () => {
		const storage = new CopyWorkdirStorage(baseDir);
		const shelf = join(baseDir, "C123ABC", "1720000000.123456");
		await mkdir(join(shelf, "workspace"), { recursive: true });
		await writeFile(
			join(shelf, "workspace", "note.txt"),
			"partial flush trace",
		);

		const restored = await storage.restore(THREAD_KEY, workdir);

		expect(restored).toBe(false);
		await expect(
			readFile(join(workdir, "transcript.jsonl"), "utf8"),
		).rejects.toThrow();
	});

	it("overwrites the shelf content on a second flush", async () => {
		const storage = new CopyWorkdirStorage(baseDir);
		await writeWorkdirFiles();
		await storage.flush(THREAD_KEY, workdir);

		await writeFile(join(workdir, "transcript.jsonl"), '{"type":"turn2"}\n');
		await writeFile(join(workdir, "workspace", "note.txt"), "updated");
		await storage.flush(THREAD_KEY, workdir);

		await rm(workdir, { recursive: true, force: true });
		const restored = await storage.restore(THREAD_KEY, workdir);

		expect(restored).toBe(true);
		expect(await readFile(join(workdir, "transcript.jsonl"), "utf8")).toBe(
			'{"type":"turn2"}\n',
		);
		expect(await readFile(join(workdir, "workspace", "note.txt"), "utf8")).toBe(
			"updated",
		);
	});

	it("maps the ':' in threadKey to a path separator on the shelf", async () => {
		const storage = new CopyWorkdirStorage(baseDir);
		await writeWorkdirFiles();

		await storage.flush(THREAD_KEY, workdir);

		const expectedShelfTranscript = join(
			baseDir,
			"C123ABC",
			"1720000000.123456",
			"transcript.jsonl",
		);
		expect(await readFile(expectedShelfTranscript, "utf8")).toBe(
			'{"type":"turn"}\n',
		);
	});
});

describe("NoopWorkdirStorage", () => {
	it("restore returns false and does not create the workdir", async () => {
		const storage = new NoopWorkdirStorage();

		const restored = await storage.restore(THREAD_KEY, workdir);

		expect(restored).toBe(false);
		await expect(
			readFile(join(workdir, "transcript.jsonl"), "utf8"),
		).rejects.toThrow();
	});

	it("flush does nothing", async () => {
		const storage = new NoopWorkdirStorage();
		await writeWorkdirFiles();

		await expect(storage.flush(THREAD_KEY, workdir)).resolves.toBeUndefined();
	});
});

describe("createWorkdirStorage", () => {
	it("returns a NoopWorkdirStorage when archiveDir is undefined", () => {
		expect(createWorkdirStorage(undefined)).toBeInstanceOf(NoopWorkdirStorage);
	});

	it("returns a NoopWorkdirStorage when archiveDir is an empty string", () => {
		expect(createWorkdirStorage("")).toBeInstanceOf(NoopWorkdirStorage);
	});

	it("returns a CopyWorkdirStorage when archiveDir is set", () => {
		expect(createWorkdirStorage(baseDir)).toBeInstanceOf(CopyWorkdirStorage);
	});
});
