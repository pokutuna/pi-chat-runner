/**
 * SessionRuntime の spawn 部分 (Step 2)。
 * pi を `--mode rpc` で子プロセス起動し、stdin JSONL でコマンドを送り、
 * stdout JSONL のイベントを購読する。
 * 参照: docs/design/session-runtime.md §1-§2, §4
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	JsonlDecoder,
	type PiEvent,
	parsePiOutputLine,
	type RpcCommand,
	type RpcResponse,
} from "./rpc.js";

/**
 * Node Permission Model 経由での起動設定 (pi-tools-and-sandbox.md
 * 「リーズナブルな sandbox レイヤ案」、session-runtime.md §6)。指定時のみ有効になる
 * opt-in — 未指定なら `piBinary` (既定 "pi") をそのまま spawn する現状動作を維持する。
 * bash の子プロセスには効かない (uid 分離が担う層) が、pi 本体の JS 実装ツール
 * (read/write/edit/grep) の fs アクセスを制限する多層防御の一層。
 */
export interface PiPermissionOptions {
	/** pi 本体のエントリポイント JS (例
	 * /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js)。
	 * `node --permission ... <entrypoint> <pi の引数...>` の形で起動する */
	entrypoint: string;
	/** `--allow-fs-read` に渡すパス群 (グロブ可)。フラグはパスごとに繰り返し指定する
	 * (Node 26 で `--allow-fs-write` のカンマ区切りは deprecated warning になり
	 * 機能しないため、read/write ともに 1 パス 1 フラグで組み立てる) */
	allowFsRead: string[];
	/** `--allow-fs-write` に渡すパス群 (グロブ可) */
	allowFsWrite: string[];
}

export interface PiProcessOptions {
	/** `--session` に渡す transcript JSONL の絶対パス */
	sessionPath: string;
	/** `--extension` に渡す extension の絶対パス群。pi の CLI は `--extension` を
	 * 複数回受け付けるため、配列の各要素を 1 フラグずつ展開する
	 * (reply + permission-gate を常時両方注入するため単一パスから複数化した) */
	extensionPaths: string[];
	/** pi バイナリのパス。省略時は env PI_BIN、それも無ければ "pi"。
	 * permission 指定時は無視される (entrypoint を直接 node で起動するため) */
	piBinary?: string;
	/** 指定時、`node --permission` 経由で pi を起動する (opt-in)。省略時は現状動作 */
	permission?: PiPermissionOptions;
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
	/** allowlist (PATH, HOME) に追加で渡す env。HOME は常に agent の HOME
	 * (例 /home/agent) に上書きするためここに含めて渡す (Runner の HOME を
	 * そのまま継承しない) */
	extraEnv?: Record<string, string>;
	/** 子プロセスの実行 uid (session-runtime.md §6: UID 分離)。省略時は継承 (現状動作) */
	uid?: number;
	/** 子プロセスの実行 gid。uid とセットで指定する想定 */
	gid?: number;
	/** stderr の各行を受けるロガー。省略時は console.error */
	logger?: (line: string) => void;
}

/** spawn 引数の組み立て (純粋関数、テスト対象) */
export function buildPiArgs(
	options: Pick<
		PiProcessOptions,
		| "sessionPath"
		| "extensionPaths"
		| "provider"
		| "model"
		| "appendSystemPrompt"
		| "skillPath"
	>,
): string[] {
	const args = ["--mode", "rpc", "--session", options.sessionPath];
	// pi は起動時にバージョンチェックと install telemetry の外部通信を行う
	// (dist/main.js の offlineMode 判定、docs/settings.md「Telemetry and update
	// checks」)。毎 mention ごとに spawn する本設計ではその都度の通信が無駄で
	// コールドスタート遅延の要因になるため常時止める。LLM 呼び出し (provider API)
	// には影響しない (research/pi-config.md 含意 4)
	args.push("--offline");
	// pi の CLI は --extension を複数回受け付けるため、パスごとに 1 フラグ展開する
	// (reply + permission-gate を常時両方注入するため)
	for (const extensionPath of options.extensionPaths)
		args.push("--extension", extensionPath);
	if (options.provider) args.push("--provider", options.provider);
	// google-vertex の認証可否判定は「ADC ファイルの存在チェック」なので、Cloud Run の
	// メタデータサーバー ADC (ファイルを作らない) では "No API key found" になる。
	// pi-ai が定義する marker 文字列を明示的に渡すとこのゲートを迂回でき、marker は
	// provider 側 (resolveApiKey) で捨てられて ADC 経路で実認証される (secret ではない)
	if (options.provider === "google-vertex")
		args.push("--api-key", "gcp-vertex-credentials");
	if (options.model) args.push("--model", options.model);
	if (options.appendSystemPrompt)
		args.push("--append-system-prompt", options.appendSystemPrompt);
	if (options.skillPath) args.push("--skill", options.skillPath);
	return args;
}

