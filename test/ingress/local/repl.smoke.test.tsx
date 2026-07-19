// ink 化した repl.tsx (App コンポーネント) の最小スモークテスト。
//
// ink-testing-library の render()/lastFrame() は内部で常に自前の
// fake stdout/stdin/stderr を ink に注入する (render(tree) はツリーしか
// 受け取らない) ため、startRepl 自体 (本物の ink.render を直接呼ぶ) を
// このライブラリ経由でラップすることはできない。App コンポーネントを直接
// render し、行入力の駆動は App の options.input/output prop (PassThrough)
// 経由で行う — ink 側の fake stdin/stdout はキー入力エコー用の raw mode
// 判定にのみ関わり、行確定処理 (readline) には無関係 (repl.tsx の設計)。
//
// 直列化・EOF 待ち・チャンネル越境reply の3ケースは repl-logic.test.ts の
// handleLine 単体テストとして再現済みなので、ここでは「起動して HELP_TEXT
// が見える」「1行投稿してチャットペインに反映される」「!quit で終了する」
// という画面描画の最小疎通のみを確認する。

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { Reactions } from "../../../src/egress/reactions.js";
import type { Sender } from "../../../src/ingress/chat-event.js";
import type { Ingress } from "../../../src/ingress/ingress.js";
import { HELP_TEXT } from "../../../src/ingress/local/repl-logic.js";
import { App } from "../../../src/ingress/local/repl.js";
import type {
  LocalChat,
  LocalChatOutputEvents,
  LoggedMessage,
  PostOptions,
  ReactionRecord,
  ReactOptions,
} from "../../../src/ingress/local/types.js";

function createFakeLocalChat(): LocalChat {
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

/** input への書き込みが readline の 'line' イベントとして処理され、React
 * の state 更新・再描画まで反映されるのを待つ小さな猶予。 */
async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("App (ink smoke test)", () => {
  it("起動時に HELP_TEXT がチャットペインに表示される", async () => {
    const chat = createFakeLocalChat();
    const input = new PassThrough();
    const output = new PassThrough();

    const { lastFrame, unmount } = render(
      <App
        chat={chat}
        options={{ initialChannelId: "local", input, output }}
        onDone={() => {}}
      />,
    );
    await flushAsync();

    // HELP_TEXT は複数行あり、末尾追従 (offset 0) のペインは末尾の viewport
    // 行分だけを表示する (フォールバックの端末サイズでは HELP_TEXT 全体より
    // viewport が小さい)。そのため末尾行の先頭語で判定する。
    const lastLine = HELP_TEXT.split("\n").at(-1);
    expect(lastLine).toBeDefined();
    const lastWord = (lastLine as string).split(/\s/)[0];
    expect(lastWord).toBeDefined();
    expect(lastFrame()).toContain(lastWord as string);

    unmount();
  });

  it("1行投稿するとチャットペインに反映される", async () => {
    const chat = createFakeLocalChat();
    const input = new PassThrough();
    const output = new PassThrough();

    const { lastFrame, unmount } = render(
      <App
        chat={chat}
        options={{ initialChannelId: "local", input, output }}
        onDone={() => {}}
      />,
    );

    input.write("hello from smoke test\n");
    await flushAsync();

    expect(lastFrame()).toContain("hello from smoke test");

    unmount();
  });

  it("!quit で onDone が呼ばれる", async () => {
    const chat = createFakeLocalChat();
    const input = new PassThrough();
    const output = new PassThrough();
    let done = false;

    const { unmount } = render(
      <App
        chat={chat}
        options={{ initialChannelId: "local", input, output }}
        onDone={() => {
          done = true;
        }}
      />,
    );

    input.write("!quit\n");
    await flushAsync();

    expect(done).toBe(true);

    unmount();
  });

  it("プロンプトに現在のチャンネル/ユーザーが表示される", () => {
    const chat = createFakeLocalChat();
    const input = new PassThrough();
    const output = new PassThrough();

    const { lastFrame, unmount } = render(
      <App
        chat={chat}
        options={{ initialChannelId: "my-channel", input, output }}
        onDone={() => {}}
      />,
    );

    expect(lastFrame()).toContain("#my-channel");
    expect(lastFrame()).toContain("U_LOCAL");

    unmount();
  });

  it("logStream を渡すとログペインに NDJSON が整形表示される (上下分割)", async () => {
    const chat = createFakeLocalChat();
    const input = new PassThrough();
    const output = new PassThrough();
    const logStream = new PassThrough();

    const { lastFrame, unmount } = render(
      <App
        chat={chat}
        options={{ initialChannelId: "local", input, output, logStream }}
        onDone={() => {}}
      />,
    );

    logStream.write(
      `${JSON.stringify({
        level: 30,
        component: "session",
        msg: "gate triggered",
      })}\n`,
    );
    await flushAsync();

    // formatLogLine が `LEVEL [component] msg` に整形する
    expect(lastFrame()).toContain("[session]");
    expect(lastFrame()).toContain("gate triggered");
    // チャットペイン (HELP_TEXT) と同居している = 上下分割で両方見えている。
    // 末尾追従 (offset 0) のペインは末尾の viewport 行分だけを表示するため、
    // HELP_TEXT の末尾行の先頭語で判定する (フォールバックの端末サイズでは
    // HELP_TEXT 全体より viewport が小さい)。
    const lastLine = HELP_TEXT.split("\n").at(-1);
    expect(lastLine).toBeDefined();
    const lastWord = (lastLine as string).split(/\s/)[0];
    expect(lastWord).toBeDefined();
    expect(lastFrame()).toContain(lastWord as string);

    unmount();
  });
});
