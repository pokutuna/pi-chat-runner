import { describe, expect, it, vi } from "vitest";

import type {
  InboundMessage,
  ReactionEvent,
} from "../../../src/ingress/chat-event.js";
import type { Ack } from "../../../src/ingress/ingress.js";
import { createLocalChat } from "../../../src/ingress/local/local-chat.js";

describe("createLocalChat", () => {
  it("post が onEvent に channelId 既定値・mentionsBot・isDm 込みの InboundMessage を渡す", async () => {
    const chat = createLocalChat();
    const received: InboundMessage[] = [];
    await chat.ingress.start(async (e) => {
      if (e.kind === "message") received.push(e);
    });

    await chat.post("hello");

    expect(received).toHaveLength(1);
    const msg = received[0]!;
    expect(msg.conversation.channelId).toBe("local");
    expect(msg.mentionsBot).toBe(false);
    expect(msg.text).toBe("hello");
    expect(msg.sender).toEqual({
      id: "U_LOCAL",
      isBot: false,
      isSelf: false,
      displayName: "you",
    });
    expect(msg.attachments).toEqual([]);
    expect(msg.metadata).toEqual({});
  });

  it("post の options で threadTs・mentionsBot・sender 上書き・isDm を指定できる", async () => {
    const chat = createLocalChat();
    const received: InboundMessage[] = [];
    await chat.ingress.start(async (e) => {
      if (e.kind === "message") received.push(e);
    });

    await chat.post("reply text", {
      channelId: "C999",
      threadTs: "1752800000.000001",
      mentionsBot: true,
      sender: { id: "U_OTHER", isBot: true },
      isDm: true,
    });

    expect(received).toHaveLength(1);
    const msg = received[0]!;
    expect(msg.conversation).toEqual({
      channelId: "C999",
      threadTs: "1752800000.000001",
      isDm: true,
    });
    expect(msg.mentionsBot).toBe(true);
    expect(msg.sender).toEqual({ id: "U_OTHER", isBot: true, isSelf: false });
  });

  it("threadTs はログに実在しない ts でも許容する (存在チェックしない)", async () => {
    const chat = createLocalChat();
    const received: InboundMessage[] = [];
    await chat.ingress.start(async (e) => {
      if (e.kind === "message") received.push(e);
    });

    await chat.post("orphan reply", { threadTs: "9999999999.000999" });

    expect(received[0]!.conversation.threadTs).toBe("9999999999.000999");
  });

  it("start 前の post はバッファされ、start 時に順番どおり流れる", async () => {
    const chat = createLocalChat();
    const received: string[] = [];

    await chat.post("first");
    await chat.post("second");

    await chat.ingress.start(async (e) => {
      if (e.kind === "message") received.push(e.text);
    });

    expect(received).toEqual(["first", "second"]);
  });

  it("ts はプロセス内で単調増加し一意になる (同一秒内でも重複しない)", async () => {
    const chat = createLocalChat();
    const m1 = await chat.post("a");
    const m2 = await chat.post("b");
    const m3 = await chat.post("c");

    expect(m1.ts < m2.ts).toBe(true);
    expect(m2.ts < m3.ts).toBe(true);
    expect(new Set([m1.ts, m2.ts, m3.ts]).size).toBe(3);
    expect(m1.ts).toMatch(/^\d+\.\d{6}$/);
  });

  it("poster.postMessage はログに積まれ message イベントが飛ぶが onEvent へは流れない", async () => {
    const chat = createLocalChat();
    const receivedEvents: unknown[] = [];
    const messageEvents: unknown[] = [];
    await chat.ingress.start(async (e) => {
      receivedEvents.push(e);
    });
    chat.events.on("message", (m) => messageEvents.push(m));

    const { messageId } = await chat.poster.postMessage(
      "local",
      "bot says hi",
      undefined,
      ["/tmp/foo.png"],
    );

    expect(receivedEvents).toHaveLength(0);
    expect(messageEvents).toHaveLength(1);
    const logged = chat.log();
    expect(logged).toHaveLength(1);
    expect(logged[0]!.text).toBe("bot says hi");
    expect(logged[0]!.sender).toEqual({
      id: "U_BOT",
      isBot: true,
      isSelf: true,
      displayName: "bot",
    });
    expect(logged[0]!.files).toEqual(["/tmp/foo.png"]);
    expect(logged[0]!.ts).toBe(messageId);
  });

  it("updateMessage で本文が書き換わり update イベントが飛び、fetchMessage が更新後本文を返す", async () => {
    const chat = createLocalChat();
    const updateEvents: unknown[] = [];
    chat.events.on("update", (m) => updateEvents.push(m));

    const { messageId } = await chat.poster.postMessage("local", "progress: 1");
    await chat.poster.updateMessage("local", messageId, "progress: 2");

    expect(updateEvents).toHaveLength(1);
    const fetched = await chat.fetchMessage("local", messageId);
    expect(fetched?.text).toBe("progress: 2");
  });

  it("updateMessage は未知の messageId を無視する (何もしない)", async () => {
    const chat = createLocalChat();
    await expect(
      chat.poster.updateMessage("local", "9999999999.000001", "x"),
    ).resolves.toBeUndefined();
  });

  it("react の targetIsOwnMessage は bot 投稿への reaction で true になる", async () => {
    const chat = createLocalChat();
    const received: ReactionEvent[] = [];
    await chat.ingress.start(async (e) => {
      if (e.kind === "reaction") received.push(e);
    });

    const { messageId } = await chat.poster.postMessage("local", "bot msg");
    await chat.react(messageId, "eyes");

    expect(received).toHaveLength(1);
    expect(received[0]!.targetIsOwnMessage).toBe(true);
    expect(received[0]!.emoji).toBe("eyes");
    expect(received[0]!.added).toBe(true);
  });

  it("react の targetIsOwnMessage は人間投稿への reaction で false になる", async () => {
    const chat = createLocalChat();
    const received: ReactionEvent[] = [];
    await chat.ingress.start(async (e) => {
      if (e.kind === "reaction") received.push(e);
    });

    const human = await chat.post("human msg");
    await chat.react(human.ts, "thumbsup");

    expect(received[0]!.targetIsOwnMessage).toBe(false);
  });

  it("reactions.add (bot 側) が reactionsLog に記録され reaction イベントが飛ぶ", async () => {
    const chat = createLocalChat();
    const reactionEvents: unknown[] = [];
    chat.events.on("reaction", (r) => reactionEvents.push(r));

    await chat.reactions.addEyes("local", "1752800000.000001");

    expect(reactionEvents).toHaveLength(1);
    expect(chat.reactionsLog()).toEqual([
      { channelId: "local", ts: "1752800000.000001", emoji: "eyes" },
    ]);
  });

  it("fetchMessage が threadTs/userId 込みで解決し、未知の ts で null を返す", async () => {
    const chat = createLocalChat();
    const msg = await chat.post("threaded", {
      threadTs: "1752800000.000001",
      sender: { id: "U_CUSTOM" },
    });

    const fetched = await chat.fetchMessage("local", msg.ts);
    expect(fetched).toEqual({
      text: "threaded",
      threadTs: "1752800000.000001",
      userId: "U_CUSTOM",
    });

    const notFound = await chat.fetchMessage("local", "9999999999.000999");
    expect(notFound).toBeNull();
  });

  it("bySeq / log がログを通し番号 (人間・bot 共有) で参照できる", async () => {
    const chat = createLocalChat();
    await chat.post("one");
    await chat.poster.postMessage("local", "two");
    await chat.post("three");

    expect(chat.log()).toHaveLength(3);
    expect(chat.bySeq(1)?.text).toBe("one");
    expect(chat.bySeq(2)?.text).toBe("two");
    expect(chat.bySeq(3)?.text).toBe("three");
    expect(chat.bySeq(99)).toBeUndefined();
  });

  it("userResolver は固定マップを解決し未知 ID は null を返す", async () => {
    const chat = createLocalChat();
    expect(await chat.userResolver.resolve("U_LOCAL")).toBe("you");
    expect(await chat.userResolver.resolve("U_BOT")).toBe("bot");
    expect(await chat.userResolver.resolve("U_UNKNOWN")).toBeNull();
  });

  it("botUserId を options で指定すると userResolver とログ上の bot sender.id に反映される", async () => {
    const chat = createLocalChat({ botUserId: "U_CUSTOM_BOT" });
    expect(await chat.userResolver.resolve("U_CUSTOM_BOT")).toBe("bot");

    await chat.poster.postMessage("local", "hi");
    expect(chat.log()[0]!.sender.id).toBe("U_CUSTOM_BOT");
  });

  it("post の sender は固定マップにあれば displayName が埋まり、無ければ未設定のまま", async () => {
    const chat = createLocalChat();

    const known = await chat.post("hi", { sender: { id: "U_LOCAL" } });
    expect(known.sender.displayName).toBe("you");

    const unknown = await chat.post("hi", { sender: { id: "U_OTHER" } });
    expect(unknown.sender.displayName).toBeUndefined();
  });

  it("poster.postMessage (bot 投稿) は sender.displayName が常に bot になる", async () => {
    const chat = createLocalChat({ botUserId: "U_CUSTOM_BOT" });
    await chat.poster.postMessage("local", "hi");
    expect(chat.log()[0]!.sender.displayName).toBe("bot");
  });

  it("ts の epochSec は Date.now が巻き戻っても単調増加を保つ", async () => {
    const chat = createLocalChat();
    const nowSpy = vi.spyOn(Date, "now");

    nowSpy.mockReturnValue(1_752_800_010_000);
    const m1 = await chat.post("a");

    // 壁時計が巻き戻る (NTP 補正等)
    nowSpy.mockReturnValue(1_752_800_000_000);
    const m2 = await chat.post("b");
    const m3 = await chat.post("c");

    expect(m1.ts < m2.ts).toBe(true);
    expect(m2.ts < m3.ts).toBe(true);
    expect(m2.ts.split(".")[0]).toBe("1752800010");

    nowSpy.mockRestore();
  });

  it("ingress.start に渡す onEvent の ack は no-op の async 関数", async () => {
    const chat = createLocalChat();
    let capturedAck: Ack | undefined;
    await chat.ingress.start(async (_e, ack) => {
      capturedAck = ack;
    });

    await chat.post("trigger ack capture");

    expect(capturedAck).toBeDefined();
    await expect(capturedAck?.()).resolves.toBeUndefined();
  });
});
