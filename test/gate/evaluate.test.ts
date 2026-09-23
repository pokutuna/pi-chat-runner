// Gate ステージ (src/gate/evaluate.ts) の統合テスト。Dispatcher 経由で
// GateEvaluator.admit() の段の順序を観測する:
//   channel disabled → (message のみ) 実行中 Session への引き渡し → Gate 木
//   → (reaction のみ) 対象メッセージの fetch → Session 選択
// reaction の sessionKey は fetch 後にしか決まらないため、Gate 木の評価が fetch より
// 前に来る (message-dispatch.md §1)。
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { FetchedMessage, FetchMessage } from "../../src/gate/evaluate.js";
import type { ReactionEvent } from "../../src/ingress/chat-event.js";
import { CopyWorkdirStore } from "../../src/state/agent/copy.js";
import {
  harness,
  message,
  sleep,
  waitFor,
} from "../helpers/session-harness.js";

describe("Gate: reaction 起動 (handleReaction 経由の段の順序)", () => {
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

  it("reaction gate match + fetch success starts a session with the fetched text", async () => {
    const { fetch } = fetchReturning({ text: "question from reaction" });
    const h = await harness(
      { C01: { trigger: { when: [{ kind: "reaction", emoji: ["eyes"] }] } } },
      { fetchMessage: fetch },
    );
    const target = reaction();

    await h.dispatcher.handleReaction(target);

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

    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );
  });

  it("reaction gate mismatch: fetch is never called and no session is started", async () => {
    const { fetch, calls } = fetchReturning({ text: "should not be used" });
    const h = await harness(
      { C01: { trigger: { when: [{ kind: "reaction", emoji: ["tada"] }] } } },
      { fetchMessage: fetch },
    );
    const target = reaction({ emoji: "eyes" });

    await h.dispatcher.handleReaction(target);
    // gate 非一致は同期的に return するはずだが、念のため少し待って非発火を確認する
    await sleep(50);

    expect(calls).toEqual([]);
    expect(h.dispatcher.activeSessionCount).toBe(0);
    expect(h.poster.calls).toEqual([]);
  });

  it("fetch returning null does not start a session (target message not found)", async () => {
    const { fetch } = fetchReturning(null);
    const h = await harness(
      { C01: { trigger: { when: [{ kind: "reaction", emoji: ["eyes"] }] } } },
      { fetchMessage: fetch },
    );
    const target = reaction();

    await h.dispatcher.handleReaction(target);
    await sleep(50);

    expect(h.dispatcher.activeSessionCount).toBe(0);
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
    const parentThreadTs = "1700000000.000050";
    const { fetch } = fetchReturning({
      text: "reply from a thread",
      threadTs: parentThreadTs,
    });
    const h = await harness(
      { C01: { trigger: { when: [{ kind: "reaction", emoji: ["eyes"] }] } } },
      { fetchMessage: fetch },
    );
    const target = reaction({ targetMessageId: "1700000000.000300" });

    await h.dispatcher.handleReaction(target);

    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    // reply 宛先は fetched.threadTs (親スレッド) — targetMessageId 単独ではない
    expect(h.poster.calls[0]?.threadTs).toBe(parentThreadTs);

    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );
    // sessionKey = channelId:threadTs (fetched.threadTs 転写が効いている証跡として
    // そのキーで workdir が作られ、inbox が空になっていることを確認する)
    const sessionKey = `C01:${parentThreadTs}`;
    expect(await h.controlState.inbox.drain(sessionKey)).toEqual([]);
    expect(
      await h.controlState.leases.acquire(sessionKey, "probe", 1000),
    ).not.toBeNull();
  });

  it("reaction 起動が過去セッションと同じ sessionKey に着地すると、archiveの transcript が restore されて resumed:true になる (実質再開)", async () => {
    const baseDir = await mkdtemp(
      join(tmpdir(), "pi-chat-runner-test-archive-"),
    );
    const storage = new CopyWorkdirStore(baseDir);
    const threadTs = "1700000000.000050";
    const { fetch } = fetchReturning({ text: "continue please", threadTs });
    const h = await harness(
      {
        C01: { trigger: { when: [{ kind: "reaction", emoji: ["eyes"] }] } },
      },
      { workdirStore: storage, fetchMessage: fetch },
    );

    // 過去セッションのarchive (baseDir/C01/<threadTs>/session.jsonl) を事前に用意する。
    // workdirRoot 側には何も置かない (コールドスタートを模す — 731 行目のテストは
    // workdirRoot に直接置くが、こちらはarchive経由の restore だけで再開が成立することを見る)
    const archiveDir = join(baseDir, "C01", threadTs);
    await mkdir(archiveDir, { recursive: true });
    await writeFile(join(archiveDir, "session.jsonl"), "PAST TRANSCRIPT\n");

    const target = reaction({ targetMessageId: "1700000000.000300" });

    await h.dispatcher.handleReaction(target);

    await waitFor(
      () => h.logLines().some((line) => line.msg === "session started"),
      "session started logged",
    );
    const startedLogs = h
      .logLines()
      .filter((line) => line.msg === "session started");
    expect(startedLogs).toHaveLength(1);
    // 命題の核心: archiveからの restore によって pi が既存 transcript を検出し、
    // resumed:true として起動している (同一インスタンス内で workdir に直接ファイルを
    // 置く既存テストとは異なり、archive経由の restore だけで再開が成立する)
    expect(startedLogs[0]?.resumed).toBe(true);

    // workdir にもarchiveの内容が復元されている
    const restored = await readFile(
      join(h.workdirRoot, "C01", threadTs, "session.jsonl"),
      "utf-8",
    );
    expect(restored).toContain("PAST TRANSCRIPT");

    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    expect(h.poster.calls[0]?.threadTs).toBe(threadTs);

    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );
  });

  it("archiveに transcript が無ければ resumed:false (新規セッション、再開ではない)", async () => {
    const baseDir = await mkdtemp(
      join(tmpdir(), "pi-chat-runner-test-archive-"),
    );
    const storage = new CopyWorkdirStore(baseDir);
    const threadTs = "1700000000.000060";
    const { fetch } = fetchReturning({ text: "fresh start please", threadTs });
    const h = await harness(
      {
        C01: { trigger: { when: [{ kind: "reaction", emoji: ["eyes"] }] } },
      },
      { workdirStore: storage, fetchMessage: fetch },
    );
    const target = reaction({ targetMessageId: "1700000000.000300" });

    await h.dispatcher.handleReaction(target);

    await waitFor(
      () => h.logLines().some((line) => line.msg === "session started"),
      "session started logged",
    );
    const startedLogs = h
      .logLines()
      .filter((line) => line.msg === "session started");
    expect(startedLogs).toHaveLength(1);
    expect(startedLogs[0]?.resumed).toBe(false);

    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );
  });
});

