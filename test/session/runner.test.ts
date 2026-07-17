// SessionRunner の統合テスト。実 Slack・実 LLM の代わりに:
// - pi     → test/fixtures/fake-pi.mjs (stdin の JSONL を記録し、reply/agent_end を吐く)
// - Slack  → FakePoster / FakeReactionClient
// - config → インメモリの ConfigSource
// - store  → InMemoryStateStore (Step 4: lease / drain-ack / linger の検証もここで行う)
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { ClassifierClient } from "../../src/classifier/client.js";
import type { ChannelDoc } from "../../src/config/channel-doc.js";
import type { ConfigSource } from "../../src/config/config-source.js";
import { Reactions } from "../../src/egress/reactions.js";
import { type ChatPoster, EgressRouter } from "../../src/egress/router.js";
import type {
  InboundMessage,
  ReactionEvent,
} from "../../src/ingress/chat-event.js";
import type {
  FetchedMessage,
  FetchMessage,
  MentionFormat,
  PiPermissionConfig,
} from "../../src/session/runner.js";
import {
  computeKickDelayMs,
  isIdleExpired,
  renderEvent,
  replyThreadKeyOf,
  resolveSessionPolicy,
  type SessionPolicy,
  SessionRunner,
  sessionKeyOf,
} from "../../src/session/runner.js";
import { InMemoryStateStore } from "../../src/store/state/backends/memory.js";
import { inboxItemId } from "../../src/store/state/inbox-item.js";
import type { StateStore } from "../../src/store/state/interfaces.js";
import {
  CopySharedStorage,
  CopyWorkdirStorage,
  NoopWorkdirStorage,
  type SharedStorage,
  type WorkdirStorage,
} from "../../src/store/workdir.js";

const FAKE_PI = fileURLToPath(
  new URL("../fixtures/fake-pi.mjs", import.meta.url),
);

class FakePoster implements ChatPoster {
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

class FakeConfigSource implements ConfigSource {
  constructor(private readonly docs: Record<string, ChannelDoc>) {}
  async channel(id: string): Promise<ChannelDoc | null> {
    return this.docs[id] ?? null;
  }
}

/** 既存テストの大半は既定ポリシー (thread/thread) を前提に書かれているため、
 * sessionKeyOf の呼び出しをこの既定ポリシーで束ねる薄いヘルパーを用意する
 * (旧 threadKeyOf と同じ値を返す) */
const THREAD_POLICY: SessionPolicy = {
  sessionMode: "thread",
  replyMode: "thread",
};
function threadKeyOf(event: InboundMessage): string {
  return sessionKeyOf(event, THREAD_POLICY);
}

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
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

async function waitFor(
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** pino のログ 1 行 (JSON) を配列に集めるテスト用ロガー */
function collectingLogger(): {
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

interface Harness {
  runner: SessionRunner;
  poster: FakePoster;
  store: StateStore;
  reactions: { channel: string; timestamp: string; name: string }[];
  workdirRoot: string;
  logLines: () => Record<string, unknown>[];
  commandsLog(channelId: string, threadTs: string): Promise<string[]>;
  envSeen(channelId: string, threadTs: string): Promise<Record<string, string>>;
  argvSeen(channelId: string, threadTs: string): Promise<string[]>;
}

interface HarnessOptions {
  extraEnv?: Record<string, string>;
  store?: StateStore;
  workdirStorage?: WorkdirStorage;
  sharedStorage?: SharedStorage;
  /** テストの実待ちを短くするため既定 30ms (本番既定は 3000ms) */
  lingerMs?: number;
  leaseTtlMs?: number;
  owner?: string;
  piBinary?: string;
  piEntrypoint?: string;
  agentUid?: number;
  agentGid?: number;
  agentHome?: string;
  piPermission?: PiPermissionConfig;
  turnTimeoutMs?: number;
  progressNoticeIntervalMs?: number;
  mentionFormat?: MentionFormat;
  classifierClient?: ClassifierClient;
}

async function harness(
  docs: Record<string, ChannelDoc> = {},
  options: HarnessOptions = {},
): Promise<Harness> {
  const workdirRoot = await mkdtemp(join(tmpdir(), "pi-chat-runner-test-"));
  // SessionRunner の既定 agentHome ("/home/agent") はテスト実行者に書き込み権限が
  // ないため、テストでは常に書き込み可能な一時ディレクトリへ差し替える
  // (実プロダクション既定を検証したいテストは agentHome を明示指定する)
  const agentHome =
    options.agentHome ??
    join(
      await mkdtemp(join(tmpdir(), "pi-chat-runner-test-home-")),
      "agent-home",
    );
  const poster = new FakePoster();
  const store = options.store ?? new InMemoryStateStore();
  const reactionCalls: { channel: string; timestamp: string; name: string }[] =
    [];
  const { logger, lines } = collectingLogger();
  const runner = new SessionRunner({
    configSource: new FakeConfigSource(docs),
    store,
    router: new EgressRouter({ poster }),
    reactions: new Reactions({
      add: async (args) => {
        reactionCalls.push(args);
        return {};
      },
    }),
    workdirRoot,
    ...(options.piBinary !== undefined
      ? { piBinary: options.piBinary }
      : options.piEntrypoint === undefined
        ? { piBinary: FAKE_PI }
        : {}),
    ...(options.piEntrypoint !== undefined
      ? { piEntrypoint: options.piEntrypoint }
      : {}),
    lingerMs: options.lingerMs ?? 30,
    logger,
    ...(options.extraEnv !== undefined ? { extraEnv: options.extraEnv } : {}),
    workdirStorage: options.workdirStorage ?? new NoopWorkdirStorage(),
    ...(options.sharedStorage !== undefined
      ? { sharedStorage: options.sharedStorage }
      : {}),
    ...(options.leaseTtlMs !== undefined
      ? { leaseTtlMs: options.leaseTtlMs }
      : {}),
    ...(options.owner !== undefined ? { owner: options.owner } : {}),
    ...(options.agentUid !== undefined ? { agentUid: options.agentUid } : {}),
    ...(options.agentGid !== undefined ? { agentGid: options.agentGid } : {}),
    agentHome,
    ...(options.piPermission !== undefined
      ? { piPermission: options.piPermission }
      : {}),
    ...(options.turnTimeoutMs !== undefined
      ? { turnTimeoutMs: options.turnTimeoutMs }
      : {}),
    ...(options.progressNoticeIntervalMs !== undefined
      ? { progressNoticeIntervalMs: options.progressNoticeIntervalMs }
      : {}),
    // SessionRunner では必須パラメータ。テストでは既定として Slack の
    // `<@USER_ID>` 記法を使う (個々のテストが上書きしない限り)
    mentionFormat: options.mentionFormat ?? ((id) => `<@${id}>`),
    ...(options.classifierClient !== undefined
      ? { classifierClient: options.classifierClient }
      : {}),
  });
  return {
    runner,
    poster,
    store,
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
  };
}

describe("SessionRunner (fake-pi integration)", () => {
  it("mention → gate → spawn → reply reaches the poster → check reaction", async () => {
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "question here" });

    await h.runner.handle(trigger);

    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    expect(h.poster.calls[0]).toEqual({
      channelId: "C01",
      threadTs: trigger.id,
      text: `echo: ${renderEvent(trigger, replyThreadKeyOf(trigger))}`,
    });

    await waitFor(
      () => h.reactions.some((r) => r.name === "white_check_mark"),
      "check reaction",
    );
    expect(h.reactions.map((r) => r.name)).toEqual([
      "eyes",
      "white_check_mark",
    ]);
    expect(h.reactions[0]?.timestamp).toBe(trigger.id);

    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");
    const commands = await h.commandsLog("C01", trigger.id);
    expect(JSON.parse(commands[0] ?? "{}").type).toBe("prompt");

    // 終了処理で lease が解放され、inbox は ack 済みで空
    const threadKey = threadKeyOf(trigger);
    expect(await h.store.inbox.drain(threadKey)).toEqual([]);
    expect(
      await h.store.leases.acquire(threadKey, "probe", 1000),
    ).not.toBeNull();
    expect((await h.store.sessions.get(threadKey))?.status).toBe("finished");
  });

  it("reply files outside the workdir are dropped; in-workdir files resolve to absolute paths", async () => {
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "WITH_FILES" });

    await h.runner.handle(trigger);

    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    // macOS では /tmp が /private/tmp への symlink で、runner は workdir を
    // realpath 済みの絶対パスとして扱う (kick 内の workdirReal)。テスト側の
    // workdirRoot も同様に realpath してから比較する
    const workdirReal = await realpath(join(h.workdirRoot, "C01", trigger.id));
    // fake-pi は ["ok.txt", "../escape.txt", "/etc/passwd"] の 3 件を渡す。
    // workdir 外の 2 件は除外され、ok.txt だけが絶対パスへ解決されて残る
    expect(h.poster.calls[0]?.files).toEqual([join(workdirReal, "ok.txt")]);

    const warnings = h
      .logLines()
      .filter((l) => l.msg === "reply file path escapes workdir; dropped");
    expect(warnings.map((w) => w.path)).toEqual([
      "../escape.txt",
      "/etc/passwd",
    ]);

    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");
  });

  it("channel skills/extensions are passed to pi as --skill / --extension (additive)", async () => {
    // チャンネル別の追加 skill / extension (config.md §2)。実在するパスを用意し、
    // fake-pi の argv に反映されることを確認する
    const resourceRoot = await mkdtemp(
      join(tmpdir(), "pi-chat-runner-test-resources-"),
    );
    const skillDir = join(resourceRoot, "skills", "gc-logging");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# gc-logging\n");
    const extensionFile = join(resourceRoot, "extensions", "extra.ts");
    await mkdir(join(resourceRoot, "extensions"), { recursive: true });
    await writeFile(extensionFile, "export default () => {};\n");

    const h = await harness({
      C01: { skills: [skillDir], extensions: [extensionFile] },
    });
    const trigger = message({ mentionsBot: true, text: "hello" });
    await h.runner.handle(trigger);
    await waitFor(() => h.poster.calls.length === 1, "reply posted");

    const argv = await h.argvSeen("C01", trigger.id);
    const skillDirReal = await realpath(skillDir);
    const extensionFileReal = await realpath(extensionFile);
    expect(argv[argv.indexOf("--skill") + 1]).toBe(skillDirReal);
    // 組み込み extension (reply 等) に加えてチャンネル別 extension も渡る
    const extensionArgs = argv
      .map((arg, i) => (arg === "--extension" ? argv[i + 1] : null))
      .filter((v): v is string => v !== null);
    expect(extensionArgs).toContain(extensionFileReal);
    expect(extensionArgs.some((path) => path.endsWith("/reply.ts"))).toBe(true);
  });

  it("a nonexistent channel skills path fails the kick loudly", async () => {
    const h = await harness({
      C01: { skills: ["/does/not/exist/skill"] },
    });
    const trigger = message({ mentionsBot: true, text: "hello" });
    await h.runner.handle(trigger);

    // 黙って skill 抜きで動かず、kick 自体が失敗としてログに残る
    await waitFor(
      () => h.logLines().some((l) => l.msg === "session kick failed"),
      "kick failure logged",
    );
    expect(h.poster.calls).toEqual([]);
  });

  it("shared: 棚から staging へ復元され、--skill 配線とプロンプト言及が入り、ターン終了で棚へ書き戻される", async () => {
    const sharedRoot = await mkdtemp(
      join(tmpdir(), "pi-chat-runner-test-shared-"),
    );
    // 過去セッションの蓄積がある棚を模す (docs/design/shared.md §2:
    // session.jsonl が無くても復元される — WorkdirStorage との差分)
    await mkdir(join(sharedRoot, "C01", "memory"), { recursive: true });
    await writeFile(
      join(sharedRoot, "C01", "memory", "MEMORY.md"),
      "- past fact",
    );

    const h = await harness(
      {},
      { sharedStorage: new CopySharedStorage(sharedRoot) },
    );
    // 前ターンで agent が staging に書いた体のファイル (flush で棚へ上がるはず)
    const staging = join(h.workdirRoot, "C01", "shared");
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, "notes.md"), "learned in a past turn");

