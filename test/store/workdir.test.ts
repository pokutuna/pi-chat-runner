import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CopySharedStorage,
  CopyWorkdirStorage,
  createSharedStorage,
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
  await writeFile(join(workdir, "session.jsonl"), '{"type":"turn"}\n');
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
    expect(await readFile(join(workdir, "session.jsonl"), "utf8")).toBe(
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
      readFile(join(workdir, "session.jsonl"), "utf8"),
    ).rejects.toThrow(/ENOENT/);
  });

  it("does not restore when the shelf has other files but no session.jsonl", async () => {
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
      readFile(join(workdir, "session.jsonl"), "utf8"),
    ).rejects.toThrow(/ENOENT/);
  });

  it("overwrites the shelf content on a second flush", async () => {
    const storage = new CopyWorkdirStorage(baseDir);
    await writeWorkdirFiles();
    await storage.flush(THREAD_KEY, workdir);

    await writeFile(join(workdir, "session.jsonl"), '{"type":"turn2"}\n');
    await writeFile(join(workdir, "workspace", "note.txt"), "updated");
    await storage.flush(THREAD_KEY, workdir);

    await rm(workdir, { recursive: true, force: true });
    const restored = await storage.restore(THREAD_KEY, workdir);

    expect(restored).toBe(true);
    expect(await readFile(join(workdir, "session.jsonl"), "utf8")).toBe(
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
      "session.jsonl",
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
      readFile(join(workdir, "session.jsonl"), "utf8"),
    ).rejects.toThrow(/ENOENT/);
  });

  it("flush does nothing", async () => {
    const storage = new NoopWorkdirStorage();
    await writeWorkdirFiles();

    await expect(storage.flush(THREAD_KEY, workdir)).resolves.toBeUndefined();
  });
});

/** pino のログ 1 行 (JSON) を配列に集めるテスト用ロガー */
function collectingLogger(): { logger: pino.Logger; lines: () => unknown[] } {
  const chunks: string[] = [];
  const stream = {
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
  };
  const logger = pino({ level: "info" }, stream);
  return {
    logger,
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line)),
  };
}

describe("CopySharedStorage", () => {
  const CHANNEL_ID = "C123ABC";

  it("flushes staging to the shelf and restores it into a fresh staging dir", async () => {
    const storage = new CopySharedStorage(baseDir);
    await mkdir(join(workdir, "memory"), { recursive: true });
    await writeFile(join(workdir, "memory", "MEMORY.md"), "- note");
    await writeFile(join(workdir, "notes.md"), "hello");

    await storage.flush(CHANNEL_ID, workdir);
    await rm(workdir, { recursive: true, force: true });
    await mkdir(workdir, { recursive: true });
    await storage.restore(CHANNEL_ID, workdir);

    expect(await readFile(join(workdir, "memory", "MEMORY.md"), "utf8")).toBe(
      "- note",
    );
    expect(await readFile(join(workdir, "notes.md"), "utf8")).toBe("hello");
  });

  it("restores without a session.jsonl gate (unlike CopyWorkdirStorage)", async () => {
    const storage = new CopySharedStorage(baseDir);
    const shelf = join(baseDir, CHANNEL_ID);
    await mkdir(shelf, { recursive: true });
    await writeFile(join(shelf, "notes.md"), "no transcript here");

    await storage.restore(CHANNEL_ID, workdir);

    expect(await readFile(join(workdir, "notes.md"), "utf8")).toBe(
      "no transcript here",
    );
  });

  it("does nothing when the shelf is empty", async () => {
    const storage = new CopySharedStorage(baseDir);

    await storage.restore(CHANNEL_ID, workdir);

    await expect(readFile(join(workdir, "notes.md"), "utf8")).rejects.toThrow(
      /ENOENT/,
    );
  });

  it("uses the channelId as the shelf directory", async () => {
    const storage = new CopySharedStorage(baseDir);
    await writeFile(join(workdir, "notes.md"), "shelf layout");

    await storage.flush(CHANNEL_ID, workdir);

    expect(await readFile(join(baseDir, CHANNEL_ID, "notes.md"), "utf8")).toBe(
      "shelf layout",
    );
  });

  it("warns when the shelf size exceeds warnBytes after flush", async () => {
    const { logger, lines } = collectingLogger();
    const storage = new CopySharedStorage(baseDir, logger, 10);
    await writeFile(join(workdir, "notes.md"), "this content is over 10 bytes");

    await storage.flush(CHANNEL_ID, workdir);

    const warnLines = lines().filter(
      (line) => (line as { level: number }).level === 40,
    );
    expect(warnLines).toHaveLength(1);
    expect(warnLines[0]).toMatchObject({
      channelId: CHANNEL_ID,
      msg: "shared shelf exceeds size warning threshold",
    });
    expect((warnLines[0] as { bytes: number }).bytes).toBeGreaterThan(10);
  });

  it("does not warn when the shelf size is within warnBytes", async () => {
    const { logger, lines } = collectingLogger();
    const storage = new CopySharedStorage(baseDir, logger, 50 * 1024 * 1024);
    await writeFile(join(workdir, "notes.md"), "small content");

    await storage.flush(CHANNEL_ID, workdir);

    expect(lines()).toHaveLength(0);
  });

  it("flushes without error when no logger is given, even past the warn threshold", async () => {
    const storage = new CopySharedStorage(baseDir, undefined, 1);
    await writeFile(join(workdir, "notes.md"), "content bigger than 1 byte");

    await expect(storage.flush(CHANNEL_ID, workdir)).resolves.toBeUndefined();
  });
});

describe("createSharedStorage", () => {
  it("returns undefined when sharedDir is undefined or empty", () => {
    expect(createSharedStorage(undefined)).toBeUndefined();
    expect(createSharedStorage("")).toBeUndefined();
  });

  it("returns a CopySharedStorage when sharedDir is set", () => {
    expect(createSharedStorage(baseDir)).toBeInstanceOf(CopySharedStorage);
  });

  it("wires logger and warnBytes into the CopySharedStorage it creates", async () => {
    const { logger, lines } = collectingLogger();
    const storage = createSharedStorage(baseDir, logger, 10);

    expect(storage).toBeInstanceOf(CopySharedStorage);
    await writeFile(join(workdir, "notes.md"), "this content is over 10 bytes");
    await storage!.flush("C123ABC", workdir);

    const warnLines = lines().filter(
      (line) => (line as { level: number }).level === 40,
    );
    expect(warnLines).toHaveLength(1);
    expect(warnLines[0]).toMatchObject({ channelId: "C123ABC" });
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
