// Session (src/session/session.ts) の統合テスト。1 つの Session の中で起きること —
// Turn 境界の処理 (flush → ack → react → linger)、pi プロセスの spawn と Runtime
// 配線、進捗通知、異常終了 (crash / turn timeout) — を fake-pi 越しに観測する
// (message-dispatch.md §7, session-model.md §7)。
//
// Gate の判定・コマンド・合流・debounce・lease は Dispatcher の担当なので
// test/dispatch/dispatcher.test.ts と test/gate/evaluate.test.ts で見る。
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SandboxRulesSchema } from "../../src/config/sandbox-config.js";
import { renderEvent, replyThreadKeyOf } from "../../src/dispatch/policy.js";
import { CopySharedStore } from "../../src/state/agent/copy.js";
import type {
  SharedStore,
  WorkdirStore,
} from "../../src/state/agent/interfaces.js";
import { InMemoryControlState } from "../../src/state/control/backends/memory.js";
import { inboxItemId } from "../../src/state/control/inbox-item.js";
import {
  FAKE_PI,
  FAKE_SRT,
  harness,
  message,
  sleep,
  derivedSessionKeyOf,
  waitFor,
} from "../helpers/session-harness.js";

describe("Session (fake-pi integration)", () => {
  it("mention → gate → spawn → reply reaches the poster → check reaction", async () => {
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "question here" });

    await h.dispatcher.handle(trigger);

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
    // 👀 も ✅ も、そのターンを起こしたメッセージ (trigger) に付く
    expect(h.reactions.every((r) => r.timestamp === trigger.id)).toBe(true);

    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );
    const commands = await h.commandsLog("C01", trigger.id);
    expect(JSON.parse(commands[0] ?? "{}").type).toBe("prompt");

    // 終了処理で lease が解放され、inbox は ack 済みで空
    const derivedSessionKey = derivedSessionKeyOf(trigger);
    expect(await h.controlState.inbox.drain(derivedSessionKey)).toEqual([]);
    expect(
      await h.controlState.leases.acquire(derivedSessionKey, "probe", 1000),
    ).not.toBeNull();
    expect(
      (await h.controlState.sessions.get(derivedSessionKey))?.endedAt,
    ).toBeInstanceOf(Date);
  });

  it("marks the trigger message ❌ when the turn ends with stopReason error", async () => {
    // pi はプロセスとしては正常に agent_end を返すが、最終 assistant の
    // stopReason が "error" (LLM 呼び出し失敗など)。silent な ✅ ではなく ❌ を付ける
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "TURN_ERROR" });

    await h.dispatcher.handle(trigger);

    await waitFor(() => h.reactions.some((r) => r.name === "x"), "x reaction");
    // 👀 → ❌ の順で、どちらもトリガーメッセージに付く。✅ は付かない
    expect(h.reactions.map((r) => r.name)).toEqual(["eyes", "x"]);
    expect(h.reactions.every((r) => r.timestamp === trigger.id)).toBe(true);

    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );
  });

  it("marks ✅ (no ❌) when a turn recovers via auto-retry (willRetry)", async () => {
    // 1 回目の agent_end は willRetry: true + stopReason: "error" (中間)。Runner は
    // ここで畳まず、リトライ後の 2 回目の agent_end (reply + stopReason: "stop") で
    // 正常終了する。中間の error に引きずられて ❌ を付けないことを確認する
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "RETRY_THEN_OK" });

    await h.dispatcher.handle(trigger);

    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    await waitFor(
      () => h.reactions.some((r) => r.name === "white_check_mark"),
      "check reaction",
    );
    expect(h.reactions.map((r) => r.name)).toEqual([
      "eyes",
      "white_check_mark",
    ]);
    expect(h.reactions.some((r) => r.name === "x")).toBe(false);

    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );
  });

  it("reply files outside the workdir are dropped; in-workdir files resolve to absolute paths", async () => {
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "WITH_FILES" });

    await h.dispatcher.handle(trigger);

    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    // macOS では /tmp が /private/tmp への symlink で、Runner は workdir を
    // realpath 済みの絶対パスとして扱う (Session 起動時の workdirReal)。テスト側の
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

    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );
  });

  it("channel skills/extensions are passed to pi as --skill / --extension (additive)", async () => {
    // チャンネル別の追加 skill / extension (config.md §1.2)。実在するパスを用意し、
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
      C01: { agent: { skills: [skillDir], extensions: [extensionFile] } },
    });
    const trigger = message({ mentionsBot: true, text: "hello" });
    await h.dispatcher.handle(trigger);
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

  it("a nonexistent channel skills path fails the dispatch loudly", async () => {
    const h = await harness({
      C01: { agent: { skills: ["/does/not/exist/skill"] } },
    });
    const trigger = message({ mentionsBot: true, text: "hello" });
    await h.dispatcher.handle(trigger);

    // 黙って skill 抜きで動かず、Session 起動自体が失敗としてログに残る
    await waitFor(
      () => h.logLines().some((l) => l.msg === "session dispatch failed"),
      "dispatch failure logged",
    );
    expect(h.poster.calls).toEqual([]);
  });

  it("shared: archiveから staging へ復元され、--skill 配線とプロンプト言及が入り、ターン終了でarchiveへ書き戻される", async () => {
    const sharedRoot = await mkdtemp(
      join(tmpdir(), "pi-chat-runner-test-shared-"),
    );
    // 過去セッションの蓄積があるarchiveを模す (docs/design/state.md §5.1:
    // session.jsonl が無くても復元される — WorkdirStore との差分)
    await mkdir(join(sharedRoot, "C01", "memory"), { recursive: true });
    await writeFile(
      join(sharedRoot, "C01", "memory", "MEMORY.md"),
      "- past fact",
    );

    const h = await harness(
      {},
      { sharedStore: new CopySharedStore(sharedRoot) },
    );
    // 前ターンで agent が staging に書いた体のファイル (flush でarchiveへ上がるはず)
    const staging = join(h.workdirRoot, "C01", "shared");
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, "notes.md"), "learned in a past turn");

    const trigger = message({ mentionsBot: true, text: "hello" });
    await h.dispatcher.handle(trigger);
    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );

    // archiveの内容が staging (workdir の隣 = agent からは ../shared/) に復元されている
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

    // ターン終了の flush で staging の内容 (mkdir された skills/ 含む) がarchiveへ
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
      { C01: { agent: { memory: false } } },
      { sharedStore: new CopySharedStore(sharedRoot) },
    );
    const trigger = message({ mentionsBot: true, text: "hello" });
    await h.dispatcher.handle(trigger);
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
    // 文言が入らない (docs/design/runtime.md §6)
    const appendPrompt = argv[argv.indexOf("--append-system-prompt") + 1];
    expect(appendPrompt).not.toContain("memory index");
  });

  it("shared: archiveに MEMORY.md があると、その中身が system prompt に注入される (runtime.md §6)", async () => {
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
      { sharedStore: new CopySharedStore(sharedRoot) },
    );
    const trigger = message({ mentionsBot: true, text: "hello" });
    await h.dispatcher.handle(trigger);
    await waitFor(() => h.poster.calls.length === 1, "reply posted");

    const argv = await h.argvSeen("C01", trigger.id);
    const appendPrompt = argv[argv.indexOf("--append-system-prompt") + 1];
    expect(appendPrompt).toContain("memory index");
    expect(appendPrompt).toContain("../shared/memory/MEMORY.md");
    expect(appendPrompt).toContain("- some memory fact");
  });

  it("shared: archiveに MEMORY.md が無い (新規チャンネル) 場合、memory index の文言は system prompt に入らない", async () => {
    const sharedRoot = await mkdtemp(
      join(tmpdir(), "pi-chat-runner-test-shared-"),
    );

    const h = await harness(
      {},
      { sharedStore: new CopySharedStore(sharedRoot) },
    );
    const trigger = message({ mentionsBot: true, text: "hello" });
    await h.dispatcher.handle(trigger);
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
    await h.dispatcher.handle(trigger);
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

    await h.dispatcher.handle(trigger);

    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    // 全件除外されたら text だけの投稿になり、agent の渡した生の相対パスが
    // poster へ漏れない (境界チェックの素通り防止)
    expect(h.poster.calls[0]?.files).toBeUndefined();

    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );
  });

  it("a reply file that is a symlink escaping the workdir is dropped even though its path stays inside", async () => {
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "SYMLINK_FILE" });

    await h.dispatcher.handle(trigger);

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

    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );
  });

  it("mentionFormat に Slack の記法を渡すと、system prompt にその記法の説明が含まれる", async () => {
    const h = await harness({}, { mentionFormat: (id) => `<@${id}>` });
    const trigger = message({
      mentionsBot: true,
      text: "mention format default",
    });

    await h.dispatcher.handle(trigger);
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );

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

    await h.dispatcher.handle(trigger);
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );

    const argv = await h.argvSeen("C01", trigger.id);
    const idx = argv.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThanOrEqual(0);
    const systemPrompt = argv[idx + 1] ?? "";
    expect(systemPrompt).toContain("@USER_ID");
    expect(systemPrompt).not.toContain("<@USER_ID>");
  });

  it("logs session usage aggregated from agent_end.messages", async () => {
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "usage please" });

    await h.dispatcher.handle(trigger);
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );

    const usageLogs = h
      .logLines()
      .filter((line) => line.msg === "session usage");
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

  it("injects agent.context into the first prompt only", async () => {
    const h = await harness({
      C01: { agent: { context: ["CONTEXT-NOTE"] } },
    });
    const trigger = message({ mentionsBot: true, text: "with context" });

    await h.dispatcher.handle(trigger);
    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );

    const commands = await h.commandsLog("C01", trigger.id);
    const prompt = JSON.parse(commands[0] ?? "{}");
    expect(prompt.message).toContain("CONTEXT-NOTE");
    expect(prompt.message).toContain(trigger.text);
  });

  it("stays silent but still adds the check reaction when reply is never called", async () => {
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "NO_REPLY please" });

    await h.dispatcher.handle(trigger);

    await waitFor(
      () => h.reactions.some((r) => r.name === "white_check_mark"),
      "check reaction",
    );
    expect(h.poster.calls).toEqual([]);
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );
  });

  it("ignores a duplicate delivery of the same event id while running", async () => {
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "WAIT_FOR_STEER" });
    await h.dispatcher.handle(trigger);
    expect(h.dispatcher.activeSessionCount).toBe(1);

    // 同じ event_id の再送: セッションは増えず、steer もされない
    await h.dispatcher.handle(trigger);
    expect(h.dispatcher.activeSessionCount).toBe(1);

    // 終了させる
    const followUp = message({
      id: "1700000000.000300",
      conversation: { channelId: "C01", threadTs: trigger.id },
      text: "done",
    });
    await h.dispatcher.handle(followUp);
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );

    const commands = (await h.commandsLog("C01", trigger.id)).map((line) =>
      JSON.parse(line),
    );
    expect(commands.filter((c) => c.type === "prompt")).toHaveLength(1);
  });

  it("reuses the same workdir when the thread is triggered again", async () => {
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "first" });
    await h.dispatcher.handle(trigger);
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "first session done",
    );

    const again = message({
      id: "1700000000.000900",
      conversation: { channelId: "C01", threadTs: trigger.id },
      mentionsBot: true,
      text: "second",
    });
    await h.dispatcher.handle(again);
    await waitFor(() => h.poster.calls.length === 2, "second reply posted");
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
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
    await h.dispatcher.handle(trigger);
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "first session done",
    );

    const startedLogs = h
      .logLines()
      .filter((line) => line.msg === "session started");
    expect(startedLogs).toHaveLength(1);
    expect(startedLogs[0]?.resumed).toBe(false);

    // fake-pi は session.jsonl を作らないため、pi が実際に書き出した状態を
    // テスト側で模して置く (runtime.md §1: 再開は同じ --session パスへの
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
    await h.dispatcher.handle(again);
    await waitFor(() => h.poster.calls.length === 2, "second reply posted");
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
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

    await h.dispatcher.handle(trigger);
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );

    const env = await h.envSeen("C01", trigger.id);
    expect(env.GOOGLE_CLOUD_PROJECT).toBe("my-project");
  });

  it("常に HOME を agentHome に上書きする (UID 分離の有無にかかわらず)", async () => {
    const h = await harness({}, { agentHome: "/tmp/agent-home-no-uid" });
    const trigger = message({ mentionsBot: true, text: "no uid isolation" });

    await h.dispatcher.handle(trigger);
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );

    const env = await h.envSeen("C01", trigger.id);
    // Runner は agentHome を realpath で正規化して渡す (macOS の /tmp symlink 対策)
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

    await h.dispatcher.handle(trigger);
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );

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

    await h.dispatcher.handle(trigger);
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );

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

  it("検出済み entrypoint を node で起動する", async () => {
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
        text: "entrypoint",
      });

      await h.dispatcher.handle(trigger);

      await waitFor(() => h.poster.calls.length === 1, "reply posted");
      expect(h.poster.calls[0]?.text).toBe(
        `echo: ${renderEvent(trigger, replyThreadKeyOf(trigger))}`,
      );
      await waitFor(
        () => h.dispatcher.activeSessionCount === 0,
        "session removed",
      );
    } finally {
      if (previousPiBin === undefined) {
        delete process.env.PI_BIN;
      } else {
        process.env.PI_BIN = previousPiBin;
      }
    }
  });

  it("flushes the workdir before acking inbox items (flush → ack order)", async () => {
    const calls: string[] = [];
    class RecordingStore implements WorkdirStore {
      async restore(): Promise<boolean> {
        calls.push("restore");
        return false;
      }
      async flush(): Promise<void> {
        calls.push("flush");
      }
    }
    const controlState = new InMemoryControlState();
    const originalAck = controlState.inbox.ack.bind(controlState.inbox);
    controlState.inbox.ack = async (sessionKey: string, itemIds: string[]) => {
      calls.push(`ack:${itemIds.length}`);
      await originalAck(sessionKey, itemIds);
    };

    const h = await harness(
      {},
      { controlState, workdirStore: new RecordingStore() },
    );
    const trigger = message({ mentionsBot: true, text: "flush order" });
    await h.dispatcher.handle(trigger);
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );

    // 起動時に restore、agent_end で flush → ack の順 (message-dispatch.md §7.2)
    expect(calls).toEqual(["restore", "flush", "ack:1"]);
    expect(
      await h.controlState.inbox.drain(derivedSessionKeyOf(trigger)),
    ).toEqual([]);
  });

  it("shared の restore/flush は workdir と同じ境界で走り、flush は ack より前 (docs/design/state.md §5.1)", async () => {
    const calls: string[] = [];
    class RecordingWorkdir implements WorkdirStore {
      async restore(): Promise<boolean> {
        calls.push("restore");
        return false;
      }
      async flush(): Promise<void> {
        calls.push("flush");
      }
    }
    class RecordingShared implements SharedStore {
      async restore(): Promise<void> {
        calls.push("shared-restore");
      }
      async flush(): Promise<void> {
        calls.push("shared-flush");
      }
    }
    const controlState = new InMemoryControlState();
    const originalAck = controlState.inbox.ack.bind(controlState.inbox);
    controlState.inbox.ack = async (sessionKey: string, itemIds: string[]) => {
      calls.push(`ack:${itemIds.length}`);
      await originalAck(sessionKey, itemIds);
    };

    const h = await harness(
      {},
      {
        controlState,
        workdirStore: new RecordingWorkdir(),
        sharedStore: new RecordingShared(),
      },
    );
    const trigger = message({ mentionsBot: true, text: "shared flush order" });
    await h.dispatcher.handle(trigger);
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );

    expect(calls).toEqual([
      "restore",
      "shared-restore",
      "flush",
      "shared-flush",
      "ack:1",
    ]);
  });

  it("cleans up and releases the lease when pi responds with success:false", async () => {
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "FAIL_PROMPT please" });
    const derivedSessionKey = derivedSessionKeyOf(trigger);

    await h.dispatcher.handle(trigger);

    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );

    // pi command failed が異常終了として処理されていること
    expect(h.logLines().some((line) => line.msg === "pi command failed")).toBe(
      true,
    );
    expect(h.logLines().some((line) => line.msg === "session failed")).toBe(
      true,
    );

    // lease は解放されている
    expect(
      await h.controlState.leases.acquire(derivedSessionKey, "probe", 1000),
    ).not.toBeNull();

    // エラー通知がスレッドへ投稿されている (router.deliver 経由)
    expect(h.poster.calls).toHaveLength(1);
    expect(h.poster.calls[0]?.channelId).toBe("C01");
    expect(h.poster.calls[0]?.threadTs).toBe(trigger.id);
    expect(h.poster.calls[0]?.text).toContain(
      "No API key found for google-vertex",
    );

    // command failed (認証エラー等) はこのターンの入力を ack して捨てる (retry しない。
    // message-dispatch.md §7.4)。捨てないと未 ack のまま次の新規イベントの drain が巻き込み、
    // 同じ入力で再び失敗するループになりうる。flush はしない (workdir は退避させない)
    expect((await h.controlState.inbox.drain(derivedSessionKey)).length).toBe(
      0,
    );

    // 異常終了はトリガーメッセージへの ❌ で見える化する
    expect(
      h.reactions.some((r) => r.name === "x" && r.timestamp === trigger.id),
    ).toBe(true);
  });

  it("drops the prompted item when pi crashes (process exit while running)", async () => {
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "CRASH_NOW please" });
    const derivedSessionKey = derivedSessionKeyOf(trigger);

    await h.dispatcher.handle(trigger);

    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );

    // running のまま exit したので異常終了として処理されていること
    expect(
      h.logLines().some((line) => line.msg === "pi exited unexpectedly"),
    ).toBe(true);

    // lease は解放されている
    expect(
      await h.controlState.leases.acquire(derivedSessionKey, "probe", 1000),
    ).not.toBeNull();

    // クラッシュは workdir/transcript の破損を疑うため、このターンの入力は ack して
    // 捨てる (retry しない。message-dispatch.md §7.4)。捨てないと次の新規イベントの drain が
    // 巻き込んで同じ状態から再 spawn し、決定的に再クラッシュしうる
    expect((await h.controlState.inbox.drain(derivedSessionKey)).length).toBe(
      0,
    );

    // クラッシュはユーザーから見えないので ❌ で見える化する
    expect(
      h.reactions.some((r) => r.name === "x" && r.timestamp === trigger.id),
    ).toBe(true);
  });

  it("kills pi and cleans up the session when a turn exceeds turnTimeoutMs", async () => {
    // fake-pi の HANG_FOREVER は response も agent_end も返さない。Runner が
    // turnTimeoutMs (ここでは短く 100ms) 超過を検知して kill し、セッションを
    // 異常終了として畳むことを確認する (runtime.md §5.1)
    const h = await harness({}, { turnTimeoutMs: 100 });
    const trigger = message({ mentionsBot: true, text: "HANG_FOREVER please" });
    const derivedSessionKey = derivedSessionKeyOf(trigger);

    await h.dispatcher.handle(trigger);

    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );

    expect(h.logLines().some((line) => line.msg === "turn timed out")).toBe(
      true,
    );
    expect(h.logLines().some((line) => line.msg === "session timed out")).toBe(
      true,
    );

    // lease は解放されている
    expect(
      await h.controlState.leases.acquire(derivedSessionKey, "probe", 1000),
    ).not.toBeNull();

    // timeout 通知がスレッドへ投稿されている (router.deliver 経由)
    expect(h.poster.calls).toHaveLength(1);
    expect(h.poster.calls[0]?.channelId).toBe("C01");
    expect(h.poster.calls[0]?.threadTs).toBe(trigger.id);
    expect(h.poster.calls[0]?.text).toContain(":warning:");

    // timeout 時は flush しないが、このターンで prompt 済みだった item は
    // ack して捨てる (retry しない。message-dispatch.md §7.4)。異常終了はコマンド失敗・
    // クラッシュと同じ規則で、残すと同じ重い入力を次 drain が拾って再 timeout する
    // 毒ループになるため。ユーザーには ❌ と通知で伝わる
    expect((await h.controlState.inbox.drain(derivedSessionKey)).length).toBe(
      0,
    );
  });

  it("does not fire the turn timeout when agent_end arrives before turnTimeoutMs", async () => {
    // 通常のターン (fake-pi は即座に reply → agent_end を返す) では
    // turnTimeoutMs (短く 200ms) が経過してもタイマーは発火しない
    // (onAgentEnd 冒頭でクリアされているため)
    const h = await harness({}, { turnTimeoutMs: 200 });
    const trigger = message({ mentionsBot: true, text: "no timeout here" });

    await h.dispatcher.handle(trigger);
    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );

    // タイマーが発火していれば余分に 300ms 待った後もログに残るはずなので、
    // 発火していないことを確認する
    await sleep(300);
    expect(h.logLines().some((line) => line.msg === "turn timed out")).toBe(
      false,
    );
    expect(h.poster.calls).toHaveLength(1);
  });

  it("does not re-prompt items drained at dispatch when a later drain returns them (promptedIds)", async () => {
    // drain は非破壊なので、起動時に prompt 済みの trigger item は ack されるまで
    // (= 最初の agent_end まで) 再 drain に出続ける。steer パスの drain と
    // agent_end の再 drain の両方で、promptedIds による除外が効くことを確認する
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "WAIT_FOR_STEER" });
    await h.dispatcher.handle(trigger);
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
    await h.dispatcher.handle(followUp);

    await waitFor(() => h.poster.calls.length === 1, "steered reply posted");
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );

    const commands = (await h.commandsLog("C01", trigger.id)).map((line) =>
      JSON.parse(line),
    );
    // prompt は起動時の 1 回だけ。steer は followUp のみ (trigger の再送なし)
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
    // (ingress-egress.md §8)
    const h = await harness({}, { progressNoticeIntervalMs: 30 });
    const trigger = message({ mentionsBot: true, text: "SLOW_TOOL" });

    await h.dispatcher.handle(trigger);

    await waitFor(() => h.poster.calls.length >= 1, "initial progress posted");

    const nextTool = message({
      id: "1700000000.000600",
      conversation: { channelId: "C01", threadTs: trigger.id },
      text: "NEXT_TOOL",
    });
    await h.dispatcher.handle(nextTool);
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
    await h.dispatcher.handle(followUp);
    await waitFor(
      () => h.poster.updateCalls.length > updateCountBeforeReply,
      "final reply merged into progress message",
    );
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );

    expect(h.poster.calls).toHaveLength(1);
    expect(h.poster.updateCalls.at(-1)?.messageId).toBe("msg-1");

    // 進捗通知メッセージへの update はターン終了後は増えない
    const updateCountAtEnd = h.poster.updateCalls.length;
    await sleep(90);
    expect(h.poster.updateCalls.length).toBe(updateCountAtEnd);
  });

  it("progress notice: reply 配送後・agent_end 到達前の隙間でタイマーが再発火しない", async () => {
    // ingress-egress.md §8: 進捗タイマーは reply の tool_execution_end 到達時点で
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

    await h.dispatcher.handle(trigger);
    // reply は進捗メッセージが既に存在すれば update、無ければ postMessage で
    // 届く (tryUpdateProgress) — どちらの Session で届くかは環境依存のタイミング次第
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

    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );
  });

  it("progress notice: reply ツールの実行は currentTool/step 数に反映されない", async () => {
    // fake-pi の REPLY_THEN_DELAYED_END は tool_execution_start("reply") →
    // tool_execution_end (reply 本体) → 500ms 後に agent_end、という順で発火する
    // (ingress-egress.md §8: reply は「最終回答を作っている」段階であり進捗表示の
    // 対象外)。tool_execution_start("reply") と agent_end の間 (500ms) にタイマーが
    // tick しても、reply はここまでのターンで唯一発火したツールなので currentTool は
    // undefined のまま = ":thinking_face: ... (step 0)" 側の表示になるはず。
    // reply のツール名・絵文字 (:speech_balloon:) が表示に混ざらないことを確認する
    const h = await harness({}, { progressNoticeIntervalMs: 100 });
    const trigger = message({
      mentionsBot: true,
      text: "REPLY_THEN_DELAYED_END",
    });

    await h.dispatcher.handle(trigger);

    // tool_execution_start("reply") 後・agent_end (500ms 後) 到達前のどこかで
    // タイマーが tick するのを待つ (postMessage/updateMessage いずれか)
    await waitFor(
      () => h.poster.calls.length + h.poster.updateCalls.length >= 1,
      "at least one progress notice fired before agent_end",
    );

    const allTexts = [
      ...h.poster.calls.map((c) => c.text),
      ...h.poster.updateCalls.map((c) => c.text),
    ];
    // reply の tool_execution_end (最終回答本文) は別経路で届きうるので、
    // ここでは reply ツールのスナップショット表示 (絵文字・ツール名・stepが
    // 1 以上に進んでいる状態) が混ざっていないことだけを見る
    for (const text of allTexts) {
      if (text.includes("REPLY_THEN_DELAYED")) continue; // reply 本文そのもの
      expect(text).not.toContain(":speech_balloon:");
      expect(text).not.toContain("`reply`");
      expect(text).toContain("(step 0)");
    }

    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );
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

    await h.dispatcher.handle(trigger);
    await waitFor(() => h.poster.calls.length >= 1, "initial progress posted");

    const followUp = message({
      id: "1700000000.000701",
      conversation: { channelId: "D01", isDm: true },
      text: "finish it",
    });
    await h.dispatcher.handle(followUp);
    await waitFor(
      () => h.poster.updateCalls.some((c) => c.text.startsWith("steered:")),
      "final reply merged into DM progress message",
    );
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );

    expect(h.poster.calls).toHaveLength(1);
    expect(h.poster.updateCalls.at(-1)?.messageId).toBe("msg-1");
  });

  it("progress notice: progressNoticeIntervalMs: 0 で機能を無効化できる", async () => {
    const h = await harness({}, { progressNoticeIntervalMs: 0 });
    const trigger = message({ mentionsBot: true, text: "SLOW_TOOL" });

    await h.dispatcher.handle(trigger);
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
    await h.dispatcher.handle(followUp);
    await waitFor(() => h.poster.calls.length === 1, "final reply posted");
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );
  });

  it("picks up an item enqueued during linger in the same process, then releases the lease", async () => {
    const h = await harness({}, { lingerMs: 300 });
    const trigger = message({ mentionsBot: true, text: "first turn" });
    const derivedSessionKey = derivedSessionKeyOf(trigger);

    await h.dispatcher.handle(trigger);
    await waitFor(() => h.poster.calls.length === 1, "first reply posted");

    // agent_end 直後 (linger 窓内) に、handle を経由せず inbox へ直接届いた item を
    // 模す (例: 別インスタンスが enqueue だけした場合)。linger の再 drain が拾う
    await sleep(50);
    const late = message({
      id: "1700000000.000500",
      conversation: { channelId: "C01", threadTs: trigger.id },
      text: "late arrival",
    });
    await h.controlState.inbox.enqueue(derivedSessionKey, {
      id: inboxItemId(late),
      event: late,
      enqueuedAt: new Date(),
    });

    await waitFor(() => h.poster.calls.length === 2, "linger reply posted");
    expect(h.poster.calls[1]?.text).toBe(
      `echo: ${renderEvent(late, replyThreadKeyOf(late))}`,
    );
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );

    // 同一プロセス (再 spawn なし) で処理されている
    const commands = (await h.commandsLog("C01", trigger.id)).map((line) =>
      JSON.parse(line),
    );
    expect(commands.map((c) => c.type)).toEqual(["prompt", "prompt"]);

    // linger 後に終了し lease が解放されている
    expect(
      await h.controlState.leases.acquire(derivedSessionKey, "probe", 1000),
    ).not.toBeNull();
  });
});