    const trigger = message({ mentionsBot: true, text: "hello" });
    await h.runner.handle(trigger);
    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

    // 棚の内容が staging (workdir の隣 = agent からは ../shared/) に復元されている
    expect(await readFile(join(staging, "memory", "MEMORY.md"), "utf-8")).toBe(
      "- past fact",
    );

    // --skill に staging の skills/ と組み込み memory skill の両方が載る
    const argv = await h.argvSeen("C01", trigger.id);
    const skillArgs = argv
      .map((arg, i) => (arg === "--skill" ? argv[i + 1] : null))
      .filter((v): v is string => v !== null);
    expect(skillArgs).toContain(await realpath(join(staging, "skills")));
    expect(skillArgs.some((p) => p.endsWith("builtin-skills/memory"))).toBe(
      true,
    );

    // system prompt に ../shared/ の説明が入る
    const appendPrompt = argv[argv.indexOf("--append-system-prompt") + 1];
    expect(appendPrompt).toContain("../shared/");

    // ターン終了の flush で staging の内容 (mkdir された skills/ 含む) が棚へ
    expect(await readFile(join(sharedRoot, "C01", "notes.md"), "utf-8")).toBe(
      "learned in a past turn",
    );
    expect((await stat(join(sharedRoot, "C01", "skills"))).isDirectory()).toBe(
      true,
    );
  });

  it("shared: memory: false は組み込み memory skill だけを外す (shared skills の配線は残る)", async () => {
    const sharedRoot = await mkdtemp(
      join(tmpdir(), "pi-chat-runner-test-shared-"),
    );
    const h = await harness(
      { C01: { memory: false } },
      { sharedStorage: new CopySharedStorage(sharedRoot) },
    );
    const trigger = message({ mentionsBot: true, text: "hello" });
    await h.runner.handle(trigger);
    await waitFor(() => h.poster.calls.length === 1, "reply posted");

    const argv = await h.argvSeen("C01", trigger.id);
    const skillArgs = argv
      .map((arg, i) => (arg === "--skill" ? argv[i + 1] : null))
      .filter((v): v is string => v !== null);
    expect(skillArgs).toContain(
      await realpath(join(h.workdirRoot, "C01", "shared", "skills")),
    );
    expect(skillArgs.some((p) => p.includes("builtin-skills"))).toBe(false);

    // memoryEnabled が false になるため、system prompt にも memory index の
    // 文言が入らない (docs/design/memory.md §2)
    const appendPrompt = argv[argv.indexOf("--append-system-prompt") + 1];
    expect(appendPrompt).not.toContain("memory index");
  });

  it("shared: 棚に MEMORY.md があると、その中身が system prompt に注入される (memory.md §2)", async () => {
    const sharedRoot = await mkdtemp(
      join(tmpdir(), "pi-chat-runner-test-shared-"),
    );
    await mkdir(join(sharedRoot, "C01", "memory"), { recursive: true });
    await writeFile(
      join(sharedRoot, "C01", "memory", "MEMORY.md"),
      "- some memory fact",
    );

    const h = await harness(
      {},
      { sharedStorage: new CopySharedStorage(sharedRoot) },
    );
    const trigger = message({ mentionsBot: true, text: "hello" });
    await h.runner.handle(trigger);
    await waitFor(() => h.poster.calls.length === 1, "reply posted");

    const argv = await h.argvSeen("C01", trigger.id);
    const appendPrompt = argv[argv.indexOf("--append-system-prompt") + 1];
    expect(appendPrompt).toContain("memory index");
    expect(appendPrompt).toContain("../shared/memory/MEMORY.md");
    expect(appendPrompt).toContain("- some memory fact");
  });

  it("shared: 棚に MEMORY.md が無い (新規チャンネル) 場合、memory index の文言は system prompt に入らない", async () => {
    const sharedRoot = await mkdtemp(
      join(tmpdir(), "pi-chat-runner-test-shared-"),
    );

    const h = await harness(
      {},
      { sharedStorage: new CopySharedStorage(sharedRoot) },
    );
    const trigger = message({ mentionsBot: true, text: "hello" });
    await h.runner.handle(trigger);
    await waitFor(() => h.poster.calls.length === 1, "reply posted");

    const argv = await h.argvSeen("C01", trigger.id);
    const appendPrompt = argv[argv.indexOf("--append-system-prompt") + 1];
    // shared 自体の言及は入るが、MEMORY.md が存在しない (ENOENT) ので
    // memory index のヘッダーは入らない
    expect(appendPrompt).toContain("../shared/");
    expect(appendPrompt).not.toContain("memory index");
  });

  it("shared: 未設定 (既定) なら staging も --skill もプロンプト言及も無い", async () => {
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "hello" });
    await h.runner.handle(trigger);
    await waitFor(() => h.poster.calls.length === 1, "reply posted");

    const argv = await h.argvSeen("C01", trigger.id);
    expect(argv).not.toContain("--skill");
    const appendPrompt = argv[argv.indexOf("--append-system-prompt") + 1];
    expect(appendPrompt).not.toContain("../shared/");
    await expect(stat(join(h.workdirRoot, "C01", "shared"))).rejects.toThrow(
      /ENOENT/,
    );
  });

  it("when every reply file escapes the workdir, files is omitted (raw relative paths are not leaked)", async () => {
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "ALL_ESCAPE_FILES" });

    await h.runner.handle(trigger);

    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    // 全件除外されたら text だけの投稿になり、agent の渡した生の相対パスが
    // poster へ漏れない (境界チェックの素通り防止)
    expect(h.poster.calls[0]?.files).toBeUndefined();

    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");
  });

  it("a reply file that is a symlink escaping the workdir is dropped even though its path stays inside", async () => {
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "SYMLINK_FILE" });

    await h.runner.handle(trigger);

    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    // fake-pi は workdir 内に evil.txt -> /etc/passwd の symlink を作って渡す。
    // パス文字列上は workdir 内に見えるが、実体は workdir 外なので除外される
    expect(h.poster.calls[0]?.files).toBeUndefined();

    const warnings = h
      .logLines()
      .filter(
        (l) =>
          l.msg === "reply file is a symlink or not a regular file; dropped",
      );
    expect(warnings.map((w) => w.path)).toEqual(["evil.txt"]);

    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");
  });

  it("mentionFormat に Slack の記法を渡すと、system prompt にその記法の説明が含まれる", async () => {
    const h = await harness({}, { mentionFormat: (id) => `<@${id}>` });
    const trigger = message({
      mentionsBot: true,
      text: "mention format default",
    });

    await h.runner.handle(trigger);
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

    const argv = await h.argvSeen("C01", trigger.id);
    const idx = argv.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThanOrEqual(0);
    const systemPrompt = argv[idx + 1] ?? "";
    expect(systemPrompt).toContain("<@USER_ID>");
  });

  it("mentionFormat を注入すると、system prompt にその記法が反映される", async () => {
    const h = await harness({}, { mentionFormat: (id) => `@${id}` });
    const trigger = message({
      mentionsBot: true,
      text: "mention format custom",
    });

    await h.runner.handle(trigger);
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

    const argv = await h.argvSeen("C01", trigger.id);
    const idx = argv.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThanOrEqual(0);
    const systemPrompt = argv[idx + 1] ?? "";
    expect(systemPrompt).toContain("@USER_ID");
    expect(systemPrompt).not.toContain("<@USER_ID>");
  });

  it("logs turn usage aggregated from agent_end.messages", async () => {
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "usage please" });

    await h.runner.handle(trigger);
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

    const usageLogs = h.logLines().filter((line) => line.msg === "turn usage");
    expect(usageLogs).toHaveLength(1);
    expect(usageLogs[0]).toMatchObject({
      input: 100,
      output: 50,
      cacheRead: 10,
      cacheWrite: 5,
      totalTokens: 150,
      costTotal: 0.01,
    });

    // session finished ログにも累計 usage の一部が載る
    const finishedLogs = h
      .logLines()
      .filter((line) => line.msg === "session finished");
    expect(finishedLogs).toHaveLength(1);
    expect(finishedLogs[0]).toMatchObject({
      totalTokens: 150,
      costTotal: 0.01,
      cacheRead: 10,
    });
  });

  it("does not react nor spawn when the gate rejects (default = mention only)", async () => {
    const h = await harness();
    await h.runner.handle(message({ text: "no mention here" }));

    expect(h.runner.activeSessionCount).toBe(0);
    expect(h.poster.calls).toEqual([]);
    expect(h.reactions).toEqual([]);
  });

  it("keyword gate from ChannelDoc triggers without a mention", async () => {
    const h = await harness({
      C01: {
        trigger: {
          when: [{ kind: "keyword", pattern: "[Hh]elp" }],
        },
      },
    });
    const trigger = message({ text: "help me please" });

    await h.runner.handle(trigger);

    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");
  });

  it("DM without a 'dm' ChannelDoc never spawns a session (default = disabled)", async () => {
    const h = await harness();
    const trigger = message({
      conversation: { channelId: "D01", isDm: true },
      text: "hi there, no mention",
    });

    await h.runner.handle(trigger);

    expect(h.runner.activeSessionCount).toBe(0);
    expect(h.poster.calls).toEqual([]);
  });

  it("reserved 'dm' ChannelDoc overrides the DM default (passthrough trigger)", async () => {
    const h = await harness({
      dm: {
        trigger: { when: [{ kind: "passthrough" }] },
      },
    });
    const trigger = message({
      conversation: { channelId: "D01", isDm: true },
      text: "hi there, no mention",
    });

    await h.runner.handle(trigger);

    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    // DM は既定 session: channel, reply: flat (session-model.md §3) なので、
    // スレッド外トリガーの返信先はチャンネル直下 (threadTs 無し) になる
    expect(h.poster.calls[0]).toEqual({
      channelId: "D01",
      text: `echo: ${renderEvent(trigger, replyThreadKeyOf(trigger))}`,
    });
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");
  });

  it("injects ChannelDoc.context into the first prompt only", async () => {
    const h = await harness({
      C01: { context: ["CONTEXT-NOTE"] },
    });
    const trigger = message({ mentionsBot: true, text: "with context" });

    await h.runner.handle(trigger);
    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

    const commands = await h.commandsLog("C01", trigger.id);
    const prompt = JSON.parse(commands[0] ?? "{}");
    expect(prompt.message).toContain("CONTEXT-NOTE");
    expect(prompt.message).toContain(trigger.text);
  });

  it("delivers follow-up messages to the running pi as a steer command", async () => {
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "WAIT_FOR_STEER" });
    const threadTs = trigger.id;

    await h.runner.handle(trigger);
    await waitFor(async () => {
      try {
        return (await h.commandsLog("C01", threadTs)).length >= 1;
      } catch {
        return false;
      }
    }, "initial prompt recorded");

    // スレッド内の追いメッセージ。mention なしでも gate を通さず同じ inbox へ
    const followUp = message({
      id: "1700000000.000200",
      conversation: { channelId: "C01", threadTs },
      text: "追加の指示です",
    });
    await h.runner.handle(followUp);

    await waitFor(() => h.poster.calls.length === 1, "steered reply posted");
    expect(h.poster.calls[0]?.text).toBe(
      `steered: ${renderEvent(followUp, replyThreadKeyOf(followUp))}`,
    );
    expect(h.poster.calls[0]?.threadTs).toBe(threadTs);

    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");
    const commands = (await h.commandsLog("C01", threadTs)).map((line) =>
      JSON.parse(line),
    );
    expect(commands.map((c) => c.type)).toEqual(["prompt", "steer"]);
    expect(commands[1]?.message).toBe(
      renderEvent(followUp, replyThreadKeyOf(followUp)),
    );

    // steer 済み item も flush → ack でまとめて確定される
    expect(await h.store.inbox.drain(threadKeyOf(trigger))).toEqual([]);
  });

  it("channel モード (session.mode: channel) では、スレッド外の 2 つ目のメッセージが新セッションでなく同一セッションへの steer になる", async () => {
    const h = await harness({
      C01: { session: { mode: "channel" } },
    });
    const trigger = message({ mentionsBot: true, text: "WAIT_FOR_STEER" });

    await h.runner.handle(trigger);
    await waitFor(async () => {
      try {
        return (await h.commandsLog("C01", "channel")).length >= 1;
      } catch {
        return false;
      }
    }, "initial prompt recorded");
    expect(h.runner.activeSessionCount).toBe(1);

    // トリガーと同じスレッド外 (threadTs 無し) の 2 件目。session.mode: channel
    // なので sessionKey は channelId のみで揃い、同一セッションへの steer になる
    // (session-model.md §3)
    const second = message({
      id: "1700000000.000250",
      conversation: { channelId: "C01" },
      text: "追加の指示です (channel モード)",
    });
    await h.runner.handle(second);

    // 新規セッションが増えていない (同一セッションへの steer)
    expect(h.runner.activeSessionCount).toBe(1);

    await waitFor(() => h.poster.calls.length === 1, "steered reply posted");
    // reply.mode の既定は thread なので、スレッド外トリガーの返信は
    // メッセージごとに新しいスレッドを起こす (thread_key = channelId:second.id)
    expect(h.poster.calls[0]?.threadTs).toBe(second.id);
    expect(h.poster.calls[0]?.text).toBe(
      `steered: ${renderEvent(second, replyThreadKeyOf(second))}`,
    );

    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");
    const commands = (await h.commandsLog("C01", "channel")).map((line) =>
      JSON.parse(line),
    );
    expect(commands.map((c) => c.type)).toEqual(["prompt", "steer"]);
  });

  it("session.idleResetMinutes (channel モード): 前回活動から idle 超過していたら transcript を世代交代する", async () => {
    const h = await harness({
      C01: { session: { mode: "channel", idleResetMinutes: 1 } },
    });
    const sessionKey = "C01";
    const workdir = join(h.workdirRoot, "C01", "channel");

    // 事前に workdir と session.jsonl、および 10 分前の SessionDoc を用意する
    // (前回セッションが idle 期間を超えて放置された状態を模す)
    await mkdir(workdir, { recursive: true });
    await writeFile(join(workdir, "session.jsonl"), "OLD TRANSCRIPT\n");
    await h.store.sessions.put(sessionKey, {
      channelId: "C01",
      threadTs: "channel",
      triggerTs: "1699999999.000000",
      status: "finished",
      updatedAt: new Date(Date.now() - 10 * 60_000),
    });

    const trigger = message({ mentionsBot: true, text: "idle reset please" });
    await h.runner.handle(trigger);
    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

    const entries = await readdir(workdir);
    expect(entries).toContain("commands.jsonl");
    expect(entries.some((name) => /^session-\d+\.jsonl$/.test(name))).toBe(
      true,
    );
    expect(entries).not.toContain("session.jsonl");

    expect(
      h
        .logLines()
        .some((line) => line.msg === "idle reset: transcript rotated"),
    ).toBe(true);
  });

  it("session.maxTranscriptKb (channel モード): transcript サイズが閾値を超えていたら世代交代する", async () => {
    const h = await harness({
      C01: { session: { mode: "channel", maxTranscriptKb: 1 } },
    });
    const workdir = join(h.workdirRoot, "C01", "channel");

    // 事前に workdir と 2KB 程度の session.jsonl を用意する (閾値 1KB 超過)。
    // size 判定は store に依存しないため SessionDoc の事前 put は不要
    await mkdir(workdir, { recursive: true });
    await writeFile(join(workdir, "session.jsonl"), "x".repeat(2 * 1024));

    const trigger = message({ mentionsBot: true, text: "size reset please" });
    await h.runner.handle(trigger);
    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

    const entries = await readdir(workdir);
    expect(entries.some((name) => /^session-\d+\.jsonl$/.test(name))).toBe(
      true,
    );
    expect(entries).not.toContain("session.jsonl");

    expect(
      h
        .logLines()
        .some((line) => line.msg === "size reset: transcript rotated"),
    ).toBe(true);
  });

  it("session.maxTranscriptKb (channel モード): transcript サイズが閾値未満なら世代交代しない", async () => {
    const h = await harness({
      C01: { session: { mode: "channel", maxTranscriptKb: 10 } },
    });
    const workdir = join(h.workdirRoot, "C01", "channel");

    await mkdir(workdir, { recursive: true });
    await writeFile(join(workdir, "session.jsonl"), "x".repeat(100));

    const trigger = message({ mentionsBot: true, text: "no size reset" });
    await h.runner.handle(trigger);
    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

    const entries = await readdir(workdir);
    expect(entries).toContain("session.jsonl");
    expect(entries.some((name) => /^session-\d+\.jsonl$/.test(name))).toBe(
      false,
    );
  });

  it("/new (idle・gate 通過): rotateRequestedAt が書かれ、ack が配送され、pi は起動しない", async () => {
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "/new" });

    await h.runner.handle(trigger);

    await waitFor(() => h.poster.calls.length === 1, "ack posted");
    expect(h.poster.calls[0]?.text).toBe(
      ":new: 次のメッセージから新しいセッションを開始します",
    );

    const sessionKey = threadKeyOf(trigger);
    const doc = await h.store.sessions.get(sessionKey);
    expect(doc?.rotateRequestedAt).toBeInstanceOf(Date);
    expect(doc?.status).toBe("finished");

    // pi は起動していない (セッションは走らず、inbox にも item は積まれない)
    expect(h.runner.activeSessionCount).toBe(0);
    expect(await h.store.inbox.drain(sessionKey)).toEqual([]);

    // lease は解放済み (直後に acquire できる)
    expect(
      await h.store.leases.acquire(sessionKey, "probe", 1000),
    ).not.toBeNull();
  });

  it("/new 実行中 (同一インスタンスに record あり): 拒否通知が配送され、実行中セッションに steer されない", async () => {
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "WAIT_FOR_STEER" });
    await h.runner.handle(trigger);
    await waitFor(() => h.runner.activeSessionCount === 1, "session running");

    const sessionKey = threadKeyOf(trigger);
    const newCmd = message({
      id: "1700000001.000200",
      conversation: { channelId: "C01", threadTs: trigger.id },
      mentionsBot: true,
      text: "/new",
      metadata: { eventId: "Ev-new-cmd" },
    });
    await h.runner.handle(newCmd);

    await waitFor(() => h.poster.calls.length === 1, "reject notice posted");
    expect(h.poster.calls[0]?.text).toBe(
      ":warning: セッションが実行中のため、いまは /new できません。完了後にもう一度送ってください",
    );

    // マーカーは書かれず、実行中セッションにも steer されていない (commands.jsonl に
    // /new の steer が現れない)
    expect(
      (await h.store.sessions.get(sessionKey))?.rotateRequestedAt,
    ).toBeUndefined();
    await waitFor(async () => {
      const commands = await h.commandsLog("C01", trigger.id).catch(() => []);
      return commands.length > 0;
    }, "initial prompt command logged");
    const commandsBeforeFinish = await h.commandsLog("C01", trigger.id);
    expect(commandsBeforeFinish.some((line) => line.includes("/new"))).toBe(
      false,
    );

    // 元セッションを畳んで後始末する
    const proc = message({
      id: "1700000002.000300",
      conversation: { channelId: "C01", threadTs: trigger.id },
      mentionsBot: true,
      text: "wrap up",
      metadata: { eventId: "Ev-wrap-up" },
    });
    await h.runner.handle(proc);
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");
  });

  it("/new で lease が取れない (事前に別 owner で acquire 済み): 拒否通知", async () => {
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "/new" });
    const sessionKey = threadKeyOf(trigger);
    const heldLease = await h.store.leases.acquire(
      sessionKey,
      "other-owner",
      60_000,
    );
    expect(heldLease).not.toBeNull();

    await h.runner.handle(trigger);

    await waitFor(() => h.poster.calls.length === 1, "reject notice posted");
    expect(h.poster.calls[0]?.text).toBe(
      ":warning: セッションが実行中のため、いまは /new できません。完了後にもう一度送ってください",
    );
    expect(
      (await h.store.sessions.get(sessionKey))?.rotateRequestedAt,
    ).toBeUndefined();
  });

  it("マーカーあり状態で次のメッセージ → kick: transcript が rotate される (channel モード)", async () => {
    const h = await harness({
      C01: { session: { mode: "channel" } },
    });
    const sessionKey = "C01";
    const workdir = join(h.workdirRoot, "C01", "channel");

    await mkdir(workdir, { recursive: true });
    await writeFile(join(workdir, "session.jsonl"), "OLD TRANSCRIPT\n");
    await h.store.sessions.put(sessionKey, {
      channelId: "C01",
      threadTs: "channel",
      triggerTs: "1699999999.000000",
      status: "finished",
      updatedAt: new Date(),
      rotateRequestedAt: new Date(),
    });

    const trigger = message({ mentionsBot: true, text: "hello again" });
    await h.runner.handle(trigger);
    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

    const entries = await readdir(workdir);
    expect(entries.some((name) => /^session-\d+\.jsonl$/.test(name))).toBe(
      true,
    );
    expect(entries).not.toContain("session.jsonl");
    expect(
      h
        .logLines()
        .some((line) => line.msg === "manual reset: transcript rotated"),
    ).toBe(true);
    expect(
      (await h.store.sessions.get(sessionKey))?.rotateRequestedAt,
    ).toBeUndefined();
  });

  it("マーカーあり状態で次のメッセージ → kick: transcript が rotate される (thread モード)", async () => {
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "hello again" });
    const sessionKey = threadKeyOf(trigger);
    const workdir = join(h.workdirRoot, "C01", trigger.id);

    await mkdir(workdir, { recursive: true });
    await writeFile(join(workdir, "session.jsonl"), "OLD TRANSCRIPT\n");
    await h.store.sessions.put(sessionKey, {
      channelId: "C01",
      threadTs: trigger.id,
      triggerTs: trigger.id,
      status: "finished",
      updatedAt: new Date(),
      rotateRequestedAt: new Date(),
    });

    await h.runner.handle(trigger);
    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

    const entries = await readdir(workdir);
    expect(entries.some((name) => /^session-\d+\.jsonl$/.test(name))).toBe(
      true,
    );
    expect(entries).not.toContain("session.jsonl");
    expect(
      h
        .logLines()
        .some((line) => line.msg === "manual reset: transcript rotated"),
    ).toBe(true);
    expect(
      (await h.store.sessions.get(sessionKey))?.rotateRequestedAt,
    ).toBeUndefined();
  });

  it("/new 続きの指示: マーカーが書かれ、kick が走り、初回 prompt に続きの指示が含まれ /new は含まれない", async () => {
    const h = await harness();
    const trigger = message({
      mentionsBot: true,
      text: "/new 続きの指示",
    });

    await h.runner.handle(trigger);
    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

    const sessionKey = threadKeyOf(trigger);
    // マーカーは書き込まれた後、同じ kick 内で消費 (rotate) されクリアされる
    // (session-model.md §6)。消費された痕跡は rotate ログで確認する
    expect(
      h
        .logLines()
        .some((line) => line.msg === "manual reset: transcript rotated"),
    ).toBe(true);
    expect(
      (await h.store.sessions.get(sessionKey))?.rotateRequestedAt,
    ).toBeUndefined();

    const commands = await h.commandsLog("C01", trigger.id);
    const promptCommand = JSON.parse(commands[0] ?? "{}");
    expect(promptCommand.type).toBe("prompt");
    expect(promptCommand.message).toContain("続きの指示");
    expect(promptCommand.message).not.toContain("/new");
  });

  it("gate 非通過の /new (mention なし・mention gate チャンネル): 何も起きない", async () => {
    const h = await harness();
    const trigger = message({ mentionsBot: false, text: "/new" });

    await h.runner.handle(trigger);
    // 非同期の副作用が万一起きても検出できるよう少し待つ
    await sleep(50);

    expect(h.poster.calls).toEqual([]);
    const sessionKey = threadKeyOf(trigger);
    expect(await h.store.sessions.get(sessionKey)).toBeNull();
    expect(h.runner.activeSessionCount).toBe(0);
  });

  it("stays silent but still adds the check reaction when reply is never called", async () => {
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "NO_REPLY please" });

    await h.runner.handle(trigger);

    await waitFor(
      () => h.reactions.some((r) => r.name === "white_check_mark"),
      "check reaction",
    );
    expect(h.poster.calls).toEqual([]);
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");
  });

  it("ignores a duplicate delivery of the same event id while running", async () => {
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "WAIT_FOR_STEER" });
    await h.runner.handle(trigger);
    expect(h.runner.activeSessionCount).toBe(1);

    // 同じ event_id の再送: セッションは増えず、steer もされない
    await h.runner.handle(trigger);
    expect(h.runner.activeSessionCount).toBe(1);

    // 終了させる
    const followUp = message({
      id: "1700000000.000300",
      conversation: { channelId: "C01", threadTs: trigger.id },
      text: "done",
    });
    await h.runner.handle(followUp);
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

    const commands = (await h.commandsLog("C01", trigger.id)).map((line) =>
      JSON.parse(line),
    );
    expect(commands.filter((c) => c.type === "prompt")).toHaveLength(1);
  });

  it("reuses the same workdir when the thread is triggered again", async () => {
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "first" });
    await h.runner.handle(trigger);
    await waitFor(
      () => h.runner.activeSessionCount === 0,
      "first session done",
    );

    const again = message({
      id: "1700000000.000900",
      conversation: { channelId: "C01", threadTs: trigger.id },
      mentionsBot: true,
      text: "second",
    });
    await h.runner.handle(again);
    await waitFor(() => h.poster.calls.length === 2, "second reply posted");
    await waitFor(
      () => h.runner.activeSessionCount === 0,
      "second session done",
    );

    // 同じ workdir の commands.jsonl に両セッションの prompt が積まれている
    const commands = (await h.commandsLog("C01", trigger.id)).map((line) =>
      JSON.parse(line),
    );
    expect(commands.filter((c) => c.type === "prompt")).toHaveLength(2);
  });

  it("logs resumed: true when session.jsonl already exists for the workdir", async () => {
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "first" });
    await h.runner.handle(trigger);
    await waitFor(
      () => h.runner.activeSessionCount === 0,
      "first session done",
    );

    const startedLogs = h
      .logLines()
      .filter((line) => line.msg === "session started");
    expect(startedLogs).toHaveLength(1);
    expect(startedLogs[0]?.resumed).toBe(false);

    // fake-pi は session.jsonl を作らないため、pi が実際に書き出した状態を
    // テスト側で模して置く (session-runtime.md: 再開は同じ --session パスへの
    // 再 spawn だけで実現される)
    await writeFile(
      join(h.workdirRoot, "C01", trigger.id, "session.jsonl"),
      "",
    );

    const again = message({
      id: "1700000000.000901",
      conversation: { channelId: "C01", threadTs: trigger.id },
      mentionsBot: true,
      text: "second",
    });
    await h.runner.handle(again);
    await waitFor(() => h.poster.calls.length === 2, "second reply posted");
    await waitFor(
      () => h.runner.activeSessionCount === 0,
      "second session done",
    );

    const startedLogsAfter = h
      .logLines()
      .filter((line) => line.msg === "session started");
    expect(startedLogsAfter).toHaveLength(2);
    expect(startedLogsAfter[1]?.resumed).toBe(true);
  });

  it("passes extraEnv through to the pi child process", async () => {
    const h = await harness(
      {},
      { extraEnv: { GOOGLE_CLOUD_PROJECT: "my-project" } },
    );
    const trigger = message({ mentionsBot: true, text: "with extra env" });

    await h.runner.handle(trigger);
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

    const env = await h.envSeen("C01", trigger.id);
    expect(env.GOOGLE_CLOUD_PROJECT).toBe("my-project");
  });

  it("常に HOME を agentHome に上書きする (UID 分離の有無にかかわらず)", async () => {
    const h = await harness({}, { agentHome: "/tmp/agent-home-no-uid" });
    const trigger = message({ mentionsBot: true, text: "no uid isolation" });

    await h.runner.handle(trigger);
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

    const env = await h.envSeen("C01", trigger.id);
    // runner は agentHome を realpath で正規化して渡す (macOS の /tmp symlink 対策)
    expect(env.HOME).toBe(await realpath("/tmp/agent-home-no-uid"));
  });

  it("agentHome が存在しなければ作成する (UID 分離なし)", async () => {
    const agentHome = join(
      await mkdtemp(join(tmpdir(), "pi-chat-runner-test-home-")),
      "nested",
      "home",
    );
    const h = await harness({}, { agentHome });
    const trigger = message({ mentionsBot: true, text: "creates agent home" });

    await h.runner.handle(trigger);
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

    const stats = await stat(agentHome);
    expect(stats.isDirectory()).toBe(true);
  });

  it("UID 分離が有効なとき HOME を agentHome に上書きし、workdir と agentHome を chown/chmod する", async () => {
    // root でなくても自分自身の uid/gid への chown は成功するため、実プロセスの
    // uid/gid を使って「UID 分離が有効なコードパスを通す」ことをローカルで検証する
    // (実際に別 uid へ落とす検証は Dockerfile 検証 (docker) で行う)
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid === undefined || gid === undefined) return; // Windows 等では skip
    const agentHome = join(
      await mkdtemp(join(tmpdir(), "pi-chat-runner-test-home-")),
      "agent-home",
    );
    const h = await harness({}, { agentUid: uid, agentGid: gid, agentHome });
    const trigger = message({ mentionsBot: true, text: "uid isolated" });

    await h.runner.handle(trigger);
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

    const env = await h.envSeen("C01", trigger.id);
    expect(env.HOME).toBe(await realpath(agentHome));

    const stats = await stat(join(h.workdirRoot, "C01", trigger.id));
    expect(stats.uid).toBe(uid);
    expect(stats.gid).toBe(gid);
    expect(stats.mode & 0o777).toBe(0o700);

    const homeStats = await stat(agentHome);
    expect(homeStats.uid).toBe(uid);
    expect(homeStats.gid).toBe(gid);
    expect(homeStats.mode & 0o777).toBe(0o700);
  });

  it("permissionMode が無効でも検出済み entrypoint を node で起動する", async () => {
    const previousPiBin = process.env.PI_BIN;
    delete process.env.PI_BIN;
    try {
      const h = await harness(
        {},
        {
          piEntrypoint: FAKE_PI,
        },
      );
      const trigger = message({
        mentionsBot: true,
        text: "entrypoint without permission model",
      });

      await h.runner.handle(trigger);

      await waitFor(() => h.poster.calls.length === 1, "reply posted");
      expect(h.poster.calls[0]?.text).toBe(
        `echo: ${renderEvent(trigger, replyThreadKeyOf(trigger))}`,
      );
      await waitFor(() => h.runner.activeSessionCount === 0, "session removed");
    } finally {
      if (previousPiBin === undefined) {
        delete process.env.PI_BIN;
      } else {
        process.env.PI_BIN = previousPiBin;
      }
    }
  });

  it("Node Permission Model が有効なとき node --permission 経由で pi (fake-pi) を起動する", async () => {
    // permission 指定時は entrypoint を直接 node で起動するため、piBinary は
    // 使われない (buildSpawnCommand の仕様)。fake-pi.mjs 自体を entrypoint に
    // 見立て、workdir/node_modules への read/write と extension ディレクトリへの
    // read (appDir 包括許可の廃止に伴い kick() が自動で積む) を許可した状態でも
    // 通常のセッションと同じく reply → agent_end まで動くことを確認する
    const h = await harness(
      {},
      {
        piPermission: {
          entrypoint: FAKE_PI,
          nodeModulesDir: join(process.cwd(), "node_modules"),
        },
      },
    );
    const trigger = message({
      mentionsBot: true,
      text: "permission model isolated",
    });

    await h.runner.handle(trigger);

    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    expect(h.poster.calls[0]?.text).toBe(
      `echo: ${renderEvent(trigger, replyThreadKeyOf(trigger))}`,
    );
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");
  });

  // extension ディレクトリへの --allow-fs-read 自動付与 (appDir 廃止の代替、
  // kick() 内の extensionReadDirs 導出) は、実際に node へ渡る CLI フラグ
  // (--permission/--allow-fs-read) であって fake-pi.mjs 自身の process.argv には
  // 現れない (Node が解釈して消費するランタイムフラグのため) ため、この
  // integration test からは観測できない。fake-pi は --extension を読み込みも
  // しないので、grant の有無で fake-pi の挙動が変わることもない。
  // 導出ロジック自体の検証は runtime.test.ts の buildPiPermissionOptions
  // 「appends extraRead paths when specified (e.g. GOOGLE_APPLICATION_CREDENTIALS,
  // extension dirs)」でカバーする。ここでは extension dirs 込みの extraRead を
  // 積んだ状態でも実際に Permission Model 下で pi (fake-pi) が起動し reply まで
  // 到達すること (上のテスト) をもって、配線が壊れていないことの回帰保護とする

  // bot 投稿の gate 起動 (opt-in) — session-model.md §5
  it("bot 投稿は既定 (allowBots なし) では起動しない (when がマッチしても捨てる)", async () => {
    const h = await harness({
      C01: {
        trigger: {
          when: [{ kind: "keyword", pattern: "ALERT" }],
        },
      },
    });
    const trigger = message({
      sender: { id: "B01", isBot: true, isSelf: false },
      text: "ALERT: disk full",
    });

    await h.runner.handle(trigger);
    await sleep(50);

    expect(h.poster.calls).toEqual([]);
    expect(h.runner.activeSessionCount).toBe(0);
    expect(
      h
        .logLines()
        .some(
          (line) => line.msg === "bot message ignored (allowBots not enabled)",
        ),
    ).toBe(true);
  });

  it("allowBots: true + and 合成: bot の ALERT 投稿は起動し、人間の同文は sender:bot ノードで弾かれる", async () => {
    const h = await harness({
      C01: {
        trigger: {
          allowBots: true,
          when: [
            {
              and: [
                { kind: "sender", is: "bot" },
                { kind: "keyword", pattern: "ALERT" },
              ],
            },
          ],
        },
      },
    });

    const botTrigger = message({
      sender: { id: "B01", isBot: true, isSelf: false },
      text: "ALERT: disk full",
    });
    await h.runner.handle(botTrigger);
    await waitFor(() => h.poster.calls.length === 1, "bot-triggered reply");
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

    const humanTrigger = message({
      id: "1700000000.000900",
      sender: { id: "U01", isBot: false, isSelf: false },
      text: "ALERT: disk full",
    });
    await h.runner.handle(humanTrigger);
    await sleep(50);

    expect(h.poster.calls.length).toBe(1);
    expect(h.runner.activeSessionCount).toBe(0);
  });

  it("allowBots: true でも bot 送信者の /new はコマンドにならない (通常メッセージとして gate 評価される)", async () => {
    const h = await harness({
      C01: {
        trigger: {
          allowBots: true,
          when: [{ kind: "keyword", pattern: "ALERT" }],
        },
      },
    });
    const trigger = message({
      sender: { id: "B01", isBot: true, isSelf: false },
      text: "/new",
    });

    await h.runner.handle(trigger);
    await sleep(50);

    // when (keyword: ALERT) にマッチしないので何も起きない。/new のコマンド化も
    // されていない (rotateRequestedAt が書かれない・ack も出ない)
    expect(h.poster.calls).toEqual([]);
    expect(h.runner.activeSessionCount).toBe(0);
    const sessionKey = threadKeyOf(trigger);
    expect(await h.store.sessions.get(sessionKey)).toBeNull();
  });

  it("allowBots: true で実行中セッションへの bot 投稿が steer される", async () => {
    const h = await harness({
      C01: { trigger: { allowBots: true, when: [{ kind: "mention" }] } },
    });
    const trigger = message({ mentionsBot: true, text: "WAIT_FOR_STEER" });
    const threadTs = trigger.id;

    await h.runner.handle(trigger);
    await waitFor(async () => {
      try {
        return (await h.commandsLog("C01", threadTs)).length >= 1;
      } catch {
        return false;
      }
    }, "initial prompt recorded");

    const botFollowUp = message({
      id: "1700000001.000200",
      conversation: { channelId: "C01", threadTs },
      sender: { id: "B01", isBot: true, isSelf: false },
      text: "bot follow-up",
    });
    await h.runner.handle(botFollowUp);

    await waitFor(() => h.poster.calls.length === 1, "steered reply posted");
    expect(h.poster.calls[0]?.text).toBe(
      `steered: ${renderEvent(botFollowUp, replyThreadKeyOf(botFollowUp))}`,
    );

    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");
    const commands = (await h.commandsLog("C01", threadTs)).map((line) =>
      JSON.parse(line),
    );
    expect(commands.map((c) => c.type)).toEqual(["prompt", "steer"]);
  });
});

