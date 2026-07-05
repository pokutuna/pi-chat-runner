// SessionRunner の統合テスト。実 Slack・実 LLM の代わりに:
// - pi     → test/fixtures/fake-pi.mjs (stdin の JSONL を記録し、reply/agent_end を吐く)
// - Slack  → FakePoster / FakeReactionClient
// - config → インメモリの ConfigSource
// - store  → InMemoryStateStore (Step 4: lease / drain-ack / linger の検証もここで行う)
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { describe, expect, it } from "vitest";
import type { InboundMessage } from "../../src/ingress/chat-event.js";
import { Reactions } from "../../src/reply/reactions.js";
import { type ChatPoster, ReplyRouter } from "../../src/reply/router.js";
import type { PiPermissionConfig } from "../../src/session/runner.js";
import {
  renderEvent,
  SessionRunner,
  threadKeyOf,
  toGateSpecs,
} from "../../src/session/runner.js";
import type { ChannelDoc } from "../../src/store/channel-doc.js";
import type { ConfigSource } from "../../src/store/config-source.js";
import { inboxItemId } from "../../src/store/inbox-item.js";
import type { StateStore } from "../../src/store/interfaces.js";
import { InMemoryStateStore } from "../../src/store/memory.js";
import type { WorkdirStorage } from "../../src/store/workdir-storage.js";

const FAKE_PI = fileURLToPath(
  new URL("../fixtures/fake-pi.mjs", import.meta.url),
);
const EXTENSION = fileURLToPath(
  new URL("../../extensions/reply.ts", import.meta.url),
);
const PERMISSION_GATE_EXTENSION = fileURLToPath(
  new URL("../../extensions/permission-gate.ts", import.meta.url),
);

class FakePoster implements ChatPoster {
  calls: { channelId: string; threadTs: string; text: string }[] = [];
  async postMessage(channelId: string, threadTs: string, text: string) {
    this.calls.push({ channelId, threadTs, text });
  }
}

class FakeConfigSource implements ConfigSource {
  constructor(private readonly docs: Record<string, ChannelDoc>) {}
  async channel(id: string): Promise<ChannelDoc | null> {
    return this.docs[id] ?? null;
  }
}

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    kind: "message",
    id: "1700000000.000100",
    conversation: { channelId: "C01" },
    sender: { id: "U01", isBot: false },
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
}

interface HarnessOptions {
  extraEnv?: Record<string, string>;
  store?: StateStore;
  workdirStorage?: WorkdirStorage;
  /** テストの実待ちを短くするため既定 30ms (本番既定は 3000ms) */
  lingerMs?: number;
  leaseTtlMs?: number;
  owner?: string;
  piBinary?: string;
  agentUid?: number;
  agentGid?: number;
  agentHome?: string;
  piPermission?: PiPermissionConfig;
}