describe("Session sandbox (srt, runtime.md §5.5)", () => {
  const rules = SandboxRulesSchema.parse({
    network: { allowedDomains: ["aiplatform.googleapis.com:443"] },
    filesystem: { allowRead: ["/data/knowledge"] },
  });

  it("writes the merged settings outside the workdir and launches pi through srt", async () => {
    const h = await harness(
      { C01: { agent: { sandbox: rules } } },
      { srtEntrypoint: FAKE_SRT },
    );
    const trigger = message({ mentionsBot: true, text: "hello" });
    await h.dispatcher.handle(trigger);
    await waitFor(() => h.poster.calls.length === 1, "reply posted");

    const seen = await h.srtSeen("C01", trigger.id);
    const workdirRoot = await realpath(h.workdirRoot);
    // settings は <workdirRoot>/srt/ に置かれ、workdir (agent 所有) の外
    expect(seen.settingsPath).toBe(
      join(
        h.workdirRoot,
        "srt",
        `${encodeURIComponent(`C01:${trigger.id}`)}.json`,
      ),
    );
    // harness の logger は debug レベルなので srt にも --debug が渡る
    expect(seen.debug).toBe(true);
    // 利用者ルールは素通り、Runner が workdir / TMPDIR / home を allowWrite に足す
    expect(seen.settings.network.allowedDomains).toEqual([
      "aiplatform.googleapis.com:443",
    ]);
    expect(seen.settings.filesystem.allowRead).toContain("/data/knowledge");
    expect(seen.settings.filesystem.allowWrite).toEqual(
      expect.arrayContaining([
        join(workdirRoot, "C01", trigger.id),
        join(workdirRoot, "C01", "tmp", trigger.id),
      ]),
    );
    // 内側コマンドは fake-pi の rpc 起動そのもの
    expect(seen.inner[0]).toBe(FAKE_PI);
    expect(seen.inner.slice(1, 3)).toEqual(["--mode", "rpc"]);
    // pi の TMPDIR は Session 専用ディレクトリ。srt が sandbox 内 TMPDIR の決定に使う
    // CLAUDE_CODE_TMPDIR も同じ場所を向く (srt の既定 /tmp/claude に飛ばないように)
    const env = await h.envSeen("C01", trigger.id);
    const tmpDir = join(workdirRoot, "C01", "tmp", trigger.id);
    expect(env.TMPDIR).toBe(tmpDir);
    expect(env.CLAUDE_CODE_TMPDIR).toBe(tmpDir);

    // Session 終了で settings ファイルは消える
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );
    await waitFor(
      () =>
        stat(seen.settingsPath).then(
          () => false,
          () => true,
        ),
      "settings file removed",
    );
  });

  it("does not involve srt when the channel sets sandbox: false", async () => {
    const h = await harness(
      // FakeConfigSource はマージしない。実ローダーが default の有効ルールを
      // Channel の `false` で打ち消した結果 (agent.sandbox === false) を直接与える
      { C01: { agent: { sandbox: false } } },
      { srtEntrypoint: FAKE_SRT },
    );
    const trigger = message({ mentionsBot: true, text: "hello" });
    await h.dispatcher.handle(trigger);
    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    await expect(h.srtSeen("C01", trigger.id)).rejects.toThrow(/ENOENT/);
    expect(await h.argvSeen("C01", trigger.id)).not.toContain("--settings");
  });

  it("fails closed when sandbox is enabled but srt is unavailable", async () => {
    const h = await harness({ C01: { agent: { sandbox: rules } } });
    const trigger = message({ mentionsBot: true, text: "hello" });
    await h.dispatcher.handle(trigger);
    await waitFor(
      () => h.logLines().some((l) => l.msg === "session dispatch failed"),
      "dispatch failed log",
    );
    const line = h
      .logLines()
      .find((l) => l.msg === "session dispatch failed") as {
      err?: { message?: string };
    };
    expect(line.err?.message).toMatch(/srt is unavailable/);
    expect(h.poster.calls).toEqual([]);
    expect(h.dispatcher.activeSessionCount).toBe(0);
  });
});