describe("SessionRunner: /enable /disable (channel mute, session-model.md §5)", () => {
  it("@bot /disable (idle): channels store に enabled=false + updatedBy が書かれ、:no_bell: ack が配送される。pi は起動しない", async () => {
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "/disable" });

    await h.runner.handle(trigger);

    await waitFor(() => h.poster.calls.length === 1, "ack posted");
    expect(h.poster.calls[0]?.text).toBe(
      ":no_bell: このチャンネルでの起動を無効化しました。`/enable` (bot へのメンション付き) で再開できます",
    );

    const doc = await h.store.channels.get("C01");
    expect(doc?.enabled).toBe(false);
    expect(doc?.updatedBy).toBe("U01");

    expect(h.runner.activeSessionCount).toBe(0);
  });

  it("disabled 状態で mention メッセージ: 起動しない (poster 呼び出しなし)、info ログ 'channel disabled'", async () => {
    const h = await harness();
    await h.store.channels.put("C01", {
      enabled: false,
      updatedAt: new Date(),
      updatedBy: "U99",
    });

    const trigger = message({ mentionsBot: true, text: "question here" });
    await h.runner.handle(trigger);
    await sleep(50);

    expect(h.poster.calls).toEqual([]);
    expect(h.runner.activeSessionCount).toBe(0);
    expect(
      h
        .logLines()
        .some((line) => String(line.msg ?? "").includes("channel disabled")),
    ).toBe(true);
  });

  it("disabled 状態で @bot /enable: enabled=true になり :bell: ack。その後の mention は通常どおり起動する", async () => {
    const h = await harness();
    await h.store.channels.put("C01", {
      enabled: false,
      updatedAt: new Date(),
      updatedBy: "U99",
    });

    const enableCmd = message({ mentionsBot: true, text: "/enable" });
    await h.runner.handle(enableCmd);

    await waitFor(() => h.poster.calls.length === 1, "enable ack posted");
    expect(h.poster.calls[0]?.text).toBe(
      ":bell: このチャンネルでの起動を有効化しました",
    );
    expect((await h.store.channels.get("C01"))?.enabled).toBe(true);

    const trigger = message({
      id: "1700000001.000200",
      mentionsBot: true,
      text: "question here",
      metadata: { eventId: "Ev-after-enable" },
    });
    await h.runner.handle(trigger);
    await waitFor(() => h.poster.calls.length === 2, "reply posted");
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");
  });

  it("実行中セッションがあるレーンで /disable: ack が返り、以降のメッセージが steer されない。実行中セッション自体は完走する", async () => {
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "WAIT_FOR_STEER" });
    await h.runner.handle(trigger);
    await waitFor(() => h.runner.activeSessionCount === 1, "session running");

    const disableCmd = message({
      id: "1700000001.000200",
      conversation: { channelId: "C01", threadTs: trigger.id },
      mentionsBot: true,
      text: "/disable",
      metadata: { eventId: "Ev-disable-cmd" },
    });
    await h.runner.handle(disableCmd);

    await waitFor(() => h.poster.calls.length === 1, "disable ack posted");
    expect(h.poster.calls[0]?.text).toBe(
      ":no_bell: このチャンネルでの起動を無効化しました。`/enable` (bot へのメンション付き) で再開できます",
    );
    expect((await h.store.channels.get("C01"))?.enabled).toBe(false);

    // disabled 中なので以降のメッセージは steer されない
    const followUp = message({
      id: "1700000002.000300",
      conversation: { channelId: "C01", threadTs: trigger.id },
      mentionsBot: true,
      text: "should not be steered",
      metadata: { eventId: "Ev-follow-up" },
    });
    await h.runner.handle(followUp);
    await sleep(50);
    expect(h.poster.calls.length).toBe(1);

    // 実行中セッション自体は完走する (WAIT_FOR_STEER を解除する追いメッセージが
    // 届かないため、fake-pi へ直接 steer 相当のコマンドは送れない。ここでは
    // セッションが disable 後も生きたままであることだけ確認する)
    expect(h.runner.activeSessionCount).toBe(1);
  });

  it("disabled 状態での reaction 起動: 起動しない", async () => {
    const h = await harness({
      C01: { trigger: { when: [{ kind: "reaction", emoji: ["eyes"] }] } },
    });
    await h.store.channels.put("C01", {
      enabled: false,
      updatedAt: new Date(),
      updatedBy: "U99",
    });

    const target: ReactionEvent = {
      kind: "reaction",
      emoji: "eyes",
      targetMessageId: "1700000000.000300",
      targetIsOwnMessage: false,
      conversation: { channelId: "C01" },
      sender: { id: "U02", isBot: false, isSelf: false },
      added: true,
      timestamp: new Date("2026-07-05T00:00:00Z"),
    };
    const fetch: FetchMessage = async () => ({ text: "should not be used" });
    await h.runner.handleReaction(target, fetch);
    await sleep(50);

    expect(h.runner.activeSessionCount).toBe(0);
    expect(h.poster.calls).toEqual([]);
    expect(
      h
        .logLines()
        .some((line) =>
          String(line.msg ?? "").includes("reaction trigger skipped"),
        ),
    ).toBe(true);
  });

  it("bot 送信者の /disable (allowBots チャンネル): コマンドにならない (状態が変わらない)", async () => {
    const h = await harness({
      C01: {
        trigger: {
          allowBots: true,
          when: [{ kind: "keyword", pattern: "ALERT" }],
        },
      },
    });
    const trigger = message({
      sender: { id: "B01", isBot: true, isSelf: false },
      text: "/disable",
    });

    await h.runner.handle(trigger);
    await sleep(50);

    // when (keyword: ALERT) にマッチしないので何も起きない。/disable のコマンド化も
    // されていないため channels store も変わらない
    expect(h.poster.calls).toEqual([]);
    expect(await h.store.channels.get("C01")).toBeNull();
    expect(h.runner.activeSessionCount).toBe(0);
  });

  it("disabled 状態では classifier gate 自体が呼ばれない (LLM 呼び出しの回避)", async () => {
    const classifierCalls: { criteria: string; text: string }[] = [];
    const classifierClient: ClassifierClient = {
      async classify(input) {
        classifierCalls.push(input);
        return { result: true, reason: "matched" };
      },
    };
    const h = await harness(
      {
        C01: {
          trigger: { when: [{ kind: "classifier", criteria: "anything" }] },
        },
      },
      { classifierClient },
    );
    await h.store.channels.put("C01", {
      enabled: false,
      updatedAt: new Date(),
      updatedBy: "U99",
    });

    const trigger = message({ text: "please do something" });
    await h.runner.handle(trigger);
    await sleep(50);

    expect(classifierCalls).toEqual([]);
    expect(h.runner.activeSessionCount).toBe(0);
    expect(h.poster.calls).toEqual([]);
    expect(
      h
        .logLines()
        .some((line) => String(line.msg ?? "").includes("channel disabled")),
    ).toBe(true);
  });

  it("disabled 状態で @bot /new: drop される (marker 書き込みなし・kick なし・ack なし)", async () => {
    const h = await harness();
    await h.store.channels.put("C01", {
      enabled: false,
      updatedAt: new Date(),
      updatedBy: "U99",
    });

    const trigger = message({ mentionsBot: true, text: "/new" });
    await h.runner.handle(trigger);
    await sleep(50);

    expect(h.poster.calls).toEqual([]);
    expect(h.runner.activeSessionCount).toBe(0);
    const sessionKey = threadKeyOf(trigger);
    expect(await h.store.sessions.get(sessionKey)).toBeNull();
    expect(
      h
        .logLines()
        .some((line) => String(line.msg ?? "").includes("channel disabled")),
    ).toBe(true);
  });

  it("debounce 待機中に /disable → タイマー発火してもセッションが起動しない", async () => {
    vi.useFakeTimers();
    try {
      const h = await harness({
        C01: {
          trigger: {
            when: [{ kind: "passthrough" }],
            debounceSec: 0.2,
          },
        },
      });

      const trigger = message({ text: "hello there" });
      await h.runner.handle(trigger);

      // debounce 待機中に /disable する (mention 付きなのでバイパスされず即時反映)
      const disableCmd = message({
        id: "1700000001.000200",
        mentionsBot: true,
        text: "/disable",
        metadata: { eventId: "Ev-disable-cmd" },
      });
      await h.runner.handle(disableCmd);
      expect((await h.store.channels.get("C01"))?.enabled).toBe(false);

      // debounce タイマーを進める
      await vi.advanceTimersByTimeAsync(500);
      // マイクロタスク経由の非同期処理 (isChannelDisabled 等) を流し切る
      await vi.runAllTimersAsync();

      expect(h.runner.activeSessionCount).toBe(0);
      expect(
        h
          .logLines()
          .some((line) =>
            String(line.msg ?? "").includes("debounced kick skipped"),
          ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SessionRunner.handleReaction (reaction trigger for initial kick)", () => {
  function reaction(overrides: Partial<ReactionEvent> = {}): ReactionEvent {
    return {
      kind: "reaction",
      emoji: "eyes",
      targetMessageId: "1700000000.000300",
      targetIsOwnMessage: false,
      conversation: { channelId: "C01" },
      sender: { id: "U02", isBot: false, isSelf: false },
      added: true,
      timestamp: new Date("2026-07-05T00:00:00Z"),
      ...overrides,
    };
  }

  function fetchReturning(result: FetchedMessage | null): {
    fetch: FetchMessage;
    calls: [string, string][];
  } {
    const calls: [string, string][] = [];
    const fetch: FetchMessage = async (channelId, ts) => {
      calls.push([channelId, ts]);
      return result;
    };
    return { fetch, calls };
  }

  it("reaction gate match + fetch success kicks a session with the fetched text", async () => {
    const h = await harness({
      C01: { trigger: { when: [{ kind: "reaction", emoji: ["eyes"] }] } },
    });
    const { fetch } = fetchReturning({ text: "question from reaction" });
    const target = reaction();

    await h.runner.handleReaction(target, fetch);

    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    expect(h.poster.calls[0]?.text).toContain("question from reaction");
    expect(h.poster.calls[0]?.channelId).toBe("C01");
    expect(h.poster.calls[0]?.threadTs).toBe(target.targetMessageId);

    await waitFor(
      () => h.reactions.some((r) => r.name === "white_check_mark"),
      "check reaction",
    );
    expect(h.reactions[0]).toMatchObject({
      name: "eyes",
      timestamp: target.targetMessageId,
    });

    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");
  });

  it("reaction gate mismatch: fetch is never called and no session is kicked", async () => {
    const h = await harness({
      C01: { trigger: { when: [{ kind: "reaction", emoji: ["tada"] }] } },
    });
    const { fetch, calls } = fetchReturning({ text: "should not be used" });
    const target = reaction({ emoji: "eyes" });

    await h.runner.handleReaction(target, fetch);
    // gate 非一致は同期的に return するはずだが、念のため少し待って非発火を確認する
    await sleep(50);

    expect(calls).toEqual([]);
    expect(h.runner.activeSessionCount).toBe(0);
    expect(h.poster.calls).toEqual([]);
  });

  it("fetch returning null does not kick a session (target message not found)", async () => {
    const h = await harness({
      C01: { trigger: { when: [{ kind: "reaction", emoji: ["eyes"] }] } },
    });
    const { fetch } = fetchReturning(null);
    const target = reaction();

    await h.runner.handleReaction(target, fetch);
    await sleep(50);

    expect(h.runner.activeSessionCount).toBe(0);
    expect(h.poster.calls).toEqual([]);
    expect(
      h
        .logLines()
        .some((line) =>
          String(line.msg ?? "").includes("reaction target message not found"),
        ),
    ).toBe(true);
  });

  it("fetched.threadTs lands the synthetic message's sessionKey/reply on the parent thread", async () => {
    const h = await harness({
      C01: { trigger: { when: [{ kind: "reaction", emoji: ["eyes"] }] } },
    });
    const parentThreadTs = "1700000000.000050";
    const { fetch } = fetchReturning({
      text: "reply from a thread",
      threadTs: parentThreadTs,
    });
    const target = reaction({ targetMessageId: "1700000000.000300" });

    await h.runner.handleReaction(target, fetch);

    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    // reply 宛先は fetched.threadTs (親スレッド) — targetMessageId 単独ではない
    expect(h.poster.calls[0]?.threadTs).toBe(parentThreadTs);

    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");
    // sessionKey = channelId:threadTs (fetched.threadTs 転写が効いている証跡として
    // そのキーで workdir が作られ、inbox が空になっていることを確認する)
    const sessionKey = `C01:${parentThreadTs}`;
    expect(await h.store.inbox.drain(sessionKey)).toEqual([]);
    expect(
      await h.store.leases.acquire(sessionKey, "probe", 1000),
    ).not.toBeNull();
  });

  it("reaction 起動が過去セッションと同じ sessionKey に着地すると、棚の transcript が restore されて resumed:true になる (実質再開)", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "pi-chat-runner-test-shelf-"));
    const storage = new CopyWorkdirStorage(baseDir);
    const h = await harness(
      {
        C01: { trigger: { when: [{ kind: "reaction", emoji: ["eyes"] }] } },
      },
      { workdirStorage: storage },
    );
    const threadTs = "1700000000.000050";

    // 過去セッションの棚 (baseDir/C01/<threadTs>/session.jsonl) を事前に用意する。
    // workdirRoot 側には何も置かない (コールドスタートを模す — 731 行目のテストは
    // workdirRoot に直接置くが、こちらは棚経由の restore だけで再開が成立することを見る)
    const shelfDir = join(baseDir, "C01", threadTs);
    await mkdir(shelfDir, { recursive: true });
    await writeFile(join(shelfDir, "session.jsonl"), "PAST TRANSCRIPT\n");

    const { fetch } = fetchReturning({ text: "continue please", threadTs });
    const target = reaction({ targetMessageId: "1700000000.000300" });

    await h.runner.handleReaction(target, fetch);

    await waitFor(
      () => h.logLines().some((line) => line.msg === "session started"),
      "session started logged",
    );
    const startedLogs = h
      .logLines()
      .filter((line) => line.msg === "session started");
    expect(startedLogs).toHaveLength(1);
    // 命題の核心: 棚からの restore によって pi が既存 transcript を検出し、
    // resumed:true として起動している (同一インスタンス内で workdir に直接ファイルを
    // 置く既存テストとは異なり、棚経由の restore だけで再開が成立する)
    expect(startedLogs[0]?.resumed).toBe(true);

    // workdir にも棚の内容が復元されている
    const restored = await readFile(
      join(h.workdirRoot, "C01", threadTs, "session.jsonl"),
      "utf-8",
    );
    expect(restored).toContain("PAST TRANSCRIPT");

    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    expect(h.poster.calls[0]?.threadTs).toBe(threadTs);

    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");
  });

  it("棚に transcript が無ければ resumed:false (新規セッション、再開ではない)", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "pi-chat-runner-test-shelf-"));
    const storage = new CopyWorkdirStorage(baseDir);
    const h = await harness(
      {
        C01: { trigger: { when: [{ kind: "reaction", emoji: ["eyes"] }] } },
      },
      { workdirStorage: storage },
    );
    const threadTs = "1700000000.000060";
    const { fetch } = fetchReturning({ text: "fresh start please", threadTs });
    const target = reaction({ targetMessageId: "1700000000.000300" });

    await h.runner.handleReaction(target, fetch);

    await waitFor(
      () => h.logLines().some((line) => line.msg === "session started"),
      "session started logged",
    );
    const startedLogs = h
      .logLines()
      .filter((line) => line.msg === "session started");
    expect(startedLogs).toHaveLength(1);
    expect(startedLogs[0]?.resumed).toBe(false);

    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");
  });
});

