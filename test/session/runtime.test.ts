import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
	buildPiArgs,
	buildPiEnv,
	PiProcess,
} from "../../src/session/runtime.js";

vi.mock("node:child_process", async () => {
	const actual =
		await vi.importActual<typeof import("node:child_process")>(
			"node:child_process",
		);
	return { ...actual, spawn: vi.fn(actual.spawn) };
});

describe("buildPiArgs", () => {
	it("builds minimal rpc mode args", () => {
		expect(
			buildPiArgs({
				sessionPath: "/tmp/s/transcript.jsonl",
				extensionPath: "/app/extensions/reply.ts",
			}),
		).toEqual([
			"--mode",
			"rpc",
			"--session",
			"/tmp/s/transcript.jsonl",
			"--extension",
			"/app/extensions/reply.ts",
		]);
	});

	it("appends optional provider/model/system-prompt/skill args", () => {
		const args = buildPiArgs({
			sessionPath: "/tmp/s.jsonl",
			extensionPath: "/e/reply.ts",
			provider: "google-vertex",
			model: "gemini-2.5-flash-lite",
			appendSystemPrompt: "thread_key is t1",
			skillPath: "/app/skills",
		});
		expect(args).toContain("--provider");
		expect(args[args.indexOf("--provider") + 1]).toBe("google-vertex");
		expect(args[args.indexOf("--model") + 1]).toBe("gemini-2.5-flash-lite");
		expect(args[args.indexOf("--append-system-prompt") + 1]).toBe(
			"thread_key is t1",
		);
		expect(args[args.indexOf("--skill") + 1]).toBe("/app/skills");
	});

	it("passes the ADC marker as --api-key only for google-vertex", () => {
		const vertex = buildPiArgs({
			sessionPath: "/s.jsonl",
			extensionPath: "/e.ts",
			provider: "google-vertex",
		});
		expect(vertex[vertex.indexOf("--api-key") + 1]).toBe(
			"gcp-vertex-credentials",
		);

		const other = buildPiArgs({
			sessionPath: "/s.jsonl",
			extensionPath: "/e.ts",
			provider: "anthropic",
		});
		expect(other).not.toContain("--api-key");
	});

	it("omits optional args when not specified", () => {
		const args = buildPiArgs({
			sessionPath: "/s.jsonl",
			extensionPath: "/e.ts",
		});
		for (const flag of [
			"--provider",
			"--model",
			"--append-system-prompt",
			"--skill",
		]) {
			expect(args).not.toContain(flag);
		}
	});
});

describe("buildPiEnv", () => {
	it("passes only PATH and HOME from the base env", () => {
		const env = buildPiEnv({
			PATH: "/usr/bin",
			HOME: "/home/runner",
			SLACK_BOT_TOKEN: "xoxb-secret",
			SLACK_SIGNING_SECRET: "sig-secret",
			AWS_SECRET_ACCESS_KEY: "aws-secret",
		});
		expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/runner" });
	});

	it("adds explicitly allowlisted extra env vars", () => {
		const env = buildPiEnv(
			{
				PATH: "/usr/bin",
				HOME: "/home/runner",
				SLACK_BOT_TOKEN: "xoxb-secret",
			},
			{ GOOGLE_CLOUD_PROJECT: "my-project" },
		);
		expect(env).toEqual({
			PATH: "/usr/bin",
			HOME: "/home/runner",
			GOOGLE_CLOUD_PROJECT: "my-project",
		});
	});

	it("skips PATH/HOME when absent instead of injecting undefined", () => {
		expect(buildPiEnv({})).toEqual({});
	});
});

describe("PiProcess spawn options (UID 分離, session-runtime.md §6)", () => {
	it("does not pass uid/gid keys to spawn when unset (現状動作を維持)", () => {
		const proc = new PiProcess({
			sessionPath: "/s.jsonl",
			extensionPath: "/e.ts",
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
			extensionPath: "/e.ts",
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
