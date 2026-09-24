// Dispatcher / Session の統合テスト用ハーネス。実 Slack・実 LLM の代わりに:
// - pi     → test/fixtures/fake-pi.mjs (stdin の JSONL を記録し、reply/agent_end を吐く)
// - Slack  → FakePoster / FakeReactionClient
// - config → インメモリの ConfigSource
// - controlState → InMemoryControlState (lease / drain-ack / linger の検証もここで行う)
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import pino from "pino";

import { SLACK_STATE_EMOJI } from "../../src/chat/slack.js";
import type { ClassifierClient } from "../../src/classifier/client.js";
import type { AgentConfig } from "../../src/config/agent-config.js";
import type { ChannelConfig } from "../../src/config/channel-config.js";
import type {
  ConfigSource,
  ResolvedChannel,
} from "../../src/config/config-source.js";
import { Dispatcher } from "../../src/dispatch/dispatcher.js";
import { type SessionPolicy, sessionKeyOf } from "../../src/dispatch/policy.js";
import { EmojiTurnReactor } from "../../src/egress/emoji-turn-reactor.js";
import { type ChatPoster, EgressRouter } from "../../src/egress/router.js";
import type { FetchMessage } from "../../src/gate/evaluate.js";
import type { InboundMessage } from "../../src/ingress/chat-event.js";
import type { MentionFormat } from "../../src/runtime/prompt.js";
import type {
  SharedStore,
  WorkdirStore,
} from "../../src/state/agent/interfaces.js";
import { NoopWorkdirStore } from "../../src/state/agent/noop.js";
import { InMemoryControlState } from "../../src/state/control/backends/memory.js";
import type { ControlState } from "../../src/state/control/interfaces.js";

export const FAKE_PI = fileURLToPath(
  new URL("../fixtures/fake-pi.mjs", import.meta.url),
);
/** srt CLI のスタブ (test/fixtures/fake-srt.mjs)。HarnessOptions.srtEntrypoint に渡す */
export const FAKE_SRT = fileURLToPath(
  new URL("../fixtures/fake-srt.mjs", import.meta.url),
);

export class FakePoster implements ChatPoster {
  calls: {
    channelId: string;
    threadTs?: string;
    text: string;
    files?: string[];
  }[] = [];
  updateCalls: { channelId: string; messageId: string; text: string }[] = [];
  private nextMessageId = 0;
  async postMessage(
    channelId: string,
    text: string,
    threadTs?: string,
    files?: string[],
  ) {
    this.calls.push({
      channelId,
      text,
      ...(threadTs !== undefined ? { threadTs } : {}),
      ...(files !== undefined ? { files } : {}),
    });
    this.nextMessageId += 1;
    return { messageId: `msg-${this.nextMessageId}` };
  }
  async updateMessage(channelId: string, messageId: string, text: string) {
    this.updateCalls.push({ channelId, messageId, text });
  }
}

/** テスト用の Channel 設定。YAML と同じ ChannelConfig 形 (agent フィールドが
 * agent: の下) だが、agent はマージ後の形 (sandbox は srt の設定そのもの) で書く。 */
export type TestChannelConfig = Omit<ChannelConfig, "agent"> & {
  agent?: AgentConfig;
};

/** テストは YAML と同じ ChannelConfig 形 (agent フィールドが agent: の下) で
 * 書き、ここで ResolvedChannel (agent 必須) へ均す — 実ローダーの 3 段マージを
 * 通さないぶん、agent は書かれたものをそのまま採用する。 */
export class FakeConfigSource implements ConfigSource {
  constructor(private readonly configs: Record<string, TestChannelConfig>) {}
  async channel(id: string): Promise<ResolvedChannel | null> {
    const config = this.configs[id];
    if (config === undefined) return null;
    const { agent = {}, ...part } = config;
    return { ...part, agent };
  }
}

/** 既存テストの大半は既定ポリシー (thread/thread) を前提に書かれているため、
 * sessionKeyOf の呼び出しをこの既定ポリシーで束ねる薄いヘルパーを用意する */
export const THREAD_POLICY: SessionPolicy = {
  sessionMode: "thread",
  replyMode: "thread",
};
export function derivedSessionKeyOf(event: InboundMessage): string {
  return sessionKeyOf(event, THREAD_POLICY);
}