describe("SessionRunner (Step 4: lease / flush-ack / linger)", () => {
  it("flushes the workdir before acking inbox items (flush → ack order)", async () => {
    const calls: string[] = [];
    class RecordingStorage implements WorkdirStorage {
      async restore(): Promise<boolean> {
        calls.push("restore");
        return false;
      }
      async flush(): Promise<void> {
        calls.push("flush");
      }
    }
    const store = new InMemoryStateStore();
    const originalAck = store.inbox.ack.bind(store.inbox);
    store.inbox.ack = async (threadKey, itemIds) => {
      calls.push(`ack:${itemIds.length}`);
      await originalAck(threadKey, itemIds);
    };

    const h = await harness(
      {},
      { store, workdirStorage: new RecordingStorage() },
    );
    const trigger = message({ mentionsBot: true, text: "flush order" });
    await h.runner.handle(trigger);
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

    // kick で restore、agent_end で flush → ack の順 (persistence.md §3)
    expect(calls).toEqual(["restore", "flush", "ack:1"]);
    expect(await h.store.inbox.drain(threadKeyOf(trigger))).toEqual([]);
  });

  it("shared の restore/flush は workdir と同じ境界で走り、flush は ack より前 (docs/design/shared.md §2)", async () => {
    const calls: string[] = [];
    class RecordingWorkdir implements WorkdirStorage {
      async restore(): Promise<boolean> {
        calls.push("restore");
        return false;
      }
      async flush(): Promise<void> {
        calls.push("flush");
      }
    }
    class RecordingShared implements SharedStorage {
      async restore(): Promise<void> {
        calls.push("shared-restore");
      }
      async flush(): Promise<void> {
        calls.push("shared-flush");
      }
    }
    const store = new InMemoryStateStore();
    const originalAck = store.inbox.ack.bind(store.inbox);
    store.inbox.ack = async (threadKey, itemIds) => {
      calls.push(`ack:${itemIds.length}`);
      await originalAck(threadKey, itemIds);
    };

    const h = await harness(
      {},
      {
        store,
        workdirStorage: new RecordingWorkdir(),
        sharedStorage: new RecordingShared(),
      },
    );
    const trigger = message({ mentionsBot: true, text: "shared flush order" });
    await h.runner.handle(trigger);
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

    expect(calls).toEqual([
      "restore",
      "shared-restore",
      "flush",
      "shared-flush",
      "ack:1",
    ]);
  });

  it("re-kicks the same thread after a failed kick (item is not lost)", async () => {
    // restore を 1 回だけ失敗させて kick を落とす (kick 失敗 = ack されないので
    // inbox に残り、次のイベントで拾い直される。persistence.md §4 の穴の解消)
    class FailOnceStorage implements WorkdirStorage {
      private failed = false;
      async restore(): Promise<boolean> {
        if (!this.failed) {
          this.failed = true;
          throw new Error("restore boom");
        }
        return false;
      }
      async flush(): Promise<void> {}
    }
    const h = await harness({}, { workdirStorage: new FailOnceStorage() });
    const trigger = message({ mentionsBot: true, text: "first try" });
    const threadKey = threadKeyOf(trigger);

    await h.runner.handle(trigger);
    expect(h.runner.activeSessionCount).toBe(0);
    expect(
      h.logLines().some((line) => line.msg === "session kick failed"),
    ).toBe(true);
    // item は ack されず inbox に残っている
    expect((await h.store.inbox.drain(threadKey)).length).toBe(1);

    // 同スレッドの次のイベントで再 kick され、両方の item が拾い直される
    const retry = message({
      id: "1700000000.000400",
      conversation: { channelId: "C01", threadTs: trigger.id },
      mentionsBot: true,
      text: "second try",
    });
    await h.runner.handle(retry);
    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    expect(h.poster.calls[0]?.text).toContain("first try");
    expect(h.poster.calls[0]?.text).toContain("second try");
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");
  });

  it("does not kick when the lease is held by another owner", async () => {
    const store = new InMemoryStateStore();
    const trigger = message({ mentionsBot: true, text: "contended" });
    const threadKey = threadKeyOf(trigger);
    const other = await store.leases.acquire(threadKey, "other:999", 60_000);
    expect(other).not.toBeNull();

    const h = await harness({}, { store });
    await h.runner.handle(trigger);

    // kick されない (eyes も付かない) が、item は enqueue 済みで保持者の drain が拾える
    expect(h.runner.activeSessionCount).toBe(0);
    expect(h.reactions).toEqual([]);
    expect((await store.inbox.drain(threadKey)).length).toBe(1);
    expect(
      h
        .logLines()
        .some(
          (line) => line.msg === "lease held by another process; enqueued only",
        ),
    ).toBe(true);
  });

  it("picks up an item enqueued during linger in the same process, then releases the lease", async () => {
    const h = await harness({}, { lingerMs: 300 });
    const trigger = message({ mentionsBot: true, text: "first turn" });
    const threadKey = threadKeyOf(trigger);

    await h.runner.handle(trigger);
    await waitFor(() => h.poster.calls.length === 1, "first reply posted");

    // agent_end 直後 (linger 窓内) に、handle を経由せず inbox へ直接届いた item を
    // 模す (例: 別インスタンスが enqueue だけした場合)。linger の再 drain が拾う
    await sleep(50);
    const late = message({
      id: "1700000000.000500",
      conversation: { channelId: "C01", threadTs: trigger.id },
      text: "late arrival",
    });
    await h.store.inbox.enqueue(threadKey, {
      id: inboxItemId(late),
      event: late,
      enqueuedAt: new Date(),
    });

    await waitFor(() => h.poster.calls.length === 2, "linger reply posted");
    expect(h.poster.calls[1]?.text).toBe(
      `echo: ${renderEvent(late, replyThreadKeyOf(late))}`,
    );
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

    // 同一プロセス (再 spawn なし) で処理されている
    const commands = (await h.commandsLog("C01", trigger.id)).map((line) =>
      JSON.parse(line),
    );
    expect(commands.map((c) => c.type)).toEqual(["prompt", "prompt"]);

    // linger 後に終了し lease が解放されている
    expect(
      await h.store.leases.acquire(threadKey, "probe", 1000),
    ).not.toBeNull();
  });

  it("starts a new turn (prompt, not steer) for a message that arrives during linger via handle()", async () => {
    // linger 中 (agent_end 後、終了処理完了前) に handle() 経由で追いメッセージが
    // 届くケース。アイドルな pi への steer はターンを開始しないため、この窓では
    // enqueue のみで残し、onAgentEnd の promptPending が prompt として拾い直す
    // 必要がある (steer してしまうと pi は宙吊りになり、以降そのレーンが壊れる)
    const h = await harness({}, { lingerMs: 300 });
    const trigger = message({ mentionsBot: true, text: "first turn" });
    const threadKey = threadKeyOf(trigger);

    await h.runner.handle(trigger);
    await waitFor(() => h.poster.calls.length === 1, "first reply posted");

    // linger 窓内 (300ms) に、handle() を経由した追いメッセージを送る
    // (trySteerExisting → 修正前は steer、修正後は enqueue のみ)
    await sleep(50);
    const late = message({
      id: "1700000000.000500",
      conversation: { channelId: "C01", threadTs: trigger.id },
      text: "during linger",
    });
    await h.runner.handle(late);

    await waitFor(() => h.poster.calls.length === 2, "second reply posted");
    expect(h.poster.calls[1]?.text).toBe(
      `echo: ${renderEvent(late, replyThreadKeyOf(late))}`,
    );

    const commands = (await h.commandsLog("C01", trigger.id)).map((line) =>
      JSON.parse(line),
    );
    // 2 件とも prompt (steer ではない) — 新ターンとして開始されたことを示す
    expect(commands.map((c) => c.type)).toEqual(["prompt", "prompt"]);

    expect(h.logLines().some((line) => line.msg === "session continued")).toBe(
      true,
    );
    expect(h.logLines().some((line) => line.msg === "session steered")).toBe(
      false,
    );

    // 宙吊りにならず、最終的にセッションが終了する
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");
    expect(h.logLines().some((line) => line.msg === "session finished")).toBe(
      true,
    );

    // lease が解放されている
    expect(
      await h.store.leases.acquire(threadKey, "probe", 1000),
    ).not.toBeNull();
  });

  it("cleans up and releases the lease when pi responds with success:false", async () => {
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "FAIL_PROMPT please" });
    const threadKey = threadKeyOf(trigger);

    await h.runner.handle(trigger);

    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

    // pi command failed が異常終了として処理されていること
    expect(h.logLines().some((line) => line.msg === "pi command failed")).toBe(
      true,
    );
    expect(h.logLines().some((line) => line.msg === "session failed")).toBe(
      true,
    );

    // lease は解放されている
    expect(
      await h.store.leases.acquire(threadKey, "probe", 1000),
    ).not.toBeNull();

    // エラー通知がスレッドへ投稿されている (router.deliver 経由)
    expect(h.poster.calls).toHaveLength(1);
    expect(h.poster.calls[0]?.channelId).toBe("C01");
    expect(h.poster.calls[0]?.threadTs).toBe(trigger.id);
    expect(h.poster.calls[0]?.text).toContain(
      "No API key found for google-vertex",
    );

    // command failed (認証エラー等) はこのターンの入力を ack して捨てる (retry しない。
    // session-model.md §6)。捨てないと未 ack のまま次の新規イベントの drain が巻き込み、
    // 同じ入力で再び失敗するループになりうる。flush はしない (workdir は退避させない)
    expect((await h.store.inbox.drain(threadKey)).length).toBe(0);

    // 異常終了はトリガーメッセージへの ❌ で見える化する
    expect(
      h.reactions.some((r) => r.name === "x" && r.timestamp === trigger.id),
    ).toBe(true);
  });

  it("drops the prompted item when pi crashes (process exit while running)", async () => {
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "CRASH_NOW please" });
    const threadKey = threadKeyOf(trigger);

    await h.runner.handle(trigger);

    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

    // running のまま exit したので異常終了として処理されていること
    expect(
      h.logLines().some((line) => line.msg === "pi exited unexpectedly"),
    ).toBe(true);

    // lease は解放されている
    expect(
      await h.store.leases.acquire(threadKey, "probe", 1000),
    ).not.toBeNull();

    // クラッシュは workdir/transcript の破損を疑うため、このターンの入力は ack して
    // 捨てる (retry しない。session-model.md §6)。捨てないと次の新規イベントの drain が
    // 巻き込んで同じ状態から再 spawn し、決定的に再クラッシュしうる
    expect((await h.store.inbox.drain(threadKey)).length).toBe(0);

    // クラッシュはユーザーから見えないので ❌ で見える化する
    expect(
      h.reactions.some((r) => r.name === "x" && r.timestamp === trigger.id),
    ).toBe(true);
  });

  it("kills pi and cleans up the session when a turn exceeds turnTimeoutMs", async () => {
    // fake-pi の HANG_FOREVER は response も agent_end も返さない。runner が
    // turnTimeoutMs (ここでは短く 100ms) 超過を検知して kill し、セッションを
    // 異常終了として畳むことを確認する (session-runtime.md §6)
    const h = await harness({}, { turnTimeoutMs: 100 });
    const trigger = message({ mentionsBot: true, text: "HANG_FOREVER please" });
    const threadKey = threadKeyOf(trigger);

    await h.runner.handle(trigger);

    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

    expect(h.logLines().some((line) => line.msg === "turn timed out")).toBe(
      true,
    );
    expect(h.logLines().some((line) => line.msg === "session timed out")).toBe(
      true,
    );

    // lease は解放されている
    expect(
      await h.store.leases.acquire(threadKey, "probe", 1000),
    ).not.toBeNull();

    // timeout 通知がスレッドへ投稿されている (router.deliver 経由)
    expect(h.poster.calls).toHaveLength(1);
    expect(h.poster.calls[0]?.channelId).toBe("C01");
    expect(h.poster.calls[0]?.threadTs).toBe(trigger.id);
    expect(h.poster.calls[0]?.text).toContain(":warning:");

    // timeout 時は flush も ack もしない — 未 ack の item は inbox に残り、
    // 次の kick で再実行される (session-runtime.md §6 の不変条件)
    expect((await h.store.inbox.drain(threadKey)).length).toBe(1);
  });

  it("does not fire the turn timeout when agent_end arrives before turnTimeoutMs", async () => {
    // 通常のターン (fake-pi は即座に reply → agent_end を返す) では
    // turnTimeoutMs (短く 200ms) が経過してもタイマーは発火しない
    // (onAgentEnd 冒頭でクリアされているため)
    const h = await harness({}, { turnTimeoutMs: 200 });
    const trigger = message({ mentionsBot: true, text: "no timeout here" });

    await h.runner.handle(trigger);
    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

    // タイマーが発火していれば余分に 300ms 待った後もログに残るはずなので、
    // 発火していないことを確認する
    await sleep(300);
    expect(h.logLines().some((line) => line.msg === "turn timed out")).toBe(
      false,
    );
    expect(h.poster.calls).toHaveLength(1);
  });

  it("does not re-prompt items drained at kick when a later drain returns them (promptedIds)", async () => {
    // drain は非破壊なので、kick で prompt 済みの trigger item は ack されるまで
    // (= 最初の agent_end まで) 再 drain に出続ける。steer パスの drain と
    // agent_end の再 drain の両方で、promptedIds による除外が効くことを確認する
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "WAIT_FOR_STEER" });
    await h.runner.handle(trigger);
    await waitFor(async () => {
      try {
        return (await h.commandsLog("C01", trigger.id)).length >= 1;
      } catch {
        return false;
      }
    }, "initial prompt recorded");

    // この時点で trigger item は prompt 済みだが未 ack (agent_end 前)。
    // 追いメッセージの steer では trigger item を除外して配達する
    const followUp = message({
      id: "1700000000.000600",
      conversation: { channelId: "C01", threadTs: trigger.id },
      text: "follow up only",
    });
    await h.runner.handle(followUp);

    await waitFor(() => h.poster.calls.length === 1, "steered reply posted");
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

    const commands = (await h.commandsLog("C01", trigger.id)).map((line) =>
      JSON.parse(line),
    );
    // prompt は kick の 1 回だけ。steer は followUp のみ (trigger の再送なし)
    expect(commands.map((c) => c.type)).toEqual(["prompt", "steer"]);
    expect(commands[1]?.message).toBe(
      renderEvent(followUp, replyThreadKeyOf(followUp)),
    );
    expect(commands[1]?.message).not.toContain("WAIT_FOR_STEER");
  });

  it("progress notice: タイマー発火で実行中のツール名を通知し、初回は新規投稿・以後は同じメッセージを更新する", async () => {
    // fake-pi の SLOW_TOOL は tool_execution_start ("dummy_tool") を吐いた後、
    // steer が届くまで応答を止める。初回投稿のテキストは環境依存 (タイマー初回
    // 発火が tool_execution_start の前か後かで thinking / ツール名入りのどちらにも
    // なり、同一テキストは dedupe されて再送しない) ため固定せず、NEXT_TOOL steer で
    // 2 個目の tool_execution_start を発火させて step カウントを進め、進捗テキストが
    // 必ず変わる状態を作って「2 回目以降は同じ message を更新する」ことを確認する
    // (progress-notice.md)
    const h = await harness({}, { progressNoticeIntervalMs: 30 });
    const trigger = message({ mentionsBot: true, text: "SLOW_TOOL" });

    await h.runner.handle(trigger);

    await waitFor(() => h.poster.calls.length >= 1, "initial progress posted");

    const nextTool = message({
      id: "1700000000.000600",
      conversation: { channelId: "C01", threadTs: trigger.id },
      text: "NEXT_TOOL",
    });
    await h.runner.handle(nextTool);
    await waitFor(
      () =>
        h.poster.updateCalls.some(
          (c) => c.text.includes("dummy_tool") && c.text.includes("sleep 300"),
        ),
      "progress updated with tool name and args preview",
    );

    expect(h.poster.calls).toHaveLength(1);
    // 初回投稿で返された messageId (FakePoster の "msg-1") を以後の update が使う
    expect(h.poster.updateCalls.every((c) => c.messageId === "msg-1")).toBe(
      true,
    );
    const updateCountBeforeReply = h.poster.updateCalls.length;

    // ターンを終わらせる (steer → reply → agent_end)。最終的な reply は
    // 進捗メッセージ (msg-1) への update として届く (新規投稿は増えない)
    const followUp = message({
      id: "1700000000.000700",
      conversation: { channelId: "C01", threadTs: trigger.id },
      text: "wrap it up",
    });
    await h.runner.handle(followUp);
    await waitFor(
      () => h.poster.updateCalls.length > updateCountBeforeReply,
      "final reply merged into progress message",
    );
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

    expect(h.poster.calls).toHaveLength(1);
    expect(h.poster.updateCalls.at(-1)?.messageId).toBe("msg-1");

    // 進捗通知メッセージへの update はターン終了後は増えない
    const updateCountAtEnd = h.poster.updateCalls.length;
    await sleep(90);
    expect(h.poster.updateCalls.length).toBe(updateCountAtEnd);
  });

  it("progress notice: reply 配送後・agent_end 到達前の隙間でタイマーが再発火しない", async () => {
    // progress-notice.md: 進捗タイマーは reply の tool_execution_end 到達時点で
    // 即止める必要がある。agent_end まで待つ実装だと、fake-pi の
    // REPLY_THEN_DELAYED_END が空ける「reply 配送済み・agent_end 未到達」の隙間
    // (500ms) でタイマーが tick し、reply とは別の新規メッセージを投稿してしまう。
    // interval (250ms) は reply 配送 (ほぼ即時) より確実に後ろ、agent_end の遅延
    // (500ms) より確実に手前になるよう選んでいる
    const h = await harness({}, { progressNoticeIntervalMs: 250 });
    const trigger = message({
      mentionsBot: true,
      text: "REPLY_THEN_DELAYED_END",
    });

    await h.runner.handle(trigger);
    // reply は進捗メッセージが既に存在すれば update、無ければ postMessage で
    // 届く (tryUpdateProgress) — どちらのレーンで届くかは環境依存のタイミング次第
    // なので両方を見る
    await waitFor(
      () =>
        h.poster.calls.some((c) => c.text.includes("REPLY_THEN_DELAYED")) ||
        h.poster.updateCalls.some((c) => c.text.includes("REPLY_THEN_DELAYED")),
      "reply posted",
    );
    const newMessageCountAtReply = h.poster.calls.length;

    // fake-pi が agent_end を遅延させている間 (500ms) にタイマーが何度 tick しても、
    // reply 配送後に新規投稿 (postMessage) が増えることはない — 増えるとしたら
    // 既存メッセージへの update のみ
    await sleep(400);
    expect(h.poster.calls).toHaveLength(newMessageCountAtReply);

    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");
  });

  it("progress notice: DM の flat reply はセッションの進捗メッセージを最終回答で上書きする", async () => {
    const h = await harness(
      { dm: { trigger: { when: [{ kind: "passthrough" }] } } },
      { progressNoticeIntervalMs: 30 },
    );
    const trigger = message({
      conversation: { channelId: "D01", isDm: true },
      mentionsBot: false,
      text: "SLOW_TOOL",
    });

    await h.runner.handle(trigger);
    await waitFor(() => h.poster.calls.length >= 1, "initial progress posted");

    const followUp = message({
      id: "1700000000.000701",
      conversation: { channelId: "D01", isDm: true },
      text: "finish it",
    });
    await h.runner.handle(followUp);
    await waitFor(
      () => h.poster.updateCalls.some((c) => c.text.startsWith("steered:")),
      "final reply merged into DM progress message",
    );
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

    expect(h.poster.calls).toHaveLength(1);
    expect(h.poster.updateCalls.at(-1)?.messageId).toBe("msg-1");
  });

  it("progress notice: progressNoticeIntervalMs: 0 で機能を無効化できる", async () => {
    const h = await harness({}, { progressNoticeIntervalMs: 0 });
    const trigger = message({ mentionsBot: true, text: "SLOW_TOOL" });

    await h.runner.handle(trigger);
    await waitFor(async () => {
      try {
        return (await h.commandsLog("C01", trigger.id)).length >= 1;
      } catch {
        return false;
      }
    }, "initial prompt recorded");

    // タイマーが張られていれば dummy_tool の進捗が届くはずの時間だけ待っても、
    // 一切通知されない
    await sleep(90);
    expect(h.poster.calls).toEqual([]);
    expect(h.poster.updateCalls).toEqual([]);

    const followUp = message({
      id: "1700000000.000701",
      conversation: { channelId: "C01", threadTs: trigger.id },
      text: "wrap it up",
    });
    await h.runner.handle(followUp);
    await waitFor(() => h.poster.calls.length === 1, "final reply posted");
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");
  });

  it("trigger.debounceSec: 連投バーストの 2 通が 1 回の kick にまとめられる", async () => {
    const h = await harness({
      C01: {
        trigger: {
          when: [{ kind: "passthrough" }],
          debounceSec: 0.2,
        },
      },
    });
    const first = message({ text: "first burst message" });
    const threadKey = threadKeyOf(first);

    await h.runner.handle(first);
    // debounce 中はまだ kick されていない
    expect(h.runner.activeSessionCount).toBe(0);

    await sleep(50); // debounceSec (200ms) 未満のうちに 2 通目を送る
    const second = message({
      id: "1700000000.000700",
      conversation: { channelId: "C01", threadTs: first.id },
      text: "second burst message",
    });
    await h.runner.handle(second);
    expect(h.runner.activeSessionCount).toBe(0);

    await waitFor(
      () => h.poster.calls.length === 1,
      "reply posted after debounce",
    );
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

    const commands = (await h.commandsLog("C01", first.id)).map((line) =>
      JSON.parse(line),
    );
    // kick は 1 回だけ (prompt 1 件) で、初回 prompt に 2 通とも含まれる
    expect(commands.map((c) => c.type)).toEqual(["prompt"]);
    expect(commands[0]?.message).toContain("first burst message");
    expect(commands[0]?.message).toContain("second burst message");
    expect(await h.store.inbox.drain(threadKey)).toEqual([]);
  });

  it("trigger.debounceSec: 連投バースト A→B→C の 3 通が 1 回の kick にまとめられる", async () => {
    const h = await harness({
      C01: {
        trigger: {
          when: [{ kind: "passthrough" }],
          debounceSec: 0.2,
        },
      },
    });
    const a = message({ text: "message A" });
    const threadKey = threadKeyOf(a);

    await h.runner.handle(a);
    expect(h.runner.activeSessionCount).toBe(0);

    await sleep(50); // debounceSec (200ms) 未満のうちに B を送る (スライドして延長)
    const b = message({
      id: "1700000000.000700",
      conversation: { channelId: "C01", threadTs: a.id },
      text: "message B",
    });
    await h.runner.handle(b);
    expect(h.runner.activeSessionCount).toBe(0);

    await sleep(50); // debounceSec 未満のうちに C を送る (さらにスライド)
    const c = message({
      id: "1700000000.000800",
      conversation: { channelId: "C01", threadTs: a.id },
      text: "message C",
    });
    await h.runner.handle(c);
    expect(h.runner.activeSessionCount).toBe(0);

    await waitFor(
      () => h.poster.calls.length === 1,
      "reply posted after debounce",
    );
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

    const commands = (await h.commandsLog("C01", a.id)).map((line) =>
      JSON.parse(line),
    );
    // kick は 1 回だけ (prompt 1 件) で、初回 prompt に A/B/C 3 通とも含まれる
    expect(commands.map((c) => c.type)).toEqual(["prompt"]);
    expect(commands[0]?.message).toContain("message A");
    expect(commands[0]?.message).toContain("message B");
    expect(commands[0]?.message).toContain("message C");
    expect(await h.store.inbox.drain(threadKey)).toEqual([]);
  });

  it("trigger.debounceSec: mentionsBot のメッセージは debounce をバイパスして即 kick される", async () => {
    const h = await harness({
      C01: {
        trigger: {
          when: [{ kind: "passthrough" }],
          debounceSec: 5,
        },
      },
    });
    const trigger = message({
      mentionsBot: true,
      text: "mention bypasses debounce",
    });

    await h.runner.handle(trigger);

    // debounceSec = 5s だが mentionsBot なので即座に kick される (待たない)
    await waitFor(
      () => h.poster.calls.length === 1,
      "reply posted immediately",
      2000,
    );
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

    const commands = (await h.commandsLog("C01", trigger.id)).map((line) =>
      JSON.parse(line),
    );
    expect(commands.map((c) => c.type)).toEqual(["prompt"]);
  });
});

