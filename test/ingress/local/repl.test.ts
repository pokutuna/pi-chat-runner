import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { Reactions } from "../../../src/egress/reactions.js";
import type { Sender } from "../../../src/ingress/chat-event.js";
import type { Ingress } from "../../../src/ingress/ingress.js";
import { parseLine, startRepl } from "../../../src/ingress/local/repl.js";
import type {
  LocalChat,
  LocalChatOutputEvents,
  LoggedMessage,
  PostOptions,
  ReactionRecord,
  ReactOptions,
} from "../../../src/ingress/local/types.js";

describe("parseLine", () => {
  it("空行を無視する", () => {
    expect(parseLine("")).toEqual({ kind: "ignore" });
  });

  it("空白のみの行を無視する", () => {
    expect(parseLine("   ")).toEqual({ kind: "ignore" });
  });

  it("通常のテキストを mentionsBot: false の投稿として扱う", () => {
    expect(parseLine("hello there")).toEqual({
      kind: "post",
      text: "hello there",
      mentionsBot: false,
    });
  });

  it("先頭が / でもチャットコマンドとしてそのまま本文で通す", () => {
    expect(parseLine("/new session")).toEqual({
      kind: "post",
      text: "/new session",
      mentionsBot: false,
    });
  });

  it("@bot text を mentionsBot: true の投稿として扱い prefix を除去する", () => {
    expect(parseLine("@bot このアラート調査して")).toEqual({
      kind: "post",
      text: "このアラート調査して",
      mentionsBot: true,
    });
  });

  it("@bot のみ (本文なし) を空文字の mention 投稿として扱う", () => {
    expect(parseLine("@bot")).toEqual({
      kind: "post",
      text: "",
      mentionsBot: true,
    });
  });

  it(">N text を seq 参照のスレッド返信として扱う", () => {
    expect(parseLine(">3 続報です")).toEqual({
      kind: "post",
      text: "続報です",
      mentionsBot: false,
      thread: { kind: "seq", seq: 3 },
    });
  });

  it(">数字.数字 text を生 ts 参照のスレッド返信として扱う", () => {
    expect(parseLine(">1700000000.000099 続報です")).toEqual({
      kind: "post",
      text: "続報です",
      mentionsBot: false,
      thread: { kind: "ts", ts: "1700000000.000099" },
    });
  });

  it(">N @bot text をスレッド返信 + mention として扱う", () => {
    expect(parseLine(">3 @bot 助けて")).toEqual({
      kind: "post",
      text: "助けて",
      mentionsBot: true,
      thread: { kind: "seq", seq: 3 },
    });
  });

  it(">生ts @bot text もスレッド返信 + mention として扱う", () => {
    expect(parseLine(">1700000000.000099 @bot 助けて")).toEqual({
      kind: "post",
      text: "助けて",
      mentionsBot: true,
      thread: { kind: "ts", ts: "1700000000.000099" },
    });
  });

  it(">3 (本文なし) を空文字のスレッド返信として扱う", () => {
    expect(parseLine(">3")).toEqual({
      kind: "post",
      text: "",
      mentionsBot: false,
      thread: { kind: "seq", seq: 3 },
    });
  });

  it(">3 @bot (本文なしの mention) を空文字のスレッド mention として扱う", () => {
    expect(parseLine(">3 @bot")).toEqual({
      kind: "post",
      text: "",
      mentionsBot: true,
      thread: { kind: "seq", seq: 3 },
    });
  });

  it(">abc のような不正なスレッド参照をパースエラーにする", () => {
    const result = parseLine(">abc text");
    expect(result.kind).toBe("error");
  });

  it("!react N emoji を seq 参照の react として扱いコロンなし emoji はそのまま", () => {
    expect(parseLine("!react 3 eyes")).toEqual({
      kind: "react",
      target: { kind: "seq", seq: 3 },
      emoji: "eyes",
    });
  });

  it("!react N :emoji: のコロンを剥がす", () => {
    expect(parseLine("!react 3 :eyes:")).toEqual({
      kind: "react",
      target: { kind: "seq", seq: 3 },
      emoji: "eyes",
    });
  });

  it("!react は生 ts も参照できる", () => {
    expect(parseLine("!react 1700000000.000099 :eyes:")).toEqual({
      kind: "react",
      target: { kind: "ts", ts: "1700000000.000099" },
      emoji: "eyes",
    });
  });

  it("!react の引数不足をパースエラーにする", () => {
    expect(parseLine("!react 3").kind).toBe("error");
    expect(parseLine("!react").kind).toBe("error");
  });

  it("!channel <id> をチャンネル切替として扱う", () => {
    expect(parseLine("!channel C123")).toEqual({
      kind: "channel",
      channelId: "C123",
    });
  });

  it("!channel の引数なしをパースエラーにする", () => {
    expect(parseLine("!channel").kind).toBe("error");
  });

  it("!dm on / !dm off を dm 切替として扱う", () => {
    expect(parseLine("!dm on")).toEqual({ kind: "dm", on: true });
    expect(parseLine("!dm off")).toEqual({ kind: "dm", on: false });
  });

  it("!dm の不正な引数をパースエラーにする", () => {
    expect(parseLine("!dm maybe").kind).toBe("error");
  });

  it("!user <id> をユーザー切替として扱う (isBot: false)", () => {
    expect(parseLine("!user U999")).toEqual({
      kind: "user",
      userId: "U999",
      isBot: false,
    });
  });

  it("!user <id> --bot を isBot: true として扱う", () => {
    expect(parseLine("!user U999 --bot")).toEqual({
      kind: "user",
      userId: "U999",
      isBot: true,
    });
  });

  it("!user の引数なしをパースエラーにする", () => {
    expect(parseLine("!user").kind).toBe("error");
  });

  it("!quit を終了として扱う", () => {
    expect(parseLine("!quit")).toEqual({ kind: "quit" });
  });

  it("!help をヘルプ表示として扱う", () => {
    expect(parseLine("!help")).toEqual({ kind: "help" });
  });

  it("未知の ! コマンドをパースエラーにする", () => {
    const result = parseLine("!unknown foo");
    expect(result.kind).toBe("error");
  });
});

