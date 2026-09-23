// sandbox E2E の共通ヘルパー (docs/design/local-dev.md §1、runtime.md §5.5)。
//
// LLM は使わない。Runner をライブラリとして起動し (test/e2e/helpers/live.ts と同じ
// 形)、pi の代わりに test/fixtures/probe-pi.mjs を **本番と同じ経路** — settings
// ファイル書き出し → `srt --settings` → bwrap → `node --permission` — で起動する。
// probe-pi は prompt に書かれた shell コマンドを実行して結果を返すだけなので、
// sandbox の内側から見えるものを決定的に assert できる。
//
// 動かせるのは Linux + bwrap/socat のあるホスト (通常は `pnpm run test:e2e:sandbox`
// が立てる Docker コンテナ)。`E2E_SANDBOX=1` で opt-in し、既定の `pnpm test` では
// describeSandbox が全て skip する。root で動いているときは本番と同じ UID 分離
// (uid/gid 1001, HOME=/home/agent) を使う。

import { execFile } from "node:child_process";
import { chmod, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import pino from "pino";
import { describe } from "vitest";

import { createLocalChat } from "../../../src/chat/local/local-chat.js";
import { createLocalPlatform } from "../../../src/chat/local/platform.js";
import type { LocalChat } from "../../../src/chat/local/types.js";
import type { AgentConfig } from "../../../src/config/agent-config.js";
import type { ChannelEntry } from "../../../src/config/channel-config.js";
import {
  resolveSystemConfig,
  SystemConfigSchema,
} from "../../../src/config/system-config.js";
import { startRunner } from "../../../src/runner.js";
import { createRuntimeConfig } from "../../../src/runtime/resolve.js";
import { sandboxSettingsPath } from "../../../src/runtime/sandbox.js";
import { NoopWorkdirStore } from "../../../src/state/agent/noop.js";
import { InMemoryControlState } from "../../../src/state/control/backends/memory.js";
import type { LogRecord } from "../../e2e/helpers/live.js";
import { sleep, waitForValue } from "../../e2e/helpers/live.js";
import { StaticConfigSource } from "../../e2e/helpers/static-config-source.js";

export const isSandboxE2E = process.env.E2E_SANDBOX === "1";

const skip = !isSandboxE2E || process.platform !== "linux";
type SandboxDescribe = ReturnType<typeof describe.skipIf>;
// oxlint-disable-next-line vitest/valid-describe-callback, vitest/valid-title -- describe を呼ばず skipIf の戻り値を再 export するだけ
export const describeSandbox: SandboxDescribe = describe.skipIf(skip);

/** 1 ケースの上限。srt の起動 (bwrap + proxy) と curl の実ネットワークを含む。 */
export const SANDBOX_TEST_TIMEOUT_MS = 90_000;
const DEFAULT_REPLY_TIMEOUT_MS = 60_000;

const PROBE_PI = fileURLToPath(
  new URL("../../fixtures/probe-pi.mjs", import.meta.url),
);
const REPO_ROOT = dirname(dirname(dirname(PROBE_PI)));

/** 本番と同じ agent uid/gid (Dockerfile の useradd)。root で動くときだけ使う */
const AGENT_UID = 1001;
const AGENT_GID = 1001;

export interface ProbeResult {
  cmd: string;
  code: number | null;
  signal: string | null;
  out: string;
  err: string;
}

export interface SandboxRunner {
  chat: LocalChat;
  workdirRoot: string;
  /** channelId に PROBE メッセージを投げ、probe-pi の結果を待って返す */
  probe(
    channelId: string,
    cmds: string[],
    options?: { threadTs?: string; timeoutMs?: number },
  ): Promise<{ ts: string; results: ProbeResult[] }>;
  /** PROBE メッセージを投げるだけ (返信を待たない)。ts を返す */
  post(channelId: string, cmds: string[]): Promise<string>;
  logs(): readonly LogRecord[];
  waitForLog(
    msg: string,
    predicate?: (r: LogRecord) => boolean,
    timeoutMs?: number,
  ): Promise<LogRecord>;
  /** その Session の srt settings ファイルのパス (thread mode の sessionKey) */
  settingsPathFor(channelId: string, threadTs: string): string;
  workdirFor(channelId: string, threadTs: string): string;
  tmpDirFor(channelId: string, threadTs: string): string;
}

export interface StartSandboxRunnerOptions {
  agent?: AgentConfig;
  channels: ChannelEntry[];
  turnTimeoutMs?: number;
  lingerMs?: number;
}

export async function startSandboxRunner(
  opts: StartSandboxRunnerOptions,
): Promise<SandboxRunner> {
  const chat = createLocalChat({ defaultChannelId: "C_SANDBOX" });
  const asRoot = process.getuid?.() === 0;

  // agent uid が workdir まで辿れるよう、mkdtemp の 0700 を 0755 に開く
  // (本番の workdirRoot は Runner が mkdir -p で作る 0755)
  const workdirRoot = await realpath(
    await mkdtemp(join(tmpdir(), "pi-chat-runner-sandbox-e2e-")),
  );
  await chmod(workdirRoot, 0o755);
  const agentHome = asRoot
    ? "/home/agent"
    : await mkdtemp(join(tmpdir(), "pi-chat-runner-sandbox-e2e-home-"));

  const system = resolveSystemConfig(
    SystemConfigSchema.parse({
      runtime: {
        home: agentHome,
        ...(asRoot ? { uid: AGENT_UID, gid: AGENT_GID } : {}),
      },
    }),
    process.env,
  );
  const base = createRuntimeConfig(system, {
    workdirRoot,
    baseEnv: process.env,
  });
  if (base.srtEntrypoint === undefined) {
    throw new Error(
      "srt entrypoint did not resolve; is the sandbox E2E running on Linux with @anthropic-ai/sandbox-runtime installed?",
    );
  }
  if (base.piPermission === undefined) {
    throw new Error("Permission Model must stay on for the sandbox E2E");
  }
  // pi 本体の代わりに probe-pi を Permission Model の entrypoint にする。
  // それ以外 (srt のパス、env allowlist、UID 分離) は本番と同じ組み立て
  const runtime = {
    ...base,
    piEntrypoint: PROBE_PI,
    piPermission: {
      ...base.piPermission,
      entrypoint: PROBE_PI,
      nodeModulesDir: join(REPO_ROOT, "node_modules"),
    },
  };

  const records: LogRecord[] = [];
  // vitest.config が LOG_LEVEL を "silent" に既定するので、明示された値のときだけ流す
  const printLevel =
    process.env.LOG_LEVEL !== "silent" ? process.env.LOG_LEVEL : undefined;
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const text = chunk.toString();
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        try {
          records.push(JSON.parse(line) as LogRecord);
        } catch {
          // pino 以外の書き込みは無視
        }
      }
      if (printLevel !== undefined) process.stdout.write(text);
      callback();
    },
  });
  const logger = pino({ level: "debug" }, destination);

  await startRunner({
    chat: createLocalPlatform(chat),
    controlState: new InMemoryControlState(),
    agentState: { workdir: new NoopWorkdirStore() },
    configSource: new StaticConfigSource({
      ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
      channels: opts.channels,
    }),
    runtime,
    ...(opts.turnTimeoutMs !== undefined
      ? { turnTimeoutMs: opts.turnTimeoutMs }
      : {}),
    lingerMs: opts.lingerMs ?? 200,
    logger,
  });

  async function post(channelId: string, cmds: string[]): Promise<string> {
    const posted = await chat.post(`PROBE ${JSON.stringify({ cmds })}`, {
      channelId,
      mentionsBot: true,
    });
    return posted.ts;
  }

  return {
    chat,
    workdirRoot,
    post,
    async probe(channelId, cmds, options) {
      const ts =
        options?.threadTs !== undefined
          ? (
              await chat.post(`PROBE ${JSON.stringify({ cmds })}`, {
                channelId,
                mentionsBot: true,
                threadTs: options.threadTs,
              })
            ).ts
          : await post(channelId, cmds);
      const threadTs = options?.threadTs ?? ts;
      const reply = await waitForValue(
        () =>
          chat
            .log()
            .find(
              (m) =>
                m.sender.isSelf &&
                m.threadTs === threadTs &&
                Number(m.ts) > Number(ts),
            ),
        `probe reply in ${channelId}/${threadTs}; log so far: ${JSON.stringify(
          chat
            .log()
            .map((m) => [
              m.ts,
              m.threadTs,
              m.sender.isSelf,
              m.text.slice(0, 200),
            ]),
        )}; runner logs: ${JSON.stringify(records.filter((r) => r.level >= 40).map((r) => [r.msg, r.err]))}`,
        options?.timeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS,
      );
      return { ts, results: JSON.parse(reply.text) as ProbeResult[] };
    },
    logs: () => records,
    async waitForLog(msg, predicate, timeoutMs) {
      return await waitForValue(
        () => records.find((r) => r.msg === msg && (predicate?.(r) ?? true)),
        `log record ${JSON.stringify(msg)}; messages so far: ${JSON.stringify(records.map((r) => r.msg))}`,
        timeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS,
      );
    },
    settingsPathFor: (channelId, threadTs) =>
      sandboxSettingsPath(workdirRoot, `${channelId}:${threadTs}`),
    workdirFor: (channelId, threadTs) => join(workdirRoot, channelId, threadTs),
    tmpDirFor: (channelId, threadTs) =>
      join(workdirRoot, channelId, "tmp", threadTs),
  };
}

/** mention 起動の channels。sandbox は agent 側で与える */
export function mentionChannels(
  ...entries: (ChannelEntry | string)[]
): ChannelEntry[] {
  const mention = (channel: string): ChannelEntry => ({
    channel,
    trigger: { when: [{ kind: "mention" }] },
  });
  return [
    mention("default"),
    ...entries.map((entry) =>
      typeof entry === "string" ? mention(entry) : entry,
    ),
  ];
}

const execFileAsync = promisify(execFile);

/** Runner から見えるプロセス一覧 (`ps -eo pid,args`) のうち pattern に一致する行 */
export async function processesMatching(pattern: RegExp): Promise<string[]> {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid,args"]);
  return stdout.split("\n").filter((line) => pattern.test(line));
}

export { sleep };