describe("resolveSessionPolicy", () => {
  it("既定はチャンネル: session=thread, reply=thread", () => {
    expect(resolveSessionPolicy(null, false)).toEqual({
      sessionMode: "thread",
      replyMode: "thread",
    });
  });

  it("既定は DM: session=channel, reply=flat", () => {
    expect(resolveSessionPolicy(null, true)).toEqual({
      sessionMode: "channel",
      replyMode: "flat",
    });
  });

  it("doc の指定が isDm の既定より優先される (DM でも doc 指定が勝つ)", () => {
    expect(
      resolveSessionPolicy(
        { session: { mode: "thread" }, reply: { mode: "thread" } },
        true,
      ),
    ).toEqual({ sessionMode: "thread", replyMode: "thread" });
  });

  it("doc の一部指定のみ上書きし、残りは isDm の既定に従う", () => {
    expect(
      resolveSessionPolicy({ session: { mode: "channel" } }, false),
    ).toEqual({
      sessionMode: "channel",
      replyMode: "thread",
    });
  });
});

describe("sessionKeyOf", () => {
  it("thread モード: threadTs があれば channelId:threadTs", () => {
    expect(
      sessionKeyOf(
        message({ conversation: { channelId: "C01", threadTs: "1699.5" } }),
        THREAD_POLICY,
      ),
    ).toBe("C01:1699.5");
  });

  it("thread モード: threadTs が無ければメッセージ ts で代替する", () => {
    expect(sessionKeyOf(message(), THREAD_POLICY)).toBe(
      "C01:1700000000.000100",
    );
  });

  it("channel モード: threadTs の有無に関わらず channelId のみ", () => {
    const policy: SessionPolicy = { sessionMode: "channel", replyMode: "flat" };
    expect(sessionKeyOf(message(), policy)).toBe("C01");
    expect(
      sessionKeyOf(
        message({ conversation: { channelId: "C01", threadTs: "1699.5" } }),
        policy,
      ),
    ).toBe("C01");
  });
});