// ── startRepl 用のフェイク LocalChat ────────────────────────────────────
//
// types.ts の LocalChat 契約を満たす最小実装。ingress/poster/userResolver/
// fetchMessage は repl.ts から使われないため no-op のダミーでよい。post は
// options.postDelayMs で遅延させられる (fix 1 の in-flight 待ちテスト用)。

function createFakeLocalChat(options?: { postDelayMs?: number }): LocalChat {
  const log: LoggedMessage[] = [];
  const reactionsLog: ReactionRecord[] = [];
  const events = new EventEmitter<LocalChatOutputEvents>();
  let seqCounter = 0;
  let tsCounter = 0;

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
    if (options?.postDelayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, options.postDelayMs));
    }
    seqCounter += 1;
    tsCounter += 1;
    const sender: Sender = {
      id: postOptions?.sender?.id ?? "U_LOCAL",
      isBot: postOptions?.sender?.isBot ?? false,
      isSelf: false,
    };
    const message: LoggedMessage = {
      seq: seqCounter,
      ts: `1700000000.${String(tsCounter).padStart(6, "0")}`,
      channelId: postOptions?.channelId ?? "local",
      ...(postOptions?.threadTs !== undefined
        ? { threadTs: postOptions.threadTs }
        : {}),
      text,
      sender,
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
  };
}

describe("startRepl", () => {
  it("複数行を一気に書き込んでも post が到着順に直列処理される", async () => {
    const chat = createFakeLocalChat();
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume(); // 出力は捨てる (assert しない)

    const replDone = startRepl(chat, {
      initialChannelId: "local",
      input,
      output,
    });

    input.write("first\nsecond\nthird\n");
    input.end();

    await replDone;

    expect(chat.log().map((m) => m.text)).toEqual(["first", "second", "third"]);
  });

  it("EOF 時に in-flight の post が完了してから resolve する", async () => {
    // わざと遅い chat.post で「処理中に readline が閉じる」状況を作る。
    const chat = createFakeLocalChat({ postDelayMs: 50 });
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();

    const replDone = startRepl(chat, {
      initialChannelId: "local",
      input,
      output,
    });

    input.write("slow message\n");
    // handleLine が chat.post 内で await している間に EOF を発生させる。
    input.end();

    // startRepl がまだ resolve していないうちは post 未完了のはず。
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(chat.log()).toHaveLength(0);

    await replDone;

    expect(chat.log().map((m) => m.text)).toEqual(["slow message"]);
  });

  it("B チャンネルに切替後の `>1 reply` が [1] の属するチャンネルへ投稿される", async () => {
    const chat = createFakeLocalChat();
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();

    const replDone = startRepl(chat, {
      initialChannelId: "A",
      input,
      output,
    });

    input.write("hello from A\n");
    input.write("!channel B\n");
    input.write(">1 reply to A\n");
    input.end();

    await replDone;

    const messages = chat.log();
    expect(messages).toHaveLength(2);
    expect(messages[0]!.channelId).toBe("A");
    expect(messages[1]!.text).toBe("reply to A");
    expect(messages[1]!.channelId).toBe("A");
  });
});
