// repl-logic.ts の単体テスト (parseLine 以外)。
//
// ink 化 (repl.tsx) に伴い、chat.post/react 呼び出し・状態遷移・戻り値種別
// (handleLine)、seq/ts 解決 (resolveThreadRef)、表示整形 (formatMessageLine
// 等) を repl.tsx から独立して検証する。旧 repl.test.ts の startRepl 統合
// テスト (直列化・EOF 待ち・チャンネル越境reply) のうち、chat 呼び出しの
// 順序・引数として再現できる部分はここで handleLine 単体テストとして再現する。

import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { Reactions } from "../../../src/egress/reactions.js";
import type { Sender } from "../../../src/ingress/chat-event.js";
import type { Ingress } from "../../../src/ingress/ingress.js";
import {
  displayName,
  formatMessageLine,
  formatReactionLine,
  formatUpdateLine,
  handleLine,
  initialReplState,
  metaCommandHighlightLength,
  promptText,
  resolveThreadRef,
  type ReplState,
} from "../../../src/ingress/local/repl-logic.js";
import type {
  LocalChat,
  LocalChatOutputEvents,
  LoggedMessage,
  PostOptions,
  ReactionRecord,
  ReactOptions,
} from "../../../src/ingress/local/types.js";

// ── フェイク LocalChat (post/react の呼び出しを記録する) ─────────────────

interface RecordedPost {
  text: string;
  options: PostOptions | undefined;
}

interface RecordedReact {
  ts: string;
  emoji: string;
  options: ReactOptions | undefined;
}

function createFakeLocalChat(): LocalChat & {
  postCalls: RecordedPost[];
  reactCalls: RecordedReact[];
} {
  const log: LoggedMessage[] = [];
  const reactionsLog: ReactionRecord[] = [];
  const events = new EventEmitter<LocalChatOutputEvents>();
  const postCalls: RecordedPost[] = [];
  const reactCalls: RecordedReact[] = [];
  let seqCounter = 0;

  const ingress: Ingress = {
    start(_handler) {
      return Promise.resolve();
    },
    stop() {
      return Promise.resolve();
    },
  };

  async function post(
    text: string,
    postOptions?: PostOptions,
  ): Promise<LoggedMessage> {
    postCalls.push({ text, options: postOptions });
    seqCounter += 1;
    const sender: Sender = {
      id: postOptions?.sender?.id ?? "U_LOCAL",
      isBot: postOptions?.sender?.isBot ?? false,
      isSelf: false,
    };
    const message: LoggedMessage = {
      seq: seqCounter,
      ts: String(seqCounter),
      channelId: postOptions?.channelId ?? "local",
      ...(postOptions?.threadTs !== undefined
        ? { threadTs: postOptions.threadTs }
        : {}),
      text,
      sender,
      ...(postOptions?.mentionsBot === true ? { mentionsBot: true } : {}),
    };
    log.push(message);
    events.emit("message", message);
    return message;
  }

  async function react(
    ts: string,
    emoji: string,
    reactOptions?: ReactOptions,
  ): Promise<void> {
    reactCalls.push({ ts, emoji, options: reactOptions });
    const record: ReactionRecord = {
      channelId: reactOptions?.channelId ?? "local",
      ts,
      emoji,
    };
    reactionsLog.push(record);
    events.emit("reaction", record);
    return Promise.resolve();
  }

  return {
    ingress,
    poster: {
      postMessage(_channelId, _text, _threadTs, _files) {
        return Promise.resolve({ messageId: "0.000000" });
      },
      updateMessage(_channelId, _messageId, _text) {
        return Promise.resolve();
      },
    },
    reactions: new Reactions({
      add() {
        return Promise.resolve();
      },
    }),
    userResolver: {
      resolve() {
        return Promise.resolve(null);
      },
    },
    fetchMessage(_channelId, _ts) {
      return Promise.resolve(null);
    },
    post,
    react,
    log(): readonly LoggedMessage[] {
      return log;
    },
    bySeq(seq: number): LoggedMessage | undefined {
      return log.find((m) => m.seq === seq);
    },
    reactionsLog(): readonly ReactionRecord[] {
      return reactionsLog;
    },
    events,
    postCalls,
    reactCalls,
  };
}