describe("replyThreadKeyOf", () => {
  it("常に channelId:threadTs ?? メッセージ ts を返す (sessionMode に関わらない)", () => {
    expect(replyThreadKeyOf(message())).toBe("C01:1700000000.000100");
    expect(
      replyThreadKeyOf(
        message({ conversation: { channelId: "C01", threadTs: "1699.5" } }),
      ),
    ).toBe("C01:1699.5");
  });
});

describe("renderEvent", () => {
  it("shows displayName with the user id when resolved", () => {
    const event = message({
      sender: {
        id: "U123",
        isBot: false,
        isSelf: false,
        displayName: "pokutuna",
      },
      text: "hello",
    });
    expect(renderEvent(event)).toBe(
      "from: pokutuna (U123)\ntime: 2026-07-05T00:00:00.000Z\n---\nhello",
    );
  });

  it("falls back to the bare user id when unresolved", () => {
    const event = message({
      sender: { id: "U123", isBot: false, isSelf: false },
      text: "hello",
    });
    expect(renderEvent(event)).toBe(
      "from: U123\ntime: 2026-07-05T00:00:00.000Z\n---\nhello",
    );
  });

  it("thread_key 指定時は from/time に続けて thread_key を列挙する", () => {
    const event = message({
      sender: { id: "U123", isBot: false, isSelf: false },
      text: "hello",
    });
    expect(renderEvent(event, "C01:1700000000.000100")).toBe(
      "from: U123\ntime: 2026-07-05T00:00:00.000Z\nthread_key: C01:1700000000.000100\n---\nhello",
    );
  });
});

