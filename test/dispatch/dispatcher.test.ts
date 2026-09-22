// Dispatcher (src/dispatch/dispatcher.ts) の統合テスト。Dispatcher の担当 —
// Gate 判定の適用、コマンド (`/new` `/enable` `/disable`)、実行中 Session への
// steering、session.affinity の合流、debounce、lease の取得と再 dispatch — を
// fake-pi 越しに観測する (message-dispatch.md §2-§6, session-model.md §3, §5)。
//
// 1 つの Session の内側 (Turn 境界・進捗通知・異常終了) は
// test/session/session.test.ts で見る。
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ClassifierClient } from "../../src/classifier/client.js";
import type { ChannelConfig } from "../../src/config/channel-config.js";
import { renderEvent, replyThreadKeyOf } from "../../src/dispatch/policy.js";
import type { FetchMessage } from "../../src/gate/evaluate.js";
import type { ReactionEvent } from "../../src/ingress/chat-event.js";
import type { WorkdirStore } from "../../src/state/agent/interfaces.js";
import { InMemoryControlState } from "../../src/state/control/backends/memory.js";
import {
  harness,
  message,
  sleep,
  threadKeyOf,
  waitFor,
} from "../helpers/session-harness.js";

describe("Dispatcher (fake-pi integration)", () => {
  it("does not react nor spawn when the gate rejects (default = mention only)", async () => {
    const h = await harness();
    await h.dispatcher.handle(message({ text: "no mention here" }));

    expect(h.dispatcher.activeSessionCount).toBe(0);
    expect(h.poster.calls).toEqual([]);
    expect(h.reactions).toEqual([]);
  });

  it("keyword gate from the channel config triggers without a mention", async () => {
    const h = await harness({
      C01: {
        trigger: {
          when: [{ kind: "keyword", pattern: "[Hh]elp" }],
        },
      },
    });
    const trigger = message({ text: "help me please" });

    await h.dispatcher.handle(trigger);

    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );
  });

  it("DM without a 'dm' channel entry never spawns a session (default = disabled)", async () => {
    const h = await harness();
    const trigger = message({
      conversation: { channelId: "D01", isDm: true },
      text: "hi there, no mention",
    });

    await h.dispatcher.handle(trigger);

    expect(h.dispatcher.activeSessionCount).toBe(0);
    expect(h.poster.calls).toEqual([]);
  });

  it("reserved 'dm' channel entry overrides the DM default (passthrough trigger)", async () => {
    const h = await harness({
      dm: {
        trigger: { when: [{ kind: "passthrough" }] },
      },
    });
    const trigger = message({
      conversation: { channelId: "D01", isDm: true },
      text: "hi there, no mention",
    });

    await h.dispatcher.handle(trigger);

    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    // DM は既定 session: channel, reply: flat (session-model.md §2) なので、
    // スレッド外トリガーの返信先はチャンネル直下 (threadTs 無し) になる
    expect(h.poster.calls[0]).toEqual({
      channelId: "D01",
      text: `echo: ${renderEvent(trigger, replyThreadKeyOf(trigger))}`,
    });
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );
  });

  it("delivers follow-up messages to the running pi as a steer command", async () => {
    const h = await harness();
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

    // スレッド内の追いメッセージ。mention なしでも gate を通さず同じ inbox へ
    const followUp = message({
      id: "1700000000.000200",
      conversation: { channelId: "C01", threadTs },
      text: "追加の指示です",
    });
    await h.dispatcher.handle(followUp);

    await waitFor(() => h.poster.calls.length === 1, "steered reply posted");
    expect(h.poster.calls[0]?.text).toBe(
      `steered: ${renderEvent(followUp, replyThreadKeyOf(followUp))}`,
    );
    expect(h.poster.calls[0]?.threadTs).toBe(threadTs);

    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );
    const commands = (await h.commandsLog("C01", threadTs)).map((line) =>
      JSON.parse(line),
    );
    expect(commands.map((c) => c.type)).toEqual(["prompt", "steer"]);
    expect(commands[1]?.message).toBe(
      renderEvent(followUp, replyThreadKeyOf(followUp)),
    );

    // steer 済み item も flush → ack でまとめて確定される
    expect(await h.controlState.inbox.drain(threadKeyOf(trigger))).toEqual([]);
  });

  it("channel モード (session.mode: channel) では、スレッド外の 2 つ目のメッセージが新セッションでなく同一セッションへの steer になる", async () => {
    const h = await harness({
      C01: { session: { mode: "channel" } },
    });
    const trigger = message({ mentionsBot: true, text: "WAIT_FOR_STEER" });

    await h.dispatcher.handle(trigger);
    await waitFor(async () => {
      try {
        return (await h.commandsLog("C01", "channel")).length >= 1;
      } catch {
        return false;
      }
    }, "initial prompt recorded");
    expect(h.dispatcher.activeSessionCount).toBe(1);

    // トリガーと同じスレッド外 (threadTs 無し) の 2 件目。session.mode: channel
    // なので sessionKey は channelId のみで揃い、同一セッションへの steer になる
    // (session-model.md §2.1)
    const second = message({
      id: "1700000000.000250",
      conversation: { channelId: "C01" },
      text: "追加の指示です (channel モード)",
    });
    await h.dispatcher.handle(second);

    // 新規セッションが増えていない (同一セッションへの steer)
    expect(h.dispatcher.activeSessionCount).toBe(1);

    await waitFor(() => h.poster.calls.length === 1, "steered reply posted");
    // reply.mode の既定は thread なので、スレッド外トリガーの返信は
    // メッセージごとに新しいスレッドを起こす (thread_key = channelId:second.id)
    expect(h.poster.calls[0]?.threadTs).toBe(second.id);
    expect(h.poster.calls[0]?.text).toBe(
      `steered: ${renderEvent(second, replyThreadKeyOf(second))}`,
    );

    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );
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

    // 事前に workdir と session.jsonl、および 10 分前の SessionRecord を用意する
    // (前回セッションが idle 期間を超えて放置された状態を模す)
    await mkdir(workdir, { recursive: true });
    await writeFile(join(workdir, "session.jsonl"), "OLD TRANSCRIPT\n");
    await h.controlState.sessions.put(sessionKey, {
      channelId: "C01",
      threadTs: "channel",
      triggerMessageId: "1699999999.000000",
      startedAt: new Date(Date.now() - 10 * 60_000),
      lastActiveAt: new Date(Date.now() - 10 * 60_000),
      endedAt: new Date(Date.now() - 10 * 60_000),
    });

    const trigger = message({ mentionsBot: true, text: "idle reset please" });
    await h.dispatcher.handle(trigger);
    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );

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
    // size 判定は Control State に依存しないため SessionRecord の事前 put は不要
    await mkdir(workdir, { recursive: true });
    await writeFile(join(workdir, "session.jsonl"), "x".repeat(2 * 1024));

    const trigger = message({ mentionsBot: true, text: "size reset please" });
    await h.dispatcher.handle(trigger);
    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );

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
    await h.dispatcher.handle(trigger);
    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );

    const entries = await readdir(workdir);
    expect(entries).toContain("session.jsonl");
    expect(entries.some((name) => /^session-\d+\.jsonl$/.test(name))).toBe(
      false,
    );
  });

  it("/new (idle・gate 通過): rotateRequestedAt が書かれ、ack が配送され、pi は起動しない", async () => {
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "/new" });

    await h.dispatcher.handle(trigger);

    await waitFor(() => h.poster.calls.length === 1, "ack posted");
    expect(h.poster.calls[0]?.text).toBe(
      ":new: 次のメッセージから新しいセッションを開始します",
    );

    const sessionKey = threadKeyOf(trigger);
    const doc = await h.controlState.sessions.get(sessionKey);
    expect(doc?.rotateRequestedAt).toBeInstanceOf(Date);
    expect(doc?.endedAt).toBeInstanceOf(Date);

    // pi は起動していない (セッションは走らず、inbox にも item は積まれない)
    expect(h.dispatcher.activeSessionCount).toBe(0);
    expect(await h.controlState.inbox.drain(sessionKey)).toEqual([]);

    // lease は解放済み (直後に acquire できる)
    expect(
      await h.controlState.leases.acquire(sessionKey, "probe", 1000),
    ).not.toBeNull();
  });

  it("/new 実行中 (同一インスタンスに record あり): 拒否通知が配送され、実行中セッションに steer されない", async () => {
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "WAIT_FOR_STEER" });
    await h.dispatcher.handle(trigger);
    await waitFor(
      () => h.dispatcher.activeSessionCount === 1,
      "session running",
    );

    const sessionKey = threadKeyOf(trigger);
    const newCmd = message({
      id: "1700000001.000200",
      conversation: { channelId: "C01", threadTs: trigger.id },
      mentionsBot: true,
      text: "/new",
      metadata: { eventId: "Ev-new-cmd" },
    });
    await h.dispatcher.handle(newCmd);

    await waitFor(() => h.poster.calls.length === 1, "reject notice posted");
    expect(h.poster.calls[0]?.text).toBe(
      ":warning: セッションが実行中のため、いまは /new できません。完了後にもう一度送ってください",
    );

    // マーカーは書かれず、実行中セッションにも steer されていない (commands.jsonl に
    // /new の steer が現れない)
    expect(
      (await h.controlState.sessions.get(sessionKey))?.rotateRequestedAt,
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
    await h.dispatcher.handle(proc);
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );
  });

  it("/new で lease が取れない (事前に別 owner で acquire 済み): 拒否通知", async () => {
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "/new" });
    const sessionKey = threadKeyOf(trigger);
    const heldLease = await h.controlState.leases.acquire(
      sessionKey,
      "other-owner",
      60_000,
    );
    expect(heldLease).not.toBeNull();

    await h.dispatcher.handle(trigger);

    await waitFor(() => h.poster.calls.length === 1, "reject notice posted");
    expect(h.poster.calls[0]?.text).toBe(
      ":warning: セッションが実行中のため、いまは /new できません。完了後にもう一度送ってください",
    );
    expect(
      (await h.controlState.sessions.get(sessionKey))?.rotateRequestedAt,
    ).toBeUndefined();
  });

  it("マーカーあり状態で次のメッセージ → dispatch: transcript が rotate される (channel モード)", async () => {
    const h = await harness({
      C01: { session: { mode: "channel" } },
    });
    const sessionKey = "C01";
    const workdir = join(h.workdirRoot, "C01", "channel");

    await mkdir(workdir, { recursive: true });
    await writeFile(join(workdir, "session.jsonl"), "OLD TRANSCRIPT\n");
    const previousStartedAt = new Date(Date.now() - 60_000);
    await h.controlState.sessions.put(sessionKey, {
      channelId: "C01",
      threadTs: "channel",
      triggerMessageId: "1699999999.000000",
      startedAt: previousStartedAt,
      lastActiveAt: new Date(),
      endedAt: new Date(),
      rotateRequestedAt: new Date(),
    });

    const trigger = message({ mentionsBot: true, text: "hello again" });
    await h.dispatcher.handle(trigger);
    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );

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
      (await h.controlState.sessions.get(sessionKey))?.rotateRequestedAt,
    ).toBeUndefined();
    // Transcript が世代交代したので startedAt は置き直される
    // (session-model.md §6, state.md §3.2)
    const startedAt = (await h.controlState.sessions.get(sessionKey))
      ?.startedAt;
    expect(startedAt?.getTime()).toBeGreaterThan(previousStartedAt.getTime());
  });

  it("マーカーあり状態で次のメッセージ → dispatch: transcript が rotate される (thread モード)", async () => {
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "hello again" });
    const sessionKey = threadKeyOf(trigger);
    const workdir = join(h.workdirRoot, "C01", trigger.id);

    await mkdir(workdir, { recursive: true });
    await writeFile(join(workdir, "session.jsonl"), "OLD TRANSCRIPT\n");
    await h.controlState.sessions.put(sessionKey, {
      channelId: "C01",
      threadTs: trigger.id,
      triggerMessageId: trigger.id,
      startedAt: new Date(),
      lastActiveAt: new Date(),
      endedAt: new Date(),
      rotateRequestedAt: new Date(),
    });

    await h.dispatcher.handle(trigger);
    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );

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
      (await h.controlState.sessions.get(sessionKey))?.rotateRequestedAt,
    ).toBeUndefined();
  });

  it("/new 続きの指示: マーカーが書かれ、dispatch が走り、初回 prompt に続きの指示が含まれ /new は含まれない", async () => {
    const h = await harness();
    const trigger = message({
      mentionsBot: true,
      text: "/new 続きの指示",
    });

    await h.dispatcher.handle(trigger);
    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );

    const sessionKey = threadKeyOf(trigger);
    // マーカーは書き込まれた後、同じ起動内で消費 (rotate) されクリアされる
    // (session-model.md §5.1)。消費された痕跡は rotate ログで確認する
    expect(
      h
        .logLines()
        .some((line) => line.msg === "manual reset: transcript rotated"),
    ).toBe(true);
    expect(
      (await h.controlState.sessions.get(sessionKey))?.rotateRequestedAt,
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

    await h.dispatcher.handle(trigger);
    // 非同期の副作用が万一起きても検出できるよう少し待つ
    await sleep(50);

    expect(h.poster.calls).toEqual([]);
    const sessionKey = threadKeyOf(trigger);
    expect(await h.controlState.sessions.get(sessionKey)).toBeNull();
    expect(h.dispatcher.activeSessionCount).toBe(0);
  });

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

    await h.dispatcher.handle(trigger);
    await sleep(50);

    expect(h.poster.calls).toEqual([]);
    expect(h.dispatcher.activeSessionCount).toBe(0);
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
    await h.dispatcher.handle(botTrigger);
    await waitFor(() => h.poster.calls.length === 1, "bot-triggered reply");
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );

    const humanTrigger = message({
      id: "1700000000.000900",
      sender: { id: "U01", isBot: false, isSelf: false },
      text: "ALERT: disk full",
    });
    await h.dispatcher.handle(humanTrigger);
    await sleep(50);

    expect(h.poster.calls.length).toBe(1);
    expect(h.dispatcher.activeSessionCount).toBe(0);
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

    await h.dispatcher.handle(trigger);
    await sleep(50);

    // when (keyword: ALERT) にマッチしないので何も起きない。/new のコマンド化も
    // されていない (rotateRequestedAt が書かれない・ack も出ない)
    expect(h.poster.calls).toEqual([]);
    expect(h.dispatcher.activeSessionCount).toBe(0);
    const sessionKey = threadKeyOf(trigger);
    expect(await h.controlState.sessions.get(sessionKey)).toBeNull();
  });

  it("allowBots: true で実行中セッションへの bot 投稿が steer される", async () => {
    const h = await harness({
      C01: { trigger: { allowBots: true, when: [{ kind: "mention" }] } },
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

    const botFollowUp = message({
      id: "1700000001.000200",
      conversation: { channelId: "C01", threadTs },
      sender: { id: "B01", isBot: true, isSelf: false },
      text: "bot follow-up",
    });
    await h.dispatcher.handle(botFollowUp);

    await waitFor(() => h.poster.calls.length === 1, "steered reply posted");
    expect(h.poster.calls[0]?.text).toBe(
      `steered: ${renderEvent(botFollowUp, replyThreadKeyOf(botFollowUp))}`,
    );

    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );
    const commands = (await h.commandsLog("C01", threadTs)).map((line) =>
      JSON.parse(line),
    );
    expect(commands.map((c) => c.type)).toEqual(["prompt", "steer"]);
  });

  it("@bot /disable (idle): channels store に enabled=false + updatedBy が書かれ、:no_bell: ack が配送される。pi は起動しない", async () => {
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "/disable" });

    await h.dispatcher.handle(trigger);

    await waitFor(() => h.poster.calls.length === 1, "ack posted");
    expect(h.poster.calls[0]?.text).toBe(
      ":no_bell: このチャンネルでの起動を無効化しました。`/enable` (bot へのメンション付き) で再開できます",
    );

    const doc = await h.controlState.channels.get("C01");
    expect(doc?.enabled).toBe(false);
    expect(doc?.updatedBy).toBe("U01");

    expect(h.dispatcher.activeSessionCount).toBe(0);
  });

  it("disabled 状態で mention メッセージ: 起動しない (poster 呼び出しなし)、info ログ 'channel disabled'", async () => {
    const h = await harness();
    await h.controlState.channels.put("C01", {
      enabled: false,
      updatedAt: new Date(),
      updatedBy: "U99",
    });

    const trigger = message({ mentionsBot: true, text: "question here" });
    await h.dispatcher.handle(trigger);
    await sleep(50);

    expect(h.poster.calls).toEqual([]);
    expect(h.dispatcher.activeSessionCount).toBe(0);
    expect(
      h
        .logLines()
        .some((line) => String(line.msg ?? "").includes("channel disabled")),
    ).toBe(true);
  });

  it("disabled 状態で @bot /enable: enabled=true になり :bell: ack。その後の mention は通常どおり起動する", async () => {
    const h = await harness();
    await h.controlState.channels.put("C01", {
      enabled: false,
      updatedAt: new Date(),
      updatedBy: "U99",
    });

    const enableCmd = message({ mentionsBot: true, text: "/enable" });
    await h.dispatcher.handle(enableCmd);

    await waitFor(() => h.poster.calls.length === 1, "enable ack posted");
    expect(h.poster.calls[0]?.text).toBe(
      ":bell: このチャンネルでの起動を有効化しました",
    );
    expect((await h.controlState.channels.get("C01"))?.enabled).toBe(true);

    const trigger = message({
      id: "1700000001.000200",
      mentionsBot: true,
      text: "question here",
      metadata: { eventId: "Ev-after-enable" },
    });
    await h.dispatcher.handle(trigger);
    await waitFor(() => h.poster.calls.length === 2, "reply posted");
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );
  });

  it("実行中セッションがある Session で /disable: ack が返り、以降のメッセージが steer されない。実行中セッション自体は完走する", async () => {
    const h = await harness();
    const trigger = message({ mentionsBot: true, text: "WAIT_FOR_STEER" });
    await h.dispatcher.handle(trigger);
    await waitFor(
      () => h.dispatcher.activeSessionCount === 1,
      "session running",
    );

    const disableCmd = message({
      id: "1700000001.000200",
      conversation: { channelId: "C01", threadTs: trigger.id },
      mentionsBot: true,
      text: "/disable",
      metadata: { eventId: "Ev-disable-cmd" },
    });
    await h.dispatcher.handle(disableCmd);

    await waitFor(() => h.poster.calls.length === 1, "disable ack posted");
    expect(h.poster.calls[0]?.text).toBe(
      ":no_bell: このチャンネルでの起動を無効化しました。`/enable` (bot へのメンション付き) で再開できます",
    );
    expect((await h.controlState.channels.get("C01"))?.enabled).toBe(false);

    // disabled 中なので以降のメッセージは steer されない
    const followUp = message({
      id: "1700000002.000300",
      conversation: { channelId: "C01", threadTs: trigger.id },
      mentionsBot: true,
      text: "should not be steered",
      metadata: { eventId: "Ev-follow-up" },
    });
    await h.dispatcher.handle(followUp);
    await sleep(50);
    expect(h.poster.calls.length).toBe(1);

    // 実行中セッション自体は完走する (WAIT_FOR_STEER を解除する追いメッセージが
    // 届かないため、fake-pi へ直接 steer 相当のコマンドは送れない。ここでは
    // セッションが disable 後も生きたままであることだけ確認する)
    expect(h.dispatcher.activeSessionCount).toBe(1);
  });

  it("disabled 状態での reaction 起動: 起動しない", async () => {
    const fetch: FetchMessage = async () => ({ text: "should not be used" });
    const h = await harness(
      { C01: { trigger: { when: [{ kind: "reaction", emoji: ["eyes"] }] } } },
      { fetchMessage: fetch },
    );
    await h.controlState.channels.put("C01", {
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
    await h.dispatcher.handleReaction(target);
    await sleep(50);

    expect(h.dispatcher.activeSessionCount).toBe(0);
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

    await h.dispatcher.handle(trigger);
    await sleep(50);

    // when (keyword: ALERT) にマッチしないので何も起きない。/disable のコマンド化も
    // されていないため channels store も変わらない
    expect(h.poster.calls).toEqual([]);
    expect(await h.controlState.channels.get("C01")).toBeNull();
    expect(h.dispatcher.activeSessionCount).toBe(0);
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
    await h.controlState.channels.put("C01", {
      enabled: false,
      updatedAt: new Date(),
      updatedBy: "U99",
    });

    const trigger = message({ text: "please do something" });
    await h.dispatcher.handle(trigger);
    await sleep(50);

    expect(classifierCalls).toEqual([]);
    expect(h.dispatcher.activeSessionCount).toBe(0);
    expect(h.poster.calls).toEqual([]);
    expect(
      h
        .logLines()
        .some((line) => String(line.msg ?? "").includes("channel disabled")),
    ).toBe(true);
  });

  it("disabled 状態で @bot /new: drop される (marker 書き込みなし・dispatch なし・ack なし)", async () => {
    const h = await harness();
    await h.controlState.channels.put("C01", {
      enabled: false,
      updatedAt: new Date(),
      updatedBy: "U99",
    });

    const trigger = message({ mentionsBot: true, text: "/new" });
    await h.dispatcher.handle(trigger);
    await sleep(50);

    expect(h.poster.calls).toEqual([]);
    expect(h.dispatcher.activeSessionCount).toBe(0);
    const sessionKey = threadKeyOf(trigger);
    expect(await h.controlState.sessions.get(sessionKey)).toBeNull();
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
          },
          session: { affinity: { debounceSec: 0.2 } },
        },
      });

      const trigger = message({ text: "hello there" });
      await h.dispatcher.handle(trigger);

      // debounce 待機中に /disable する (mention 付きなのでバイパスされず即時反映)
      const disableCmd = message({
        id: "1700000001.000200",
        mentionsBot: true,
        text: "/disable",
        metadata: { eventId: "Ev-disable-cmd" },
      });
      await h.dispatcher.handle(disableCmd);
      expect((await h.controlState.channels.get("C01"))?.enabled).toBe(false);

      // debounce タイマーを進める
      await vi.advanceTimersByTimeAsync(500);
      // マイクロタスク経由の非同期処理 (isChannelDisabled 等) を流し切る
      await vi.runAllTimersAsync();

      expect(h.dispatcher.activeSessionCount).toBe(0);
      expect(
        h
          .logLines()
          .some((line) =>
            String(line.msg ?? "").includes("debounced dispatch skipped"),
          ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-dispatches the same thread after a failed dispatch (item is not lost)", async () => {
    // restore を 1 回だけ失敗させて 起動を落とす (起動失敗 = ack されないので
    // inbox に残り、次のイベントで拾い直される。message-dispatch.md §7.4 の穴の解消)
    class FailOnceStorage implements WorkdirStore {
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
    const h = await harness({}, { workdirStore: new FailOnceStorage() });
    const trigger = message({ mentionsBot: true, text: "first try" });
    const threadKey = threadKeyOf(trigger);

    await h.dispatcher.handle(trigger);
    expect(h.dispatcher.activeSessionCount).toBe(0);
    expect(
      h.logLines().some((line) => line.msg === "session dispatch failed"),
    ).toBe(true);
    // item は ack されず inbox に残っている
    expect((await h.controlState.inbox.drain(threadKey)).length).toBe(1);

    // 同スレッドの次のイベントで再 dispatch され、両方の item が拾い直される
    const retry = message({
      id: "1700000000.000400",
      conversation: { channelId: "C01", threadTs: trigger.id },
      mentionsBot: true,
      text: "second try",
    });
    await h.dispatcher.handle(retry);
    await waitFor(() => h.poster.calls.length === 1, "reply posted");
    expect(h.poster.calls[0]?.text).toContain("first try");
    expect(h.poster.calls[0]?.text).toContain("second try");
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );
  });

  it("does not dispatch when the lease is held by another owner", async () => {
    const controlState = new InMemoryControlState();
    const trigger = message({ mentionsBot: true, text: "contended" });
    const sessionKey = threadKeyOf(trigger);
    const other = await controlState.leases.acquire(
      sessionKey,
      "other:999",
      60_000,
    );
    expect(other).not.toBeNull();

    const h = await harness({}, { controlState });
    await h.dispatcher.handle(trigger);

    // dispatch されない (eyes も付かない) が、item は enqueue 済みで保持者の drain が拾える
    expect(h.dispatcher.activeSessionCount).toBe(0);
    expect(h.reactions).toEqual([]);
    expect((await controlState.inbox.drain(sessionKey)).length).toBe(1);
    expect(
      h
        .logLines()
        .some(
          (line) => line.msg === "lease held by another process; enqueued only",
        ),
    ).toBe(true);
  });

  it("starts a new turn (prompt, not steer) for a message that arrives during linger via handle()", async () => {
    // linger 中 (agent_end 後、終了処理完了前) に handle() 経由で追いメッセージが
    // 届くケース。アイドルな pi への steer はターンを開始しないため、この窓では
    // enqueue のみで残し、onAgentEnd の promptPending が prompt として拾い直す
    // 必要がある (steer してしまうと pi は宙吊りになり、以降その Session が壊れる)
    const h = await harness({}, { lingerMs: 300 });
    const trigger = message({ mentionsBot: true, text: "first turn" });
    const threadKey = threadKeyOf(trigger);

    await h.dispatcher.handle(trigger);
    await waitFor(() => h.poster.calls.length === 1, "first reply posted");

    // linger 窓内 (300ms) に、handle() を経由した追いメッセージを送る
    // (trySteerExisting → 修正前は steer、修正後は enqueue のみ)
    await sleep(50);
    const late = message({
      id: "1700000000.000500",
      conversation: { channelId: "C01", threadTs: trigger.id },
      text: "during linger",
    });
    await h.dispatcher.handle(late);

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
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );
    expect(h.logLines().some((line) => line.msg === "session finished")).toBe(
      true,
    );

    // lease が解放されている
    expect(
      await h.controlState.leases.acquire(threadKey, "probe", 1000),
    ).not.toBeNull();
  });

  it("session.affinity.debounceSec: 連投バーストの 2 通が 1 回の dispatch にまとめられる", async () => {
    const h = await harness({
      C01: {
        trigger: {
          when: [{ kind: "passthrough" }],
        },
        session: { affinity: { debounceSec: 0.2 } },
      },
    });
    const first = message({ text: "first burst message" });
    const threadKey = threadKeyOf(first);

    await h.dispatcher.handle(first);
    // debounce 中はまだ dispatch されていない
    expect(h.dispatcher.activeSessionCount).toBe(0);

    await sleep(50); // debounceSec (200ms) 未満のうちに 2 通目を送る
    const second = message({
      id: "1700000000.000700",
      conversation: { channelId: "C01", threadTs: first.id },
      text: "second burst message",
    });
    await h.dispatcher.handle(second);
    expect(h.dispatcher.activeSessionCount).toBe(0);

    await waitFor(
      () => h.poster.calls.length === 1,
      "reply posted after debounce",
    );
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );

    const commands = (await h.commandsLog("C01", first.id)).map((line) =>
      JSON.parse(line),
    );
    // dispatch は 1 回だけ (prompt 1 件) で、初回 prompt に 2 通とも含まれる
    expect(commands.map((c) => c.type)).toEqual(["prompt"]);
    expect(commands[0]?.message).toContain("first burst message");
    expect(commands[0]?.message).toContain("second burst message");
    expect(await h.controlState.inbox.drain(threadKey)).toEqual([]);
  });

  it("session.affinity.debounceSec: 連投バースト A→B→C の 3 通が 1 回の dispatch にまとめられる", async () => {
    const h = await harness({
      C01: {
        trigger: {
          when: [{ kind: "passthrough" }],
        },
        session: { affinity: { debounceSec: 0.2 } },
      },
    });
    const a = message({ text: "message A" });
    const threadKey = threadKeyOf(a);

    await h.dispatcher.handle(a);
    expect(h.dispatcher.activeSessionCount).toBe(0);

    await sleep(50); // debounceSec (200ms) 未満のうちに B を送る (スライドして延長)
    const b = message({
      id: "1700000000.000700",
      conversation: { channelId: "C01", threadTs: a.id },
      text: "message B",
    });
    await h.dispatcher.handle(b);
    expect(h.dispatcher.activeSessionCount).toBe(0);

    await sleep(50); // debounceSec 未満のうちに C を送る (さらにスライド)
    const c = message({
      id: "1700000000.000800",
      conversation: { channelId: "C01", threadTs: a.id },
      text: "message C",
    });
    await h.dispatcher.handle(c);
    expect(h.dispatcher.activeSessionCount).toBe(0);

    await waitFor(
      () => h.poster.calls.length === 1,
      "reply posted after debounce",
    );
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );

    const commands = (await h.commandsLog("C01", a.id)).map((line) =>
      JSON.parse(line),
    );
    // dispatch は 1 回だけ (prompt 1 件) で、初回 prompt に A/B/C 3 通とも含まれる
    expect(commands.map((c) => c.type)).toEqual(["prompt"]);
    expect(commands[0]?.message).toContain("message A");
    expect(commands[0]?.message).toContain("message B");
    expect(commands[0]?.message).toContain("message C");
    expect(await h.controlState.inbox.drain(threadKey)).toEqual([]);
  });

  it("session.affinity.debounceSec: mentionsBot のメッセージは debounce をバイパスして即 dispatch される", async () => {
    const h = await harness({
      C01: {
        trigger: {
          when: [{ kind: "passthrough" }],
        },
        session: { affinity: { debounceSec: 5 } },
      },
    });
    const trigger = message({
      mentionsBot: true,
      text: "mention bypasses debounce",
    });

    await h.dispatcher.handle(trigger);

    // debounceSec = 5s だが mentionsBot なので即座に dispatch される (待たない)
    await waitFor(
      () => h.poster.calls.length === 1,
      "reply posted immediately",
      2000,
    );
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );

    const commands = (await h.commandsLog("C01", trigger.id)).map((line) =>
      JSON.parse(line),
    );
    expect(commands.map((c) => c.type)).toEqual(["prompt"]);
  });

  it("稼働中の合流: scope=channel でチャンネル直下の 2 通目が既存セッションへ steer され、新セッションは立たない", async () => {
    const h = await harness({
      C01: { session: { affinity: { scope: "channel" } } },
    });
    const a = message({ mentionsBot: true, text: "WAIT_FOR_STEER" });

    await h.dispatcher.handle(a);
    await waitFor(
      () => h.dispatcher.activeSessionCount === 1,
      "session A running",
    );

    // チャンネル直下 (threadTs なし) の 2 通目。gate 通過 (mention) だが
    // 稼働中 Session A へ合流するため新セッションは立たない
    const b = message({
      id: "1700000000.000700",
      mentionsBot: true,
      text: "merged follow-up B",
      metadata: { eventId: "Ev-affinity-b" },
    });
    await h.dispatcher.handle(b);

    expect(h.dispatcher.activeSessionCount).toBe(1);
    await waitFor(() => h.poster.calls.length === 1, "steered reply posted");
    expect(h.poster.calls[0]?.text).toBe(
      `steered: ${renderEvent(b, replyThreadKeyOf(b))}`,
    );

    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );
    const commands = (await h.commandsLog("C01", a.id)).map((line) =>
      JSON.parse(line),
    );
    expect(commands.map((c) => c.type)).toEqual(["prompt", "steer"]);
  });

  it("終了後の窓内 resume: windowSec 内のチャンネル直下投稿が A のSession (workdir) で resume される", async () => {
    const h = await harness({
      C01: { session: { affinity: { scope: "channel", windowSec: 600 } } },
    });
    const a = message({ mentionsBot: true, text: "first lane message" });

    await h.dispatcher.handle(a);
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session A finished",
    );
    expect((await h.controlState.threads.latest("C01"))?.sessionKey).toBe(
      threadKeyOf(a),
    );
    expect(
      (await h.controlState.threads.latest("C01"))?.endedAt,
    ).toBeInstanceOf(Date);

    // Session の同一性は sessionKey なので、別トリガーで resume しても
    // startedAt は引き継がれる (session-model.md §6, state.md §3.2)
    const startedAtAfterFirstTurn = (
      await h.controlState.sessions.get(threadKeyOf(a))
    )?.startedAt;
    expect(startedAtAfterFirstTurn).toBeInstanceOf(Date);

    const c = message({
      id: "1700000000.000700",
      mentionsBot: true,
      text: "channel-root follow-up within window",
      metadata: { eventId: "Ev-affinity-c" },
    });
    await h.dispatcher.handle(c);
    await waitFor(() => h.poster.calls.length === 1, "resumed reply posted");
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session A done again",
    );

    expect(
      (await h.controlState.sessions.get(threadKeyOf(a)))?.startedAt,
    ).toEqual(startedAtAfterFirstTurn);

    // A の Session (workdir = C01/<A.id>) の commands.jsonl に両方の prompt が
    // 積まれている = C は自分の Session でなく A の Session で resume された
    const commands = (await h.commandsLog("C01", a.id)).map((line) =>
      JSON.parse(line),
    );
    expect(commands.filter((cmd) => cmd.type === "prompt")).toHaveLength(2);
    expect(commands[1]?.message).toContain("channel-root follow-up");

    // C 自身の Session (naturalKey) では何も起きていない
    await expect(stat(join(h.workdirRoot, "C01", c.id))).rejects.toThrow(
      /ENOENT/,
    );
  });

  it("窓外は新規: windowSec 未設定 (既定 0) だと終了後のチャンネル直下投稿は自分を根に新規 Session を作る", async () => {
    const h = await harness({
      C01: { session: { affinity: { scope: "channel" } } },
    });
    const a = message({ mentionsBot: true, text: "first lane message" });

    await h.dispatcher.handle(a);
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session A finished",
    );

    const d = message({
      id: "1700000000.000800",
      mentionsBot: true,
      text: "channel-root follow-up outside window",
      metadata: { eventId: "Ev-affinity-d" },
    });
    await h.dispatcher.handle(d);
    await waitFor(() => h.poster.calls.length === 2, "second reply posted");
    await waitFor(() => h.dispatcher.activeSessionCount === 0, "lane D done");

    // D は自分の Session (workdir = C01/<D.id>) で新規に prompt された (resume でない)
    const commandsD = (await h.commandsLog("C01", d.id)).map((line) =>
      JSON.parse(line),
    );
    expect(commandsD.filter((cmd) => cmd.type === "prompt")).toHaveLength(1);
    // A の Session には増えていない
    const commandsA = (await h.commandsLog("C01", a.id)).map((line) =>
      JSON.parse(line),
    );
    expect(commandsA.filter((cmd) => cmd.type === "prompt")).toHaveLength(1);
  });

  it("スレッド内は合流しない: scope=channel でも threadTs 付きイベントは自分のスレッドの Session になる", async () => {
    const h = await harness({
      C01: { session: { affinity: { scope: "channel" } } },
    });
    const a = message({ mentionsBot: true, text: "WAIT_FOR_STEER" });

    await h.dispatcher.handle(a);
    await waitFor(
      () => h.dispatcher.activeSessionCount === 1,
      "session A running",
    );

    // 別スレッド (a とは無関係の threadTs) 内での mention 付き発言。
    // スレッド内なので合流対象にならず、そのスレッド自身の新規 Session になる
    const otherThreadRoot = "1700000000.000500";
    const inThread = message({
      id: "1700000000.000600",
      conversation: { channelId: "C01", threadTs: otherThreadRoot },
      mentionsBot: true,
      text: "own thread message",
      metadata: { eventId: "Ev-affinity-thread" },
    });
    await h.dispatcher.handle(inThread);

    // 新しい Session が増える (A への合流ではない)
    expect(h.dispatcher.activeSessionCount).toBe(2);

    await waitFor(() => h.poster.calls.length === 1, "own-thread reply posted");
    expect(h.poster.calls[0]?.text).toBe(
      `echo: ${renderEvent(inThread, replyThreadKeyOf(inThread))}`,
    );
    await waitFor(
      () => h.dispatcher.activeSessionCount === 1,
      "own-thread session removed",
    );

    // A の Session には steer が来ていない (自分のスレッドの Session として独立処理された)
    const commandsA = (await h.commandsLog("C01", a.id)).map((line) =>
      JSON.parse(line),
    );
    expect(commandsA.map((cmd) => cmd.type)).toEqual(["prompt"]);

    // A を畳んで後始末する
    const wrapUp = message({
      id: "1700000000.000900",
      conversation: { channelId: "C01", threadTs: a.id },
      mentionsBot: true,
      text: "wrap up A",
      metadata: { eventId: "Ev-affinity-wrapup" },
    });
    await h.dispatcher.handle(wrapUp);
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session A done",
    );
  });

  it("/new は合流しない: pointer が窓内でも /new テキストは自分の Session で新規起動する", async () => {
    const h = await harness({
      C01: { session: { affinity: { scope: "channel", windowSec: 600 } } },
    });
    const a = message({ mentionsBot: true, text: "first lane message" });

    await h.dispatcher.handle(a);
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session A finished",
    );

    const newCmd = message({
      id: "1700000000.000700",
      mentionsBot: true,
      text: "/new 続きではなく新規です",
      metadata: { eventId: "Ev-affinity-new" },
    });
    await h.dispatcher.handle(newCmd);
    await waitFor(() => h.poster.calls.length === 2, "second reply posted");
    await waitFor(() => h.dispatcher.activeSessionCount === 0, "lane new done");

    // /new の Session (workdir = C01/<newCmd.id>) で新規に 1 件 prompt された
    const commandsNew = (await h.commandsLog("C01", newCmd.id)).map((line) =>
      JSON.parse(line),
    );
    expect(commandsNew.filter((cmd) => cmd.type === "prompt")).toHaveLength(1);
    expect(commandsNew[0]?.message).toContain("続きではなく新規です");
    // A の Session には増えていない (合流していない)
    const commandsA = (await h.commandsLog("C01", a.id)).map((line) =>
      JSON.parse(line),
    );
    expect(commandsA.filter((cmd) => cmd.type === "prompt")).toHaveLength(1);
  });

  it("alias 経由の追い返信: 合流したイベントのスレッド内発言が gate なしで同セッションへ steer される", async () => {
    const h = await harness({
      C01: { session: { affinity: { scope: "channel" } } },
    });
    // SLOW_TOOL: tool_execution_start を吐いた後 steer 待ち。steer に "NEXT_TOOL" が
    // 含まれるとターンを終わらせず 2 個目の tool_execution_start を吐く (fake-pi の
    // WAIT_FOR_STEER と違い、1 ターン中に複数回 steer を観測できる)
    const a = message({ mentionsBot: true, text: "SLOW_TOOL" });

    await h.dispatcher.handle(a);
    await waitFor(
      () => h.dispatcher.activeSessionCount === 1,
      "session A running",
    );
    await waitFor(async () => {
      const commands = await h.commandsLog("C01", a.id).catch(() => []);
      return commands.length >= 1;
    }, "initial prompt recorded");

    // B (mention 付き・チャンネル直下) が稼働中の A へ合流する。NEXT_TOOL を含めて
    // ターンを終わらせず、後続の合流スレッド内発言も同ターンで観測できるようにする
    const b = message({
      id: "1700000000.000700",
      mentionsBot: true,
      text: "merged follow-up B NEXT_TOOL",
      metadata: { eventId: "Ev-affinity-alias-b" },
    });
    await h.dispatcher.handle(b);
    expect(h.dispatcher.activeSessionCount).toBe(1);
    await waitFor(async () => {
      const commands = (await h.commandsLog("C01", a.id)).map((line) =>
        JSON.parse(line),
      );
      return commands.filter((cmd) => cmd.type === "steer").length >= 1;
    }, "B steered into session A");

    // B のスレッド内 (threadTs = b.id) の追い発言。mention なし。
    // 既定 gate は mention のみだが、alias 経由で合流先 Session へ steer されるため
    // gate 評価をバイパスして届く
    const followUpInBThread = message({
      id: "1700000000.000800",
      conversation: { channelId: "C01", threadTs: b.id },
      mentionsBot: false,
      text: "追い返信 (mention なし)",
      metadata: { eventId: "Ev-affinity-alias-followup" },
    });
    await h.dispatcher.handle(followUpInBThread);

    expect(h.dispatcher.activeSessionCount).toBe(1);
    await waitFor(() => h.poster.calls.length === 1, "steered reply posted");
    expect(h.poster.calls[0]?.text).toBe(
      `steered: ${renderEvent(followUpInBThread, replyThreadKeyOf(followUpInBThread))}`,
    );

    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );
    const commands = (await h.commandsLog("C01", a.id)).map((line) =>
      JSON.parse(line),
    );
    expect(commands.map((cmd) => cmd.type)).toEqual([
      "prompt",
      "steer",
      "steer",
    ]);
  });

  it("再起動後の alias: ControlState を共有する別 Dispatcher でも、合流スレッドへの返信が合流先 Session へ届く", async () => {
    // threads.bind は Control State に永続化されるので、プロセス再起動 (= プロセス内の
    // alias が失われた状態) でも threads.resolve で合流先 sessionKey を引ける
    // (state.md §3.3)
    const controlState = new InMemoryControlState();
    const docs: Record<string, ChannelConfig> = {
      C01: { session: { affinity: { scope: "channel" } } },
    };
    const h1 = await harness(docs, { controlState });

    const a = message({ mentionsBot: true, text: "first lane message" });
    await h1.dispatcher.handle(a);
    await waitFor(
      () => h1.dispatcher.activeSessionCount === 1,
      "session A running",
    );

    // B (チャンネル直下) が稼働中の A へ合流し、alias が張られる
    const b = message({
      id: "1700000000.000700",
      mentionsBot: true,
      text: "merged follow-up B",
      metadata: { eventId: "Ev-restart-alias-b" },
    });
    await h1.dispatcher.handle(b);
    expect(h1.dispatcher.activeSessionCount).toBe(1);
    await waitFor(
      () => h1.dispatcher.activeSessionCount === 0,
      "session A finished",
    );

    // alias が Control State に残っている
    expect(await controlState.threads.resolve(threadKeyOf(b))).toBe(
      threadKeyOf(a),
    );

    // 再起動を模して、同じ Control State / workdirRoot を共有する別 Dispatcher を作る
    // (h2 のプロセス内 alias は空)
    const h2 = await harness(docs, {
      controlState,
      workdirRoot: h1.workdirRoot,
    });

    // B のスレッド内 (threadTs = b.id) への追い発言。B 用の新Session ではなく、
    // 永続 alias 経由で A の Session (sessionKey = C01:<a.id>) で resume される
    const followUpInBThread = message({
      id: "1700000000.000800",
      conversation: { channelId: "C01", threadTs: b.id },
      mentionsBot: true,
      text: "再起動後の追い返信",
      metadata: { eventId: "Ev-restart-alias-followup" },
    });
    await h2.dispatcher.handle(followUpInBThread);

    await waitFor(() => h2.poster.calls.length === 1, "resumed reply posted");
    expect(h2.poster.calls[0]?.text).toBe(
      `echo: ${renderEvent(followUpInBThread, replyThreadKeyOf(followUpInBThread))}`,
    );
    await waitFor(
      () => h2.dispatcher.activeSessionCount === 0,
      "session removed",
    );

    // A の Session (workdir: C01/<a.id>) で 2 回目の prompt が走っている。
    // B のスレッド (C01/<b.id>) には新しい Session ができていない
    const commandsA = (await h2.commandsLog("C01", a.id)).map((line) =>
      JSON.parse(line),
    );
    expect(commandsA.filter((cmd) => cmd.type === "prompt").length).toBe(2);
    await expect(h2.commandsLog("C01", b.id)).rejects.toThrow(/ENOENT/);
  });

  it("progress notice: affinity 合流後も進捗投稿先はターンを開始した先頭発言のスレッドに留まり、新規ターンで差し替わる", async () => {
    // 進捗投稿先は「そのターンを開始した先頭発言の thread_key」に固定し、
    // affinity 合流で同一ターン中に合流した B の宛先が異なっていても
    // 差し替えない。ターンが終わり C が新規ターンを開始すると、
    // 今度は C のスレッドへ差し替わる
    const h = await harness(
      { C01: { session: { affinity: { scope: "channel" } } } },
      { progressNoticeIntervalMs: 30 },
    );
    const a = message({ mentionsBot: true, text: "SLOW_TOOL" });

    await h.dispatcher.handle(a);
    await waitFor(() => h.poster.calls.length >= 1, "initial progress posted");
    // 初回の進捗投稿は A のスレッド (channelId + threadTs = a.id)
    expect(h.poster.calls[0]?.threadTs).toBe(a.id);
    const messagesToAAfterInitial = h.poster.calls.length;

    // B (mention 付き・チャンネル直下・別スレッド) が稼働中の A へ合流する。
    // NEXT_TOOL を含めてターンを終わらせず、進捗テキストを確実に変化させる
    const b = message({
      id: "1700000000.000700",
      mentionsBot: true,
      text: "merged follow-up B NEXT_TOOL",
      metadata: { eventId: "Ev-progress-affinity-b" },
    });
    await h.dispatcher.handle(b);
    await waitFor(async () => {
      try {
        const commands = (await h.commandsLog("C01", a.id)).map((line) =>
          JSON.parse(line),
        );
        return commands.filter((cmd) => cmd.type === "steer").length >= 1;
      } catch {
        return false;
      }
    }, "B steered into session A");

    // NEXT_TOOL で進んだ 2 個目の tool_execution_start がタイマーに反映される
    // (dummy_tool / sleep 300 は 2 回目の tool_execution_start でも同じ引数だが、
    // step カウントが増えてテキストが変わるので update が発生するはず) のを待つ
    await waitFor(
      () => h.poster.updateCalls.length >= 1,
      "progress updated after B merged",
    );

    // 合流後も進捗の新規投稿・更新は一切 B のスレッド (channelId + threadTs = b.id)
    // に向かっていない。新規投稿は増えていない (A スレッドへの初回投稿のみ)
    expect(h.poster.calls).toHaveLength(messagesToAAfterInitial);
    expect(h.poster.calls.every((c) => c.threadTs !== b.id)).toBe(true);
    // update は既存の A 進捗メッセージ (msg-1) に対して行われている
    expect(h.poster.updateCalls.every((c) => c.messageId === "msg-1")).toBe(
      true,
    );

    // ターンを終わらせる
    const wrapUp = message({
      id: "1700000000.000800",
      conversation: { channelId: "C01", threadTs: a.id },
      mentionsBot: true,
      text: "wrap it up",
      metadata: { eventId: "Ev-progress-affinity-wrapup" },
    });
    await h.dispatcher.handle(wrapUp);
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session A finished",
    );

    // 新規ターン C (mention 付き・チャンネル直下・また別スレッド)。今度は
    // 新規ターンなので進捗投稿先が C のスレッドへ差し替わる
    const c = message({
      id: "1700000000.000900",
      mentionsBot: true,
      text: "SLOW_TOOL",
      metadata: { eventId: "Ev-progress-affinity-c" },
    });
    await h.dispatcher.handle(c);
    await waitFor(
      () => h.poster.calls.some((call) => call.threadTs === c.id),
      "progress posted to C's own thread",
    );

    // 後始末: C のターンも畳んでおく
    const wrapUpC = message({
      id: "1700000000.001000",
      conversation: { channelId: "C01", threadTs: c.id },
      mentionsBot: true,
      text: "wrap it up",
      metadata: { eventId: "Ev-progress-affinity-wrapup-c" },
    });
    await h.dispatcher.handle(wrapUpC);
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "lane C finished",
    );
  });

  it("scope 未設定は従来動作: A 実行中のチャンネル直下メッセージ B は B 自身の Session で別セッションが立つ", async () => {
    const h = await harness(); // affinity 未設定
    const a = message({ mentionsBot: true, text: "WAIT_FOR_STEER" });

    await h.dispatcher.handle(a);
    await waitFor(
      () => h.dispatcher.activeSessionCount === 1,
      "session A running",
    );

    const b = message({
      id: "1700000000.000700",
      mentionsBot: true,
      text: "independent B",
      metadata: { eventId: "Ev-no-affinity-b" },
    });
    await h.dispatcher.handle(b);

    // 合流せず、B 自身の新規 Session が立つ (2 セッション同時稼働)
    expect(h.dispatcher.activeSessionCount).toBe(2);

    await waitFor(() => h.poster.calls.length === 1, "B's own reply posted");
    expect(h.poster.calls[0]?.text).toBe(
      `echo: ${renderEvent(b, replyThreadKeyOf(b))}`,
    );
    await waitFor(
      () => h.dispatcher.activeSessionCount === 1,
      "B's session removed",
    );

    // A の Session には steer が来ていない
    const commandsA = (await h.commandsLog("C01", a.id)).map((line) =>
      JSON.parse(line),
    );
    expect(commandsA.map((cmd) => cmd.type)).toEqual(["prompt"]);

    // A を畳んで後始末する
    const wrapUp = message({
      id: "1700000000.000900",
      conversation: { channelId: "C01", threadTs: a.id },
      mentionsBot: true,
      text: "wrap up A",
      metadata: { eventId: "Ev-no-affinity-wrapup" },
    });
    await h.dispatcher.handle(wrapUp);
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session A done",
    );
  });

  it("終了時の pointer: セッション完走後、threads.latest に endedAt が入っている", async () => {
    const h = await harness({
      C01: { session: { affinity: { scope: "channel" } } },
    });
    const a = message({ mentionsBot: true, text: "finish please" });

    await h.dispatcher.handle(a);
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session A finished",
    );

    const latest = await h.controlState.threads.latest("C01");
    expect(latest?.sessionKey).toBe(threadKeyOf(a));
    expect(latest?.endedAt).toBeInstanceOf(Date);
    expect(latest?.lastActiveAt).toBeInstanceOf(Date);
  });

  it("debounce との合成: scope=channel + debounceSec で、待機中 Session への後続チャンネル直下投稿が合流し 1 セッションに束ねられる", async () => {
    const h = await harness({
      C01: {
        trigger: { when: [{ kind: "passthrough" }] },
        session: { affinity: { scope: "channel", debounceSec: 0.2 } },
      },
    });
    const a = message({ text: "burst message A" });

    await h.dispatcher.handle(a);
    // debounce 待機中はまだ dispatch されない
    expect(h.dispatcher.activeSessionCount).toBe(0);

    await sleep(50); // debounceSec (200ms) 未満のうちに 2 通目を送る
    const b = message({
      id: "1700000000.000700",
      text: "burst message B",
      metadata: { eventId: "Ev-affinity-debounce-b" },
    });
    await h.dispatcher.handle(b);
    expect(h.dispatcher.activeSessionCount).toBe(0);

    await waitFor(
      () => h.poster.calls.length === 1,
      "reply posted after debounce",
    );
    await waitFor(
      () => h.dispatcher.activeSessionCount === 0,
      "session removed",
    );

    // A の Session で 1 回だけ dispatch され、初回 prompt に A/B 両方が含まれる
    const commands = (await h.commandsLog("C01", a.id)).map((line) =>
      JSON.parse(line),
    );
    expect(commands.map((cmd) => cmd.type)).toEqual(["prompt"]);
    expect(commands[0]?.message).toContain("burst message A");
    expect(commands[0]?.message).toContain("burst message B");
  });
});
