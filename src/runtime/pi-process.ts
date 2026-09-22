/**
 * pi 子プロセスのラッパ (docs/design/runtime.md §1 Runtime の責務、§7 RPC)。
 * pi を `--mode rpc` で子プロセス起動し、stdin JSONL でコマンドを送り、
 * stdout JSONL のイベントを購読する。起動引数・env の組み立ては pi-args.ts。
 *
 * TODO(将来): 現状は pi 専用実装で、AgentProcess のような抽象 interface は
 * 切っていない (ingress/ の Ingress のような抽象/実装分離は未実施)。
 * pi 以外の agent 実行コンテナが実際に必要になったタイミングで、この境界を
 * インタフェースとして切り出す (今は実装が1つしかなく、可変点を想像で決めると
 * 手戻りするため見送っている)。
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";

import {
  buildPiArgs,
  buildPiEnv,
  buildSpawnCommand,
  type PiPermissionOptions,
} from "./pi-args.js";
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
  /** `--extension` に渡す extension の絶対パス群。pi の CLI は `--extension` を
   * 複数回受け付けるため、配列の各要素を 1 フラグずつ展開する
   * (reply + permission-gate を常時両方注入するため単一パスから複数化した) */
  extensionPaths: string[];
  /** 明示的に差し替える pi バイナリ。テストや埋め込み用途向け。
   * 指定時は piEntrypoint より優先する。 */
  piBinary?: string;
  /** 解決済みの pi 本体 entrypoint JS。permission の有無に関わらず使用する。 */
  piEntrypoint?: string;
  /** 指定時、`node --permission` 経由で pi を起動する (opt-in)。省略時は現状動作 */
  permission?: PiPermissionOptions;
  /** `--model` に渡す `provider/model-id[:thinking-level]` (省略時は pi のローカル
   * 設定に従う)。provider の切り替え・thinking level はこの shorthand で表現し、
   * パースは pi の resolveCliModel に委譲する (--provider は渡さない) */
  model?: string;
  /** `--append-system-prompt` */
  appendSystemPrompt?: string;
  /** 追加の `--skill` パス群 (AgentConfig.skills、絶対パス)。pi の --skill は
   * 複数回受け付け、$AGENT_HOME/.pi/agent/skills/ の自動発見に対して additive */
  skillPaths?: string[];
  /** `--tools` allowlist (channel ごとの AgentConfig.tools)。extension ツール
   * (reply 含む) にも適用されるため、buildPiArgs が reply を自動補完する。
   * 未指定または空配列ならフラグを渡さない (全ツール有効の現状動作) */
  tools?: string[];
  /** `--exclude-tools` denylist (AgentConfig.excludeTools)。reply は
   * buildPiArgs が黙って除外する (返信経路を落とさないため) */
  excludeTools?: string[];
  /** 子プロセスの cwd (workdir) */
  cwd?: string;
  /** allowlist (PATH, HOME) に追加で渡す env。HOME は常に agent の HOME
   * (例 /home/agent) に上書きするためここに含めて渡す (Runner の HOME を
   * そのまま継承しない) */
  extraEnv?: Record<string, string>;
  /** 子プロセスの実行 uid (runtime.md §5.1: UID 分離)。省略時は継承 (現状動作) */
  uid?: number;
  /** 子プロセスの実行 gid。uid とセットで指定する想定 */
  gid?: number;
  /** stderr の各行を受けるロガー。省略時は console.error */
  logger?: (line: string) => void;
}

export interface PiProcessEvents {
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
      // (runtime.md §5.1: UID 分離。コンテナは root 起動、spawn 時に落とす)。
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