describe("isIdleExpired", () => {
  it("ちょうど idleResetMinutes 分では超過していない (false)", () => {
    const lastUpdatedAt = new Date("2026-07-05T00:00:00Z");
    const now = lastUpdatedAt.getTime() + 5 * 60_000;
    expect(isIdleExpired(lastUpdatedAt, 5, now)).toBe(false);
  });

  it("idleResetMinutes 分を 1ms でも超えたら超過している (true)", () => {
    const lastUpdatedAt = new Date("2026-07-05T00:00:00Z");
    const now = lastUpdatedAt.getTime() + 5 * 60_000 + 1;
    expect(isIdleExpired(lastUpdatedAt, 5, now)).toBe(true);
  });

  it("idleResetMinutes 未満なら超過していない (false)", () => {
    const lastUpdatedAt = new Date("2026-07-05T00:00:00Z");
    const now = lastUpdatedAt.getTime() + 4 * 60_000;
    expect(isIdleExpired(lastUpdatedAt, 5, now)).toBe(false);
  });
});

describe("computeKickDelayMs", () => {
  it("通常ケース: 残り debounceSec 分をそのまま返す (hard cap に届かない)", () => {
    const nowMs = 1_000_000;
    expect(
      computeKickDelayMs({ nowMs, firstPendingAtMs: nowMs, debounceSec: 2 }),
    ).toBe(2000);
  });

  it("後続メッセージでスライドしても、firstPendingAt からの経過が hard cap 未満なら debounceSec 分を返す", () => {
    const firstPendingAtMs = 1_000_000;
    const nowMs = firstPendingAtMs + 3000; // 3s 経過(次の debounceSec=2s も cap=6s 未満)
    expect(
      computeKickDelayMs({ nowMs, firstPendingAtMs, debounceSec: 2 }),
    ).toBe(2000);
  });

  it("hard cap (firstPendingAt + debounceSec*3) を超えて延ばさない", () => {
    const firstPendingAtMs = 1_000_000;
    // cap = firstPendingAtMs + 6000。now が cap の 1000ms 手前なら残りは 1000ms
    // (debounceSec 分の 2000ms を要求しても cap で切られる)
    const nowMs = firstPendingAtMs + 5000;
    expect(
      computeKickDelayMs({ nowMs, firstPendingAtMs, debounceSec: 2 }),
    ).toBe(1000);
  });

  it("残りが 0 未満になるケースは 0 を返す (即 kick)", () => {
    const firstPendingAtMs = 1_000_000;
    const nowMs = firstPendingAtMs + 10_000; // hard cap (6000ms) を過ぎている
    expect(
      computeKickDelayMs({ nowMs, firstPendingAtMs, debounceSec: 2 }),
    ).toBe(0);
  });

  it("firstPendingAtMs と同時刻 (最初のメッセージ) では debounceSec がそのまま残り ms になる", () => {
    const nowMs = 5000;
    expect(
      computeKickDelayMs({ nowMs, firstPendingAtMs: nowMs, debounceSec: 0.5 }),
    ).toBe(500);
  });
});

describe("inboxItemId", () => {
  it("prefers Slack event_id from metadata", () => {
    expect(inboxItemId(message({ metadata: { eventId: "Ev123" } }))).toBe(
      "Ev123",
    );
  });

  it("falls back to message ts when metadata has no eventId", () => {
    expect(inboxItemId(message({ metadata: {} }))).toBe("1700000000.000100");
  });
});
