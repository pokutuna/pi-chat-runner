// 入力欄のフォーカス強調 (repl.tsx InputLine) のスタイル検証。
//
// フレーム中の ANSI スタイル (カーソルの反転 = SGR 7) を検証するため、
// force-color.ts を最初に import して chalk の色出力を強制する (他の
// テストファイルは色なしフレームで動くので分離している)。他ファイルへの
// 漏れを抑えるため、import 完了後 (chalk は評価済み) に FORCE_COLOR を戻す。
import "./force-color.js";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { Reactions } from "../../../src/egress/reactions.js";
import type { Ingress } from "../../../src/ingress/ingress.js";
import { App } from "../../../src/ingress/local/repl.js";
import type {
  LocalChat,
  LocalChatOutputEvents,
  LoggedMessage,
  ReactionRecord,
} from "../../../src/ingress/local/types.js";

// chalk は import 済みなのでここで戻してよい (同一ワーカーで後続する他の
// テストファイルへ FORCE_COLOR を漏らさない)。
delete process.env.FORCE_COLOR;

/** SGR 7 (反転)。カーソルセルの描画にだけ使われる。 */
const INVERSE = "\x1b[7m";
/** SGR 35 (magenta)。有効なメタコマンドの !COMMAND 部分の描画に使われる。 */
const MAGENTA = "\x1b[35m";

function createFakeLocalChat(): LocalChat {
  const log: LoggedMessage[] = [];
  const reactionsLog: ReactionRecord[] = [];
  const events = new EventEmitter<LocalChatOutputEvents>();
  const ingress: Ingress = {
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
  return {
    ingress,
    poster: {
      postMessage: () => Promise.resolve({ messageId: "1" }),
      updateMessage: () => Promise.resolve(),
    },
    reactions: new Reactions({ add: () => Promise.resolve() }),
    userResolver: { resolve: () => Promise.resolve(null) },
    fetchMessage: () => Promise.resolve(null),
    post: (text) => {
      const message: LoggedMessage = {
        seq: log.length + 1,
        ts: String(log.length + 1),
        channelId: "local",
        text,
        sender: { id: "U_LOCAL", isBot: false, isSelf: false },
      };
      log.push(message);
      events.emit("message", message);
      return Promise.resolve(message);
    },
    react: () => Promise.resolve(),
    log: () => log,
    bySeq: (seq) => log.find((m) => m.seq === seq),
    reactionsLog: () => reactionsLog,
    events,
  };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("入力欄のフォーカス強調", () => {
  it("カーソルの反転セルはフォーカス中のみ表示される", async () => {
    const chat = createFakeLocalChat();
    const input = new PassThrough();
    (input as unknown as { isTTY: boolean }).isTTY = true; // useInput 経路を有効化
    const output = new PassThrough();
    const logStream = new PassThrough();

    const { lastFrame, stdin, unmount } = render(
      <App
        chat={chat}
        options={{ initialChannelId: "local", input, output, logStream }}
        onDone={() => {}}
      />,
    );
    await flushAsync();

    // 初期状態 (input フォーカス) はカーソルの反転セルが出る
    expect(lastFrame()).toContain(INVERSE);

    // Tab で log ペインへフォーカスを移すと反転セルが消える
    stdin.write("\t");
    await flushAsync();
    expect(lastFrame()).not.toContain(INVERSE);

    // Escape で input に戻ると再び出る
    stdin.write("\x1b");
    await flushAsync();
    expect(lastFrame()).toContain(INVERSE);

    unmount();
  });

  it("有効なメタコマンドの !COMMAND 部分だけ magenta で色付く", async () => {
    const chat = createFakeLocalChat();
    const input = new PassThrough();
    (input as unknown as { isTTY: boolean }).isTTY = true; // useInput 経路を有効化
    const output = new PassThrough();
    const logStream = new PassThrough();

    const { lastFrame, stdin, unmount } = render(
      <App
        chat={chat}
        options={{ initialChannelId: "local", input, output, logStream }}
        onDone={() => {}}
      />,
    );
    await flushAsync();

    // "!hel" は前方一致のみで無効なメタコマンド扱い -> 色なし
    for (const ch of "!hel") {
      stdin.write(ch);
      await flushAsync();
    }
    expect(lastFrame()).not.toContain(MAGENTA);

    // 続けて "p" を打つと "!help" が確定し色が付く
    stdin.write("p");
    await flushAsync();
    expect(lastFrame()).toContain(MAGENTA);

    unmount();
  });
});
