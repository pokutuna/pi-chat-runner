import { describe, expect, it } from "vitest";
import { buildPiArgs, buildPiEnv } from "../../src/session/runtime.js";

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