describe("metaCommandHighlightLength", () => {
  it.each([
    ["!help", 5],
    ["!help x", 5],
    ["!hel", 0],
    ["!t 3", 2],
    ["!channels", 9],
    ["hello", 0],
    [" !help", 0],
    ["", 0],
  ])("%s -> %i", (input, expected) => {
    expect(metaCommandHighlightLength(input)).toBe(expected);
  });
});

describe("initialReplState / promptText", () => {
  it("初期状態は isDm: false, isBot: false, userId: U_LOCAL", () => {
    expect(initialReplState("C1")).toEqual({
      channelId: "C1",
      userId: "U_LOCAL",
      isBot: false,
      isDm: false,
    });
  });

  it("promptText は channel/user を表示し dm/bot はフラグ時のみ付く", () => {
    const base: ReplState = {
      channelId: "C1",
      userId: "U1",
      isBot: false,
      isDm: false,
    };
    expect(promptText(base)).toBe("#C1 U1> ");
    expect(promptText({ ...base, isDm: true })).toBe("#C1(dm) U1> ");
    expect(promptText({ ...base, isBot: true })).toBe("#C1 U1(bot)> ");
  });

  it("promptText は threadSeq があれば ↳[N]、なければ ↳[ts] を出す", () => {
    const base: ReplState = {
      channelId: "C1",
      userId: "U1",
      isBot: false,
      isDm: false,
    };
    expect(promptText({ ...base, threadTs: "170.5", threadSeq: 3 })).toBe(
      "#C1 U1 ↳[3]> ",
    );
    expect(promptText({ ...base, threadTs: "170.5" })).toBe(
      "#C1 U1 ↳[170.5]> ",
    );
  });

  it("promptText は既定ユーザー U_LOCAL を you と表示する", () => {
    expect(promptText(initialReplState("local"))).toBe("#local you> ");
  });

  it("promptText は isDm で #channel(dm) を出す", () => {
    const base: ReplState = {
      channelId: "local",
      userId: "U_LOCAL",
      isBot: false,
      isDm: true,
    };
    expect(promptText(base)).toBe("#local(dm) you> ");
  });

  it("promptText は isBot で (bot) を付ける", () => {
    const base: ReplState = {
      channelId: "C1",
      userId: "U2",
      isBot: true,
      isDm: false,
    };
    expect(promptText(base)).toBe("#C1 U2(bot)> ");
  });
});

describe("displayName", () => {
  it("displayName があればそれを使う", () => {
    expect(displayName({ id: "U1", displayName: "Alice" })).toBe("Alice");
  });

  it("displayName がなければ id を使う", () => {
    expect(displayName({ id: "U1" })).toBe("U1");
  });
});

describe("resolveThreadRef", () => {
  it("ts 参照はそのまま ts を返し channelId は持たない", () => {
    const chat = createFakeLocalChat();
    const result = resolveThreadRef(chat, { kind: "ts", ts: "1.000001" });
    expect(result).toEqual({ ts: "1.000001" });
  });

  it("seq 参照は対象メッセージの ts と channelId を返す", async () => {
    const chat = createFakeLocalChat();
    await chat.post("hello", { channelId: "A" });
    const result = resolveThreadRef(chat, { kind: "seq", seq: 1 });
    expect(result).toEqual({ ts: "1", channelId: "A" });
  });

  it("存在しない seq 参照はエラーを返す", () => {
    const chat = createFakeLocalChat();
    const result = resolveThreadRef(chat, { kind: "seq", seq: 99 });
    expect(result).toEqual({ error: "unknown reference: [99]" });
  });
});

