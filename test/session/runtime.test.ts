import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
	ancestorDirs,
	buildPiArgs,
	buildPiEnv,
	buildPiPermissionOptions,
	buildSpawnCommand,
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
				extensionPaths: ["/app/extensions/reply.ts"],
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

	it("expands --extension once per path in extensionPaths (reply + permission-gate)", () => {
		const args = buildPiArgs({
			sessionPath: "/tmp/s/transcript.jsonl",
			extensionPaths: [
				"/app/extensions/reply.ts",
				"/app/extensions/permission-gate.ts",
			],
		});
		expect(args).toEqual([
			"--mode",
			"rpc",
			"--session",
			"/tmp/s/transcript.jsonl",
			"--extension",
			"/app/extensions/reply.ts",
			"--extension",
			"/app/extensions/permission-gate.ts",
		]);
	});

	it("appends optional provider/model/system-prompt/skill args", () => {
		const args = buildPiArgs({
			sessionPath: "/tmp/s.jsonl",
			extensionPaths: ["/e/reply.ts"],
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
			extensionPaths: ["/e.ts"],
			provider: "google-vertex",
		});
		expect(vertex[vertex.indexOf("--api-key") + 1]).toBe(
			"gcp-vertex-credentials",
		);

		const other = buildPiArgs({
			sessionPath: "/s.jsonl",
			extensionPaths: ["/e.ts"],
			provider: "anthropic",
		});
		expect(other).not.toContain("--api-key");
	});

	it("omits optional args when not specified", () => {
		const args = buildPiArgs({
			sessionPath: "/s.jsonl",
			extensionPaths: ["/e.ts"],
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

describe("buildSpawnCommand (Node Permission Model, session-runtime.md §6)", () => {
	it("spawns piBinary directly when permission is unset (現状動作を維持)", () => {
		expect(buildSpawnCommand(["--mode", "rpc"], { piBinary: "pi" })).toEqual({
			command: "pi",
			args: ["--mode", "rpc"],
		});
	});

	it('falls back to env PI_BIN then "pi" when piBinary is unset', () => {
		expect(buildSpawnCommand(["--mode", "rpc"], {})).toEqual({
			command: process.env.PI_BIN ?? "pi",
			args: ["--mode", "rpc"],
		});
	});

	it("wraps with node --permission when permission is specified", () => {
		const result = buildSpawnCommand(["--mode", "rpc"], {
			piBinary: "pi",
			permission: {
				entrypoint: "/usr/local/lib/node_modules/pi/dist/cli.js",
				allowFsRead: ["/app/*", "/tmp/workdir/*"],
				allowFsWrite: ["/tmp/workdir/*"],
			},
		});
		expect(result.command).toBe(process.execPath);
		expect(result.args).toEqual([
			"--permission",
			"--allow-fs-read=/app/*",
			"--allow-fs-read=/tmp/workdir/*",
			"--allow-fs-write=/tmp/workdir/*",
			"--allow-child-process",
			"/usr/local/lib/node_modules/pi/dist/cli.js",
			"--mode",
			"rpc",
		]);
	});
});

describe("ancestorDirs", () => {
	it("returns the dir itself and every ancestor up to /", () => {
		expect(ancestorDirs("/tmp/pi-chat-runner/sessions/CH1")).toEqual([
			"/tmp/pi-chat-runner/sessions/CH1",
			"/tmp/pi-chat-runner/sessions",
			"/tmp/pi-chat-runner",
			"/tmp",
			"/",
		]);
	});

	it("returns just / for the root dir", () => {
		expect(ancestorDirs("/")).toEqual(["/"]);
	});
});

describe("buildPiPermissionOptions (session-runtime.md §6)", () => {
	it("builds allow-fs-read/write lists scoped to workdir/home/node_modules/app", () => {
		const options = buildPiPermissionOptions({
			entrypoint: "/usr/local/lib/node_modules/pi/dist/cli.js",
			nodeModulesDir: "/usr/local/lib/node_modules",
			appDir: "/app",
			workdir: "/tmp/workdir",
			home: "/home/agent",
		});
		expect(options.entrypoint).toBe(
			"/usr/local/lib/node_modules/pi/dist/cli.js",
		);
		expect(options.allowFsRead).toContain("/usr/local/lib/node_modules/*");
		expect(options.allowFsRead).toContain("/app/*");
		expect(options.allowFsRead).toContain("/tmp/workdir/*");
		expect(options.allowFsRead).toContain("/home/agent/*");
		// プロジェクト trust 判定の probe は workdir の全祖先で走るため、
		// 各中間ディレクトリ × probe ファイル名の直積を含む必要がある
		// (1 つでも欠けると existsSync が ERR_ACCESS_DENIED で pi が即死する)
		expect(options.allowFsRead).toContain("/tmp/workdir/AGENTS.md");
		expect(options.allowFsRead).toContain("/tmp/AGENTS.md");
		expect(options.allowFsRead).toContain("/AGENTS.md");
		expect(options.allowFsRead).toContain("/tmp/.pi/settings.json");
		expect(options.allowFsRead).toContain("/.agents/skills");
		expect(options.allowFsWrite).toEqual(["/tmp/workdir/*", "/home/agent/*"]);
	});

	it("appends extraWrite paths when specified", () => {
		const options = buildPiPermissionOptions({
			entrypoint: "/e.js",
			nodeModulesDir: "/nm",
			appDir: "/app",
			workdir: "/wd",
			home: "/home/agent",
			extraWrite: ["/tmp/*"],
		});
		expect(options.allowFsWrite).toEqual(["/wd/*", "/home/agent/*", "/tmp/*"]);
	});
});