async function harness(
  docs: Record<string, ChannelDoc> = {},
  options: HarnessOptions = {},
): Promise<Harness> {
  const workdirRoot = await mkdtemp(join(tmpdir(), "pi-chat-runner-test-"));
  const poster = new FakePoster();
  const store = options.store ?? new InMemoryStateStore();
  const reactionCalls: { channel: string; timestamp: string; name: string }[] =
    [];
  const { logger, lines } = collectingLogger();
  const runner = new SessionRunner({
    configSource: new FakeConfigSource(docs),
    store,
    router: new ReplyRouter({ poster }),
    reactions: new Reactions({
      add: async (args) => {
        reactionCalls.push(args);
        return {};
      },
    }),
    extensionPaths: [EXTENSION, PERMISSION_GATE_EXTENSION],
    workdirRoot,
    piBinary: options.piBinary ?? FAKE_PI,
    lingerMs: options.lingerMs ?? 30,
    logger,
    ...(options.extraEnv !== undefined ? { extraEnv: options.extraEnv } : {}),
    ...(options.workdirStorage !== undefined
      ? { workdirStorage: options.workdirStorage }
      : {}),
    ...(options.leaseTtlMs !== undefined
      ? { leaseTtlMs: options.leaseTtlMs }
      : {}),
    ...(options.owner !== undefined ? { owner: options.owner } : {}),
    ...(options.agentUid !== undefined ? { agentUid: options.agentUid } : {}),
    ...(options.agentGid !== undefined ? { agentGid: options.agentGid } : {}),
    ...(options.agentHome !== undefined
      ? { agentHome: options.agentHome }
      : {}),
    ...(options.piPermission !== undefined
      ? { piPermission: options.piPermission }
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
      text: `echo: ${renderEvent(trigger)}`,
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
          combinator: "any",
          gates: [{ kind: "keyword", pattern: "[Hh]elp" }],
        },
      },
    });
    const trigger = message({ text: "help me please" });

    await h.runner.handle(trigger);

    await waitFor(() => h.poster.calls.length === 1, "reply posted");
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
    expect(h.poster.calls[0]?.text).toBe(`steered: ${renderEvent(followUp)}`);
    expect(h.poster.calls[0]?.threadTs).toBe(threadTs);

    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");
    const commands = (await h.commandsLog("C01", threadTs)).map((line) =>
      JSON.parse(line),
    );
    expect(commands.map((c) => c.type)).toEqual(["prompt", "steer"]);
    expect(commands[1]?.message).toBe(renderEvent(followUp));

    // steer 済み item も flush → ack でまとめて確定される
    expect(await h.store.inbox.drain(threadKeyOf(trigger))).toEqual([]);
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

  it("logs resumed: true when transcript.jsonl already exists for the workdir", async () => {
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

    // fake-pi は transcript.jsonl を作らないため、pi が実際に書き出した状態を
    // テスト側で模して置く (session-runtime.md: 再開は同じ --session パスへの
    // 再 spawn だけで実現される)
    await writeFile(
      join(h.workdirRoot, "C01", trigger.id, "transcript.jsonl"),
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

  it("UID 分離が有効なとき HOME を agentHome に上書きし、workdir を chown/chmod する", async () => {
    // root でなくても自分自身の uid/gid への chown は成功するため、実プロセスの
    // uid/gid を使って「UID 分離が有効なコードパスを通す」ことをローカルで検証する
    // (実際に別 uid へ落とす検証は Dockerfile 検証 (docker) で行う)
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid === undefined || gid === undefined) return; // Windows 等では skip
    const h = await harness(
      {},
      { agentUid: uid, agentGid: gid, agentHome: "/tmp/agent-home" },
    );
    const trigger = message({ mentionsBot: true, text: "uid isolated" });

    await h.runner.handle(trigger);
    await waitFor(() => h.runner.activeSessionCount === 0, "session removed");

    const env = await h.envSeen("C01", trigger.id);
    expect(env.HOME).toBe("/tmp/agent-home");

    const stats = await stat(join(h.workdirRoot, "C01", trigger.id));
    expect(stats.uid).toBe(uid);
    expect(stats.gid).toBe(gid);
    expect(stats.mode & 0o777).toBe(0o700);
  });

  it("Node Permission Model が有効なとき node --permission 経由で pi (fake-pi) を起動する", async () => {
    // permission 指定時は entrypoint を直接 node で起動するため、piBinary は
    // 使われない (buildSpawnCommand の仕様)。fake-pi.mjs 自体を entrypoint に
    // 見立て、workdir/node_modules/appDir への read/write を許可した状態でも
    // 通常のセッションと同じく reply → agent_end まで動くことを確認する
    const h = await harness(
      {},
      {
        piPermission: {
          entrypoint: FAKE_PI,
          nodeModulesDir: join(process.cwd(), "node_modules"),
          appDir: process.cwd(),
        },
      },
    );
    const trigger = message({
      mentionsBot: true,
      text: "permission model isolated",
    });

    await h.runner.handle(trigger);

    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    expect(h.poster.calls[0]?.text).toBe(`echo: ${renderEvent(trigger)}`);
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
    expect(h.poster.calls[1]?.text).toBe(`echo: ${renderEvent(late)}`);
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

    // 未 ack の item は inbox に残っており、flush はされていない (異常終了なので
    // このターンの入力は次の kick で再実行される)
    expect((await h.store.inbox.drain(threadKey)).length).toBe(1);
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
    expect(commands[1]?.message).toBe(renderEvent(followUp));
    expect(commands[1]?.message).not.toContain("WAIT_FOR_STEER");
  });
});

describe("threadKeyOf", () => {
  it("uses threadTs when present, message ts otherwise", () => {
    expect(threadKeyOf(message())).toBe("C01:1700000000.000100");
    expect(
      threadKeyOf(
        message({ conversation: { channelId: "C01", threadTs: "1699.5" } }),
      ),
    ).toBe("C01:1699.5");
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

describe("toGateSpecs", () => {
  it("narrows supported kinds and keeps parameters", () => {
    expect(
      toGateSpecs(
        [
          { kind: "mention" },
          { kind: "keyword", pattern: "foo" },
          { kind: "passthrough" },
        ],
        () => {},
      ),
    ).toEqual([
      { kind: "mention" },
      { kind: "keyword", pattern: "foo" },
      { kind: "passthrough" },
    ]);
  });

  it("skips unsupported kinds with a warning instead of throwing", () => {
    const warnings: string[] = [];
    const specs = toGateSpecs(
      [
        { kind: "classifier", criteria: "is it a question?" },
        { kind: "cooldown" },
        { kind: "mention" },
      ],
      (message) => warnings.push(message),
    );
    expect(specs).toEqual([{ kind: "mention" }]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("classifier");
  });
});