describe("handleLine", () => {
  it("post: 通常投稿は state.channelId/userId/isBot/isDm をそのまま渡す", async () => {
    const chat = createFakeLocalChat();
    const state: ReplState = {
      channelId: "C1",
      userId: "U9",
      isBot: false,
      isDm: true,
    };

    const result = await handleLine(chat, state, "hello world");

    expect(result).toEqual({ kind: "noop" });
    expect(chat.postCalls).toEqual([
      {
        text: "hello world",
        options: {
          channelId: "C1",
          mentionsBot: false,
          sender: { id: "U9", isBot: false },
          isDm: true,
        },
      },
    ]);
  });

  it("post: @bot は mentionsBot: true で渡す", async () => {
    const chat = createFakeLocalChat();
    const state = initialReplState("C1");

    await handleLine(chat, state, "@bot help me");

    expect(chat.postCalls[0]?.text).toBe("help me");
    expect(chat.postCalls[0]?.options?.mentionsBot).toBe(true);
  });

  it("post: >N でスレッド参照した投稿は解決済み ts/channelId を渡す", async () => {
    const chat = createFakeLocalChat();
    await chat.post("root", { channelId: "A" });
    const state = initialReplState("B");

    const result = await handleLine(chat, state, ">1 reply to A");

    expect(result).toEqual({ kind: "noop" });
    expect(chat.postCalls[1]).toEqual({
      text: "reply to A",
      options: {
        channelId: "A",
        threadTs: "1",
        mentionsBot: false,
        sender: { id: "U_LOCAL", isBot: false },
        isDm: false,
      },
    });
  });

  it("post: 未知の >N 参照は post を呼ばずに error を返す", async () => {
    const chat = createFakeLocalChat();
    const state = initialReplState("C1");

    const result = await handleLine(chat, state, ">99 reply");

    expect(result).toEqual({
      kind: "error",
      message: "unknown reference: [99]",
    });
    expect(chat.postCalls).toHaveLength(0);
  });

  it("thread: !thread N で入ると seq を threadSeq に保持し state-changed を返す", async () => {
    const chat = createFakeLocalChat();
    await chat.post("root", { channelId: "A" });
    const state = initialReplState("B");

    const result = await handleLine(chat, state, "!thread 1");

    expect(result).toEqual({ kind: "state-changed" });
    expect(state.threadTs).toBe("1");
    expect(state.threadSeq).toBe(1);
    // seq 参照先が別チャンネルなら、そのチャンネルへ移る。
    expect(state.channelId).toBe("A");
  });

  it("thread: !t は !thread のエイリアス", async () => {
    const chat = createFakeLocalChat();
    await chat.post("root", { channelId: "A" });
    const state = initialReplState("A");

    const result = await handleLine(chat, state, "!t 1");

    expect(result).toEqual({ kind: "state-changed" });
    expect(state.threadTs).toBe("1");
  });

  it("thread: 生 ts 参照で入ると threadSeq は付かない", async () => {
    const chat = createFakeLocalChat();
    const state = initialReplState("A");

    const result = await handleLine(chat, state, "!thread ts:170.5");

    expect(result).toEqual({ kind: "state-changed" });
    expect(state.threadTs).toBe("170.5");
    expect(state.threadSeq).toBeUndefined();
  });

  it("thread: 入っている間の通常投稿は threadTs へ流れる", async () => {
    const chat = createFakeLocalChat();
    await chat.post("root", { channelId: "A" });
    const state = initialReplState("A");
    await handleLine(chat, state, "!thread 1");

    await handleLine(chat, state, "follow up");

    expect(chat.postCalls[1]?.options?.threadTs).toBe("1");
  });

  it("thread: 入っていても明示 >N はそちらを優先する", async () => {
    const chat = createFakeLocalChat();
    await chat.post("root A", { channelId: "A" });
    await chat.post("root B", { channelId: "A" });
    const state = initialReplState("A");
    await handleLine(chat, state, "!thread 1");

    await handleLine(chat, state, ">2 explicit");

    expect(chat.postCalls[2]?.options?.threadTs).toBe("2");
  });

  it("thread: 未知の !thread 参照は error を返し state を変えない", async () => {
    const chat = createFakeLocalChat();
    const state = initialReplState("A");

    const result = await handleLine(chat, state, "!thread 99");

    expect(result).toEqual({
      kind: "error",
      message: "unknown reference: [99]",
    });
    expect(state.threadTs).toBeUndefined();
  });

  it("thread: !thread に引数がないと usage エラー", async () => {
    const chat = createFakeLocalChat();
    const state = initialReplState("A");

    const result = await handleLine(chat, state, "!thread");

    expect(result).toEqual({
      kind: "error",
      message: "usage: !thread <N|ts:X>",
    });
  });

  it("leave: !leave は threadTs/threadSeq を消し state-changed を返す", async () => {
    const chat = createFakeLocalChat();
    await chat.post("root", { channelId: "A" });
    const state = initialReplState("A");
    await handleLine(chat, state, "!thread 1");

    const result = await handleLine(chat, state, "!leave");

    expect(result).toEqual({ kind: "state-changed" });
    expect(state.threadTs).toBeUndefined();
    expect(state.threadSeq).toBeUndefined();
    // leave 後の投稿はチャンネル直下 (threadTs なし)。
    await handleLine(chat, state, "back to channel");
    expect(chat.postCalls.at(-1)?.options?.threadTs).toBeUndefined();
  });

  it("react: !react N emoji は seq 参照先の channelId で react を呼ぶ", async () => {
    const chat = createFakeLocalChat();
    await chat.post("root", { channelId: "A" });
    const state = initialReplState("B");

    const result = await handleLine(chat, state, "!react 1 eyes");

    expect(result).toEqual({ kind: "noop" });
    expect(chat.reactCalls).toEqual([
      {
        ts: "1",
        emoji: "eyes",
        options: { channelId: "A", sender: { id: "U_LOCAL", isBot: false } },
      },
    ]);
  });

  it("react: 未知の参照は react を呼ばずに error を返す", async () => {
    const chat = createFakeLocalChat();
    const state = initialReplState("C1");

    const result = await handleLine(chat, state, "!react 5 eyes");

    expect(result.kind).toBe("error");
    expect(chat.reactCalls).toHaveLength(0);
  });

  it("channel: state.channelId を書き換え state-changed を返す", async () => {
    const chat = createFakeLocalChat();
    const state = initialReplState("A");

    const result = await handleLine(chat, state, "!channel B");

    expect(result).toEqual({ kind: "state-changed" });
    expect(state.channelId).toBe("B");
  });

  it("dm: state.isDm を書き換え state-changed を返す", async () => {
    const chat = createFakeLocalChat();
    const state = initialReplState("A");

    const result = await handleLine(chat, state, "!dm on");

    expect(result).toEqual({ kind: "state-changed" });
    expect(state.isDm).toBe(true);
  });

  it("user: state.userId/isBot を書き換え state-changed を返す", async () => {
    const chat = createFakeLocalChat();
    const state = initialReplState("A");

    const result = await handleLine(chat, state, "!user U2 --bot");

    expect(result).toEqual({ kind: "state-changed" });
    expect(state.userId).toBe("U2");
    expect(state.isBot).toBe(true);
  });

  it("ignore: 空行は noop で post/react を呼ばない", async () => {
    const chat = createFakeLocalChat();
    const state = initialReplState("A");

    const result = await handleLine(chat, state, "   ");

    expect(result).toEqual({ kind: "noop" });
    expect(chat.postCalls).toHaveLength(0);
  });

  it("help: !help は help を返す", async () => {
    const chat = createFakeLocalChat();
    const state = initialReplState("A");

    expect(await handleLine(chat, state, "!help")).toEqual({ kind: "help" });
  });

  it("channels: !channels は channels を返す", async () => {
    const chat = createFakeLocalChat();
    const state = initialReplState("A");

    expect(await handleLine(chat, state, "!channels")).toEqual({
      kind: "channels",
    });
  });

  it("quit: !quit は quit を返す", async () => {
    const chat = createFakeLocalChat();
    const state = initialReplState("A");

    expect(await handleLine(chat, state, "!quit")).toEqual({ kind: "quit" });
  });

  it("error: 不明なメタコマンドは error を返す", async () => {
    const chat = createFakeLocalChat();
    const state = initialReplState("A");

    const result = await handleLine(chat, state, "!nope");

    expect(result.kind).toBe("error");
  });

  // 旧 repl.test.ts の「複数行を一気に書き込んでも post が到着順に直列処理
  // される」を、呼び出し順序・引数として再現する。
  it("複数行を順に await すると post が到着順に呼ばれる (直列化相当)", async () => {
    const chat = createFakeLocalChat();
    const state = initialReplState("local");

    await handleLine(chat, state, "first");
    await handleLine(chat, state, "second");
    await handleLine(chat, state, "third");

    expect(chat.log().map((m) => m.text)).toEqual(["first", "second", "third"]);
  });

  // 旧 repl.test.ts の「B チャンネルに切替後の >1 reply が [1] の属する
  // チャンネルへ投稿される」を再現する。
  it("チャンネル切替後の >1 reply は [1] の属するチャンネルへ投稿される", async () => {
    const chat = createFakeLocalChat();
    const state = initialReplState("A");

    await handleLine(chat, state, "hello from A");
    await handleLine(chat, state, "!channel B");
    await handleLine(chat, state, ">1 reply to A");

    const messages = chat.log();
    expect(messages).toHaveLength(2);
    expect(messages[0]?.channelId).toBe("A");
    expect(messages[1]?.text).toBe("reply to A");
    expect(messages[1]?.channelId).toBe("A");
  });
});

