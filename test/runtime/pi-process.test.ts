import { spawn } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { PiProcess } from "../../src/runtime/pi-process.js";

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  return { ...actual, spawn: vi.fn<typeof actual.spawn>(actual.spawn) };
});

describe("PiProcess spawn options (UID 分離, runtime.md §5.1)", () => {
  it("does not pass uid/gid keys to spawn when unset (現状動作を維持)", () => {
    const proc = new PiProcess({
      sessionPath: "/s.jsonl",
      extensionPaths: ["/e.ts"],
      piBinary: process.execPath,
    });
    proc.start();
    const options = vi.mocked(spawn).mock.calls.at(-1)?.[2] as
      | Record<string, unknown>
      | undefined;
    expect(options).toBeDefined();
    // キー自体が無いことを確認する (uid: undefined を明示的に渡すと Node の
    // spawn は継承ではない扱いになる実装差があるため、キーの有無を検証する)
    expect(options && "uid" in options).toBe(false);
    expect(options && "gid" in options).toBe(false);
    proc.kill();
  });

  it("passes uid/gid through to spawn when both are specified", () => {
    // process.getuid/getgid は POSIX 以外 (Windows) で undefined を返しうるため、
    // このテスト自体を skip して型を number に確定させる
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid === undefined || gid === undefined) return;

    const proc = new PiProcess({
      sessionPath: "/s.jsonl",
      extensionPaths: ["/e.ts"],
      piBinary: process.execPath,
      uid,
      gid,
    });
    proc.start();
    const options = vi.mocked(spawn).mock.calls.at(-1)?.[2] as
      | Record<string, unknown>
      | undefined;
    expect(options?.uid).toBe(uid);
    expect(options?.gid).toBe(gid);
    proc.kill();
  });
});
