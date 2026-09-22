import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { resolveReplyFiles } from "../../src/runtime/reply-files.js";

/** workdirReal は realpath 済みの前提 (macOS の /tmp symlink 対策。runtime.md §2.2)。 */
let workdir: string;
/** workdir の外に置くファイル (エスケープ経路の参照先) */
let outsideFile: string;

beforeEach(async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "pi-chat-runner-reply-files-")),
  );
  workdir = join(root, "workdir");
  await mkdir(workdir);
  outsideFile = join(root, "secret.txt");
  await writeFile(outsideFile, "secret");
});

describe("resolveReplyFiles (runtime.md §5.4)", () => {
  it("returns undefined when files is unset", async () => {
    expect(await resolveReplyFiles(workdir, undefined)).toBeUndefined();
  });

  it("accepts a regular file inside the workdir and returns its absolute path", async () => {
    await writeFile(join(workdir, "report.md"), "hi");
    expect(await resolveReplyFiles(workdir, ["report.md"])).toEqual([
      join(workdir, "report.md"),
    ]);
  });

  it("accepts a file in a subdirectory of the workdir", async () => {
    await mkdir(join(workdir, "out"));
    await writeFile(join(workdir, "out", "a.txt"), "a");
    expect(await resolveReplyFiles(workdir, ["out/a.txt"])).toEqual([
      join(workdir, "out", "a.txt"),
    ]);
  });

  it("rejects a ../ escape", async () => {
    const rejects: string[] = [];
    expect(
      await resolveReplyFiles(workdir, ["../secret.txt"], (path) =>
        rejects.push(path),
      ),
    ).toBeUndefined();
    expect(rejects).toEqual(["../secret.txt"]);
  });

  it("rejects an absolute path outside the workdir", async () => {
    const rejects: string[] = [];
    expect(
      await resolveReplyFiles(workdir, [outsideFile], (path) =>
        rejects.push(path),
      ),
    ).toBeUndefined();
    expect(rejects).toEqual([outsideFile]);
  });

  it("rejects a missing file", async () => {
    const reasons: string[] = [];
    expect(
      await resolveReplyFiles(workdir, ["nope.txt"], (_path, reason) =>
        reasons.push(reason),
      ),
    ).toBeUndefined();
    expect(reasons).toEqual(["reply file does not exist; dropped"]);
  });

  it("rejects a directory", async () => {
    await mkdir(join(workdir, "dir"));
    const reasons: string[] = [];
    expect(
      await resolveReplyFiles(workdir, ["dir"], (_path, reason) =>
        reasons.push(reason),
      ),
    ).toBeUndefined();
    expect(reasons).toEqual([
      "reply file is a symlink or not a regular file; dropped",
    ]);
  });

  it("rejects a symlink pointing outside the workdir (lstat で symlink を拒否)", async () => {
    await symlink(outsideFile, join(workdir, "leak.txt"));
    const reasons: string[] = [];
    expect(
      await resolveReplyFiles(workdir, ["leak.txt"], (_path, reason) =>
        reasons.push(reason),
      ),
    ).toBeUndefined();
    expect(reasons).toEqual([
      "reply file is a symlink or not a regular file; dropped",
    ]);
  });

  it("rejects a symlink even when its target is inside the workdir (symlink は一律拒否)", async () => {
    await writeFile(join(workdir, "real.txt"), "x");
    await symlink(join(workdir, "real.txt"), join(workdir, "link.txt"));
    const reasons: string[] = [];
    expect(
      await resolveReplyFiles(workdir, ["link.txt"], (_path, reason) =>
        reasons.push(reason),
      ),
    ).toBeUndefined();
    expect(reasons).toEqual([
      "reply file is a symlink or not a regular file; dropped",
    ]);
  });

  it("keeps the accepted files and drops only the rejected ones", async () => {
    await writeFile(join(workdir, "ok.txt"), "ok");
    const rejects: string[] = [];
    expect(
      await resolveReplyFiles(
        workdir,
        ["ok.txt", "../secret.txt", "missing.txt"],
        (path) => rejects.push(path),
      ),
    ).toEqual([join(workdir, "ok.txt")]);
    expect(rejects).toEqual(["../secret.txt", "missing.txt"]);
  });

  it("returns undefined when every entry is rejected", async () => {
    expect(
      await resolveReplyFiles(workdir, ["../a", "/etc/passwd"]),
    ).toBeUndefined();
  });
});
