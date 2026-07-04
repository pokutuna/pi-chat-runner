/**
 * SessionRuntime の spawn 部分 (Step 2)。
 * pi を `--mode rpc` で子プロセス起動し、stdin JSONL でコマンドを送り、
 * stdout JSONL のイベントを購読する。
 * 参照: docs/design/session-runtime.md §1-§2, §4
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	JsonlDecoder,
	type PiEvent,
	parsePiOutputLine,
	type RpcCommand,
	type RpcResponse,
} from "./rpc.js";

export interface PiProcessOptions {
	/** `--session` に渡す transcript JSONL の絶対パス */
	sessionPath: string;
	/** `--extension` に渡す reply extension の絶対パス */
	extensionPath: string;
	/** pi バイナリのパス。省略時は env PI_BIN、それも無ければ "pi" */
	piBinary?: string;
	/** `--provider` (省略時は pi のローカル設定に従う) */
	provider?: string;
	/** `--model` (省略時は pi のローカル設定に従う) */
	model?: string;
	/** `--append-system-prompt` */
	appendSystemPrompt?: string;
	/** 追加の `--skill` パス */
	skillPath?: string;
	/** 子プロセスの cwd (workdir) */
	cwd?: string;
	/** allowlist (PATH, HOME) に追加で渡す env */
	extraEnv?: Record<string, string>;
	/** stderr の各行を受けるロガー。省略時は console.error */
	logger?: (line: string) => void;
}

/** spawn 引数の組み立て (純粋関数、テスト対象) */
export function buildPiArgs(
	options: Pick<
		PiProcessOptions,
		| "sessionPath"
		| "extensionPath"
		| "provider"
		| "model"
		| "appendSystemPrompt"
		| "skillPath"
	>,
): string[] {
	const args = [
		"--mode",
		"rpc",
		"--session",
		options.sessionPath,
		"--extension",
		options.extensionPath,
	];
	if (options.provider) args.push("--provider", options.provider);
	if (options.model) args.push("--model", options.model);
	if (options.appendSystemPrompt)
		args.push("--append-system-prompt", options.appendSystemPrompt);
	if (options.skillPath) args.push("--skill", options.skillPath);
	return args;
}

/**
 * env の allowlist 構築 (純粋関数、テスト対象)。
 * process.env を丸ごと継承せず、PATH / HOME + 明示指定分のみを渡す
 * (docs/design/session-runtime.md §2)。
 */
export function buildPiEnv(
	baseEnv: Record<string, string | undefined>,
	extraEnv?: Record<string, string>,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of ["PATH", "HOME"]) {
		const value = baseEnv[key];
		if (value !== undefined) env[key] = value;
	}
	if (extraEnv) Object.assign(env, extraEnv);
	return env;
}

interface PiProcessEvents {
	/** stdout の JSONL 1 行 (response / event 共通のパース済み表現) */
	event: [event: PiEvent];
	response: [response: RpcResponse];
	/** パースできなかった stdout 行 */
	invalid: [raw: string, error: string];
	stderr: [line: string];
	exit: [code: number | null, signal: NodeJS.Signals | null];
}

/**
 * pi 子プロセス 1 個のラッパ。プロセスは使い捨て
 * (再開はホストが同じ --session パスで再 spawn するだけ)。
 */
export class PiProcess extends EventEmitter<PiProcessEvents> {
	private child: ChildProcessWithoutNullStreams | null = null;
	private readonly options: PiProcessOptions;
	private readonly logger: (line: string) => void;

	constructor(options: PiProcessOptions) {
		super();
		this.options = options;
		this.logger =
			options.logger ?? ((line) => console.error(`[pi:stderr] ${line}`));
	}

	get running(): boolean {
		return (
			this.child !== null && this.child.exitCode === null && !this.child.killed
		);
	}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	start(): void {
		if (this.child) throw new Error("PiProcess already started");
		const binary = this.options.piBinary ?? process.env.PI_BIN ?? "pi";
		const child = spawn(binary, buildPiArgs(this.options), {
			cwd: this.options.cwd,
			env: buildPiEnv(process.env, this.options.extraEnv),
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;

		const stdoutDecoder = new JsonlDecoder();
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			for (const line of stdoutDecoder.push(chunk)) this.handleLine(line);
		});
		child.stdout.on("end", () => {
			const rest = stdoutDecoder.flush();
			if (rest) this.handleLine(rest);
		});

		const stderrDecoder = new JsonlDecoder();
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			for (const line of stderrDecoder.push(chunk)) {
				this.logger(line);
				this.emit("stderr", line);
			}
		});

		child.on("exit", (code, signal) => {
			this.emit("exit", code, signal);
		});
		child.on("error", (err) => {
			this.logger(`spawn error: ${err.message}`);
			this.emit("exit", null, null);
		});
	}

	private handleLine(line: string): void {
		const parsed = parsePiOutputLine(line);
		switch (parsed.kind) {
			case "response":
				this.emit("response", parsed.response);
				break;
			case "event":
				this.emit("event", parsed.event);
				break;
			case "invalid":
				this.emit("invalid", parsed.raw, parsed.error);
				break;
		}
	}

	/** RPC コマンドを stdin に JSONL で書く */
	send(command: RpcCommand): void {
		if (!this.child || !this.running)
			throw new Error("PiProcess is not running");
		this.child.stdin.write(`${JSON.stringify(command)}\n`);
	}

	prompt(message: string, streamingBehavior?: "steer" | "followUp"): void {
		this.send(
			streamingBehavior
				? { type: "prompt", message, streamingBehavior }
				: { type: "prompt", message },
		);
	}

	/** 実行中の割り込み。次のステップ境界 (次の LLM 呼び出し前) で注入される */
	steer(message: string): void {
		this.send({ type: "steer", message });
	}

	/** 現ターン完了後に処理される追い掛けメッセージ */
	followUp(message: string): void {
		this.send({ type: "follow_up", message });
	}

	/** graceful stop: stdin を閉じ、猶予内に終了しなければ SIGTERM → SIGKILL */
	async stop(graceMs = 3000): Promise<void> {
		const child = this.child;
		if (!child || child.exitCode !== null) return;
		const exited = new Promise<void>((resolve) => {
			child.once("exit", () => resolve());
		});
		child.stdin.end();
		if (await withTimeout(exited, graceMs)) return;
		child.kill("SIGTERM");
		if (await withTimeout(exited, graceMs)) return;
		child.kill("SIGKILL");
		await exited;
	}

	/** 即時 kill */
	kill(): void {
		this.child?.kill("SIGKILL");
	}
}

/** promise が timeoutMs 以内に解決したら true */
async function withTimeout(
	promise: Promise<void>,
	timeoutMs: number,
): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise.then(() => true),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