describe("Gate: trigger.whileRunning (実行中 Session へのメッセージの扱い)", () => {
  it("passthrough (既定): 実行中 Session へのスレッド内追いメッセージは Gate を評価せず steer される", async () => {
    // mention gate のチャンネルで、mention なしの追いメッセージを送る。
    // passthrough は Gate を省略するので steer が届く
    const h = await harness({
      C01: {
        trigger: {
          when: [{ kind: "mention" }],
          whileRunning: "passthrough",
        },
      },
    });
    const trigger = message({ mentionsBot: true, text: "WAIT_FOR_STEER" });
    const threadTs = trigger.id;

    await h.dispatcher.handle(trigger);
    await waitFor(async () => {
      try {
        return (await h.commandsLog("C01", threadTs)).length >= 1;
      } catch {
        return false;
      }
    }, "initial prompt recorded");

    const followUp = message({
      id: "1700000000.000200",
      conversation: { channelId: "C01", threadTs },
      text: "mention のない追いメッセージ",
    });
    await h.dispatcher.handle(followUp);

    await waitFor(() => h.poster.calls.length === 1, "steered reply posted");
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );
    const commands = (await h.commandsLog("C01", threadTs)).map((line) =>
      JSON.parse(line),
    );
    expect(commands.map((c) => c.type)).toEqual(["prompt", "steer"]);
  });

  it("evaluate: 実行中でも Gate を評価し、非通過 (mention なし) の追いメッセージは steer されない", async () => {
    const h = await harness({
      C01: {
        trigger: {
          when: [{ kind: "mention" }],
          whileRunning: "evaluate",
        },
      },
    });
    const trigger = message({ mentionsBot: true, text: "WAIT_FOR_STEER" });
    const threadTs = trigger.id;

    await h.dispatcher.handle(trigger);
    await waitFor(async () => {
      try {
        return (await h.commandsLog("C01", threadTs)).length >= 1;
      } catch {
        return false;
      }
    }, "initial prompt recorded");

    const followUp = message({
      id: "1700000000.000200",
      conversation: { channelId: "C01", threadTs },
      text: "mention のない追いメッセージ",
      mentionsBot: false,
    });
    await h.dispatcher.handle(followUp);
    await sleep(50);

    // Gate 非通過なので steer されない
    expect(
      h
        .logLines()
        .some((line) => String(line.msg ?? "") === "gate not triggered"),
    ).toBe(true);
    expect(await h.commandsLog("C01", threadTs)).toHaveLength(1);

    // mention 付きなら Gate を通り steer される (fake-pi をここで解放する)
    await h.dispatcher.handle(
      message({
        id: "1700000000.000300",
        conversation: { channelId: "C01", threadTs },
        text: "mention 付きの追いメッセージ",
        mentionsBot: true,
      }),
    );

    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );
    const commands = (await h.commandsLog("C01", threadTs)).map((line) =>
      JSON.parse(line),
    );
    // 非通過のメッセージは commands に現れない (prompt → steer の 2 件だけ)
    expect(commands.map((c) => c.type)).toEqual(["prompt", "steer"]);
    expect(commands[1]?.message).toContain("mention 付きの追いメッセージ");
  });

  it("evaluate: Gate を通過した追いメッセージは (新規起動ではなく) 実行中 Session へ steer される", async () => {
    const h = await harness({
      C01: {
        trigger: {
          when: [{ kind: "mention" }],
          whileRunning: "evaluate",
        },
      },
    });
    const trigger = message({ mentionsBot: true, text: "WAIT_FOR_STEER" });
    const threadTs = trigger.id;

    await h.dispatcher.handle(trigger);
    await waitFor(async () => {
      try {
        return (await h.commandsLog("C01", threadTs)).length >= 1;
      } catch {
        return false;
      }
    }, "initial prompt recorded");

    const followUp = message({
      id: "1700000000.000200",
      conversation: { channelId: "C01", threadTs },
      text: "mention 付きの追いメッセージ",
      mentionsBot: true,
    });
    await h.dispatcher.handle(followUp);

    await waitFor(() => h.poster.calls.length === 1, "steered reply posted");
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );
    const commands = (await h.commandsLog("C01", threadTs)).map((line) =>
      JSON.parse(line),
    );
    expect(commands.map((c) => c.type)).toEqual(["prompt", "steer"]);
    // 新規 Session は立たない (同一 sessionKey の inbox は空に確定している)
    expect(await h.controlState.inbox.drain(`C01:${threadTs}`)).toEqual([]);
  });
});