/**
 * 実際に spawn する command/args の組み立て (純粋関数、テスト対象)。
 * permission 未指定なら `piBinary` (pi バイナリ) をそのまま呼ぶ現状動作。
 * 指定時は `node --permission --allow-fs-read=... --allow-fs-write=...
 * --allow-child-process <entrypoint> <pi の引数...>` に切り替える
 * (pi-tools-and-sandbox.md 「リーズナブルな sandbox レイヤ案」)。
 * --allow-child-process は常に付ける — bash tool 自体は uid 分離が守る層なので、
 * ここで止めても意味がなく (JS 実装ツールの fs アクセス制限が本レイヤの主目的)、
 * 付けなければ bash tool の spawn 自体が Permission Model に拒否されて動かなくなる。
 * allowFsRead/allowFsWrite はパスごとに 1 フラグに展開する (Node 26 で
 * カンマ区切りは deprecated warning になり機能しないため)。
 */
export function buildSpawnCommand(
	piArgs: string[],
	options: Pick<PiProcessOptions, "piBinary" | "permission">,
): { command: string; args: string[] } {
	const permission = options.permission;
	if (permission === undefined) {
		return {
			command: options.piBinary ?? process.env.PI_BIN ?? "pi",
			args: piArgs,
		};
	}
	const flags: string[] = ["--permission"];
	for (const path of permission.allowFsRead)
		flags.push(`--allow-fs-read=${path}`);
	for (const path of permission.allowFsWrite)
		flags.push(`--allow-fs-write=${path}`);
	flags.push("--allow-child-process");
	// Node 26 の Permission Model はネットワークもデフォルト拒否
	// (fetch が getaddrinfo ERR_ACCESS_DENIED で失敗し LLM 呼び出しが不可能になる)。
	// このレイヤの目的は fs アクセス制限なので net は全面許可する
	flags.push("--allow-net");
	return {
		command: process.execPath,
		args: [...flags, permission.entrypoint, ...piArgs],
	};
}

/**
 * pi 起動時に cwd から `/` まで祖先ディレクトリを 1 段ずつ遡って existsSync する
 * ファイル名 (プロジェクト trust 判定・context ファイル探索。pi
 * dist/core/trust-manager.js の TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES と
 * dist/core/resource-loader.js の loadContextFileFromDir、および `.git` /
 * `.agents/skills` の存在チェックを docker で実測して特定した一覧)。
 * この probe は workdir だけでなく**全ての中間ディレクトリ**
 * (/tmp/pi-chat-runner/sessions/<ch> など) で走るため、workdir の祖先すべてに
 * ついてこのファイル名との直積を `--allow-fs-read` へ展開する必要がある —
 * 1 つでも欠けると existsSync が ERR_ACCESS_DENIED を投げ pi が exit 1 で即死する
 * (`--allow-fs-read=/` や `/*` の一括許可は他ユーザーの読めるファイルまで丸ごと
 * 開けてしまい広すぎるため使わない。docker で確認済み)。
 */
const PI_TRUST_PROBE_FILENAMES = [
	"AGENTS.md",
	"AGENTS.MD",
	"CLAUDE.md",
	"CLAUDE.MD",
	".git",
	".pi/settings.json",
	".pi/extensions",
	".pi/skills",
	".pi/prompts",
	".pi/themes",
	".pi/SYSTEM.md",
	".pi/APPEND_SYSTEM.md",
	// dist/migrations.js の migrateCommandsToPrompts が cwd の .pi/commands を
	// existsSync する (prompts への rename 判定)
	".pi/commands",
	".agents/skills",
];