describe("formatMessageLine", () => {
  it("通常メッセージは [seq] who: text の形式で isSelf: false", async () => {
    const chat = createFakeLocalChat();
    const msg = await chat.post("hi", { sender: { id: "U1" } });

    const line = formatMessageLine(chat, msg);

    expect(line).toEqual({
      text: "[1] U1: hi",
      isSelf: false,
    });
  });

  it("bot 投稿 (isSelf: true) は isSelf: true で ↳ にスレッド元 seq を出す", async () => {
    const chat = createFakeLocalChat();
    await chat.post("root", {});
    const botMsg: LoggedMessage = {
      seq: 2,
      ts: "2",
      channelId: "local",
      threadTs: "1",
      text: "reply",
      sender: { id: "U_BOT", isBot: true, isSelf: true },
    };

    const line = formatMessageLine(chat, botMsg);

    expect(line).toEqual({ text: "[2]↳1 U_BOT: reply", isSelf: true });
  });

  it("mentionsBot: true なら本文先頭に @bot を復元する", async () => {
    const chat = createFakeLocalChat();
    const msg = await chat.post("text", {
      sender: { id: "U1" },
      mentionsBot: true,
    });

    const line = formatMessageLine(chat, msg);

    expect(line).toEqual({ text: "[1] U1: @bot text", isSelf: false });
  });

  it("files があれば file: 行を追記する", async () => {
    const chat = createFakeLocalChat();
    const msg: LoggedMessage = {
      seq: 1,
      ts: "1",
      channelId: "local",
      text: "with file",
      sender: { id: "U1", isBot: false, isSelf: false },
      files: ["a.txt", "b.txt"],
    };

    const line = formatMessageLine(chat, msg);

    expect(line.text).toContain("file: a.txt");
    expect(line.text).toContain("file: b.txt");
  });
});