export function message(
  overrides: Partial<InboundMessage> = {},
): InboundMessage {
  return {
    kind: "message",
    id: "1700000000.000100",
    conversation: { channelId: "C01" },
    sender: { id: "U01", isBot: false, isSelf: false },
    text: "hello",
    mentionsBot: false,
    attachments: [],
    timestamp: new Date("2026-07-05T00:00:00Z"),
    metadata: { eventId: `Ev-${Math.random().toString(36).slice(2)}` },
    ...overrides,
  };
}

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** pino のログ 1 行 (JSON) を配列に集めるテスト用ロガー */
export function collectingLogger(): {
  logger: pino.Logger;
  lines: () => Record<string, unknown>[];
} {
  const chunks: string[] = [];
  const stream = {
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
  };
  const logger = pino({ level: "debug" }, stream);
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

export interface Harness {
  dispatcher: Dispatcher;
  poster: FakePoster;
  controlState: ControlState;
  reactions: { channel: string; timestamp: string; name: string }[];
  workdirRoot: string;
  logLines: () => Record<string, unknown>[];
  commandsLog(channelId: string, threadTs: string): Promise<string[]>;
  envSeen(channelId: string, threadTs: string): Promise<Record<string, string>>;
  argvSeen(channelId: string, threadTs: string): Promise<string[]>;
  /** fake-srt が書く観測結果 (settings の位置と中身、内側コマンド) */
  srtSeen(channelId: string, threadTs: string): Promise<SrtSeen>;
}

export interface SrtSeen {
  settingsPath: string;
  settings: SandboxRuntimeConfig;
  debug: boolean;
  inner: string[];
}

export interface HarnessOptions {
  extraEnv?: Record<string, string>;
  /** 再起動を模して 2 つの Dispatcher で同じ Session (workdir) を共有させたいとき用 */
  workdirRoot?: string;
  controlState?: ControlState;
  workdirStore?: WorkdirStore;
  sharedStore?: SharedStore;
  /** テストの実待ちを短くするため既定 30ms (本番既定は 20000ms) */
  lingerMs?: number;
  leaseTtlMs?: number;
  owner?: string;
  piBinary?: string;
  piEntrypoint?: string;
  /** srt の cli.js のパス (RuntimeConfig.srtEntrypoint)。未指定なら sandbox 有効な
   * Channel の起動は fail-closed で失敗する */
  srtEntrypoint?: string;
  agentUid?: number;
  agentGid?: number;
  agentHome?: string;
  turnTimeoutMs?: number;
  progressNoticeIntervalMs?: number;
  mentionFormat?: MentionFormat;
  classifierClient?: ClassifierClient;
  /** reaction 起動で Gate ステージが対象メッセージ本文を引くための関数 */
  fetchMessage?: FetchMessage;
}

export async function harness(
  docs: Record<string, TestChannelConfig> = {},
  options: HarnessOptions = {},
): Promise<Harness> {
  const workdirRoot =
    options.workdirRoot ??
    (await mkdtemp(join(tmpdir(), "pi-chat-runner-test-")));
  // Dispatcher の既定 agentHome ("/home/agent") はテスト実行者に書き込み権限が
  // ないため、テストでは常に書き込み可能な一時ディレクトリへ差し替える
  // (実プロダクション既定を検証したいテストは agentHome を明示指定する)
  const agentHome =
    options.agentHome ??
    join(
      await mkdtemp(join(tmpdir(), "pi-chat-runner-test-home-")),
      "agent-home",
    );
  const poster = new FakePoster();
  const controlState = options.controlState ?? new InMemoryControlState();
  const reactionCalls: { channel: string; timestamp: string; name: string }[] =
    [];
  const { logger, lines } = collectingLogger();
  const dispatcher = new Dispatcher({
    configSource: new FakeConfigSource(docs),
    controlState,
    router: new EgressRouter({ poster }),
    reactor: new EmojiTurnReactor(
      {
        add: async (args) => {
          reactionCalls.push(args);
          return {};
        },
      },
      SLACK_STATE_EMOJI,
    ),
    runtime: {
      workdirRoot,
      ...(options.piBinary !== undefined
        ? { piBinary: options.piBinary }
        : options.piEntrypoint === undefined
          ? { piBinary: FAKE_PI }
          : {}),
      ...(options.piEntrypoint !== undefined
        ? { piEntrypoint: options.piEntrypoint }
        : {}),
      ...(options.srtEntrypoint !== undefined
        ? { srtEntrypoint: options.srtEntrypoint }
        : {}),
      ...(options.extraEnv !== undefined ? { extraEnv: options.extraEnv } : {}),
      ...(options.agentUid !== undefined ? { agentUid: options.agentUid } : {}),
      ...(options.agentGid !== undefined ? { agentGid: options.agentGid } : {}),
      agentHome,
    },
    lingerMs: options.lingerMs ?? 30,
    logger,
    workdirStore: options.workdirStore ?? new NoopWorkdirStore(),
    ...(options.sharedStore !== undefined
      ? { sharedStore: options.sharedStore }
      : {}),
    ...(options.leaseTtlMs !== undefined
      ? { leaseTtlMs: options.leaseTtlMs }
      : {}),
    ...(options.owner !== undefined ? { owner: options.owner } : {}),
    ...(options.turnTimeoutMs !== undefined
      ? { turnTimeoutMs: options.turnTimeoutMs }
      : {}),
    ...(options.progressNoticeIntervalMs !== undefined
      ? { progressNoticeIntervalMs: options.progressNoticeIntervalMs }
      : {}),
    // Dispatcher では必須パラメータ。テストでは既定として Slack の
    // `<@USER_ID>` 記法を使う (個々のテストが上書きしない限り)
    mentionFormat: options.mentionFormat ?? ((id) => `<@${id}>`),
    ...(options.classifierClient !== undefined
      ? { classifierClient: options.classifierClient }
      : {}),
    ...(options.fetchMessage !== undefined
      ? { fetchMessage: options.fetchMessage }
      : {}),
  });
  return {
    dispatcher,
    poster,
    controlState,
    reactions: reactionCalls,
    workdirRoot,
    logLines: lines,
    commandsLog: async (channelId, threadTs) => {
      const raw = await readFile(
        join(workdirRoot, channelId, threadTs, "commands.jsonl"),
        "utf-8",
      );
      return raw.trim().split("\n");
    },
    envSeen: async (channelId, threadTs) => {
      const raw = await readFile(
        join(workdirRoot, channelId, threadTs, "env-seen.json"),
        "utf-8",
      );
      return JSON.parse(raw);
    },
    argvSeen: async (channelId, threadTs) => {
      const raw = await readFile(
        join(workdirRoot, channelId, threadTs, "argv-seen.json"),
        "utf-8",
      );
      return JSON.parse(raw);
    },
    srtSeen: async (channelId, threadTs) => {
      const raw = await readFile(
        join(workdirRoot, channelId, threadTs, "srt-seen.json"),
        "utf-8",
      );
      return JSON.parse(raw);
    },
  };
}