/** dir 自身を含む `/` までの祖先ディレクトリ一覧 (純粋関数、テスト対象) */
export function ancestorDirs(dir: string): string[] {
	const dirs: string[] = [];
	let current = dir;
	while (true) {
		dirs.push(current);
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return dirs;
}

/**
 * Node Permission Model 用の allow パス一覧の組み立て (純粋関数、テスト対象)。
 * pi 本体 (npm global の node_modules) / `/app` (extension・skill 焼き込み) /
 * workdir / agent HOME への read を許可し、write は workdir と agent HOME
 * (+ 任意で /tmp) に限る。実際の allow 集合は docker 起動での実測 (このモジュールの
 * コメント、pi-tools-and-sandbox.md) に基づく最小構成。
 */
export function buildPiPermissionOptions(options: {
	/** pi 本体のエントリポイント JS の絶対パス */
	entrypoint: string;
	/** pi 本体の node_modules ルート (既定は entrypoint の npm global レイアウトから
	 * 推測できないため必須。例 /usr/local/lib/node_modules) */
	nodeModulesDir: string;
	/** `/app` 相当 (extension・skill 焼き込み先) の絶対パス */
	appDir: string;
	/** セッションの workdir (cwd)。read/write 両方を許可する */
	workdir: string;
	/** pi の HOME (常に agentHome)。~/.pi 等の読み書きに要る */
	home: string;
	/** 追加で write を許可したいパス (例 "/tmp/*"）。既定なし */
	extraWrite?: string[];
	/** 追加で read を許可したいパス (例 GOOGLE_APPLICATION_CREDENTIALS のファイル
	 * パス)。HOME を agentHome に固定するとローカルのユーザー ADC
	 * ($HOME/.config/gcloud) は HOME 経由で見えなくなるため、明示指定されたファイルだけ
	 * 個別に read を許可する用途。既定なし */
	extraRead?: string[];
}): PiPermissionOptions {
	return {
		entrypoint: options.entrypoint,
		allowFsRead: [
			`${options.nodeModulesDir}/*`,
			`${options.appDir}/*`,
			`${options.workdir}/*`,
			`${options.home}/*`,
			// workdir の全祖先 (workdir 自身は上の glob で足りるが重複しても無害) ×
			// trust probe ファイル名の直積。中間ディレクトリの existsSync を通すため
			...ancestorDirs(options.workdir).flatMap((dir) =>
				PI_TRUST_PROBE_FILENAMES.map((name) => join(dir, name)),
			),
			// pi の bash tool はシェル解決で existsSync("/bin/bash") を呼ぶ
			// (dist/utils/shell.js の getShellConfig)。Permission Model 下では
			// 未許可パスの existsSync は例外になるため、許可しないと bash tool が
			// コマンド内容にかかわらず全て失敗する。/bin/sh はそのフォールバック
			"/bin/bash",
			"/bin/sh",
			// bash tool の出力が 50KB (DEFAULT_MAX_BYTES) を超えると pi は
			// tmpdir()/pi-bash-<id>.log へスピルする (dist/core/bash-executor.js)。
			// 許可しないと WriteStream の unhandled 'error' で pi がツール実行中に即死する。
			// buildPiEnv は TMPDIR を渡さないため pi から見た tmpdir() は常に /tmp
			...piBashSpillPatterns(),
			...(options.extraRead ?? []),
		],
		allowFsWrite: [
			`${options.workdir}/*`,
			`${options.home}/*`,
			...piBashSpillPatterns(),
			...(options.extraWrite ?? []),
		],
	};
}

/** pi の bash 出力スピルファイル (/tmp/pi-bash-*.log) の許可パターン。
 * macOS では /tmp が /private/tmp への symlink で、Permission Model の照合は
 * パスの実体化タイミングで揺れるため realpath 側も併記する */
function piBashSpillPatterns(): string[] {
	const patterns = new Set<string>(["/tmp/pi-bash-*"]);
	try {
		patterns.add(join(realpathSync("/tmp"), "pi-bash-*"));
	} catch {
		// /tmp が無い環境はそのまま (コンテナでは /tmp は実体)
	}
	return [...patterns];
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
		const { command, args } = buildSpawnCommand(
			buildPiArgs(this.options),
			this.options,
		);
		const child = spawn(command, args, {
			cwd: this.options.cwd,
			env: buildPiEnv(process.env, this.options.extraEnv),
			stdio: ["pipe", "pipe", "pipe"],
			// uid/gid はキー自体を省略すると現行プロセスの uid/gid を継承する
			// (session-runtime.md §6: UID 分離。コンテナは root 起動、spawn 時に落とす)。
			// キーを渡した上で値を undefined にすると Node の spawn は継承ではなく
			// 明示的に「変更なし」と別扱いする実装差があるため、指定時のみキーを渡す
			...(this.options.uid !== undefined ? { uid: this.options.uid } : {}),
			...(this.options.gid !== undefined ? { gid: this.options.gid } : {}),
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