describe("formatUpdateLine", () => {
  it("update 行は [N]↺ 付きで isSelf: true", () => {
    const msg: LoggedMessage = {
      seq: 3,
      ts: "3",
      channelId: "local",
      text: "progress...",
      sender: { id: "U_BOT", isBot: true, isSelf: true },
    };

    const line = formatUpdateLine(msg);

    expect(line).toEqual({
      text: "[3]↺ U_BOT: progress...",
      isSelf: true,
    });
  });
});

describe("formatReactionLine", () => {
  it("ログ上に対応する seq があれば [N] 表記にする", async () => {
    const chat = createFakeLocalChat();
    const msg = await chat.post("hi", {});
    const record: ReactionRecord = {
      channelId: "local",
      ts: msg.ts,
      emoji: "eyes",
    };

    const line = formatReactionLine(chat, record);

    expect(line).toEqual({ text: ":eyes: on [1]", isSelf: true });
  });

  it("ログにない ts はそのまま表示する", () => {
    const chat = createFakeLocalChat();
    const record: ReactionRecord = {
      channelId: "local",
      ts: "1700000000.999999",
      emoji: "tada",
    };

    const line = formatReactionLine(chat, record);

    expect(line).toEqual({
      text: ":tada: on 1700000000.999999",
      isSelf: true,
    });
  });
});
