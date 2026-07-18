// REPL アダプタ (docs/design/local-dev.md §2, §3)
//
// stdin 1 行 → 文法パース (純関数) → LocalChat の API 呼び出し。
// core (LocalChat) はステートレスなので、現在チャンネル・現在ユーザー・DM
// フラグなど「今の状態」はこのアダプタが持つ。
//
// types.ts の LocalChat インターフェイスにのみ依存する (local-chat.ts は import しない)。

import * as readline from "node:readline";
import * as readlinePromises from "node:readline/promises";
import { styleText } from "node:util";

import type { LoggedMessage, LocalChat } from "./types.js";

// ── 1. 行パーサ ──────────────────────────────────────────────────────────

/** スレッド参照。数字のみ = ログ上の seq 番号、`数字.数字` = 生の ts (local-dev.md §3)。 */
export type ThreadRef =
  | { kind: "seq"; seq: number }
  | { kind: "ts"; ts: string };

export interface ParsedIgnore {
  kind: "ignore";
}

export interface ParsedError {
  kind: "error";
  message: string;
}

export interface ParsedPost {
  kind: "post";
  text: string;
  mentionsBot: boolean;
  thread?: ThreadRef;
}

export interface ParsedReact {
  kind: "react";
  target: ThreadRef;
  /** コロンを剥がした素の emoji 名 (`eyes`)。 */
  emoji: string;
}

export interface ParsedChannel {
  kind: "channel";
  channelId: string;
}

export interface ParsedDm {
  kind: "dm";
  on: boolean;
}

export interface ParsedUser {
  kind: "user";
  userId: string;
  isBot: boolean;
}

export interface ParsedQuit {
  kind: "quit";
}

export interface ParsedHelp {
  kind: "help";
}

export type ParsedLine =
  | ParsedIgnore
  | ParsedError
  | ParsedPost
  | ParsedReact
  | ParsedChannel
  | ParsedDm
  | ParsedUser
  | ParsedQuit
  | ParsedHelp;

/** `数字のみ` = seq、`数字.数字` = 生 ts として ThreadRef を作る。どちらでもなければ null。 */
function parseThreadRef(token: string): ThreadRef | null {
  if (/^\d+$/.test(token)) {
    return { kind: "seq", seq: Number(token) };
  }
  if (/^\d+\.\d+$/.test(token)) {
    return { kind: "ts", ts: token };
  }
  return null;
}

/** `:eyes:` / `eyes` の両方からコロンを剥がして emoji 名を返す。 */
function stripEmojiColons(token: string): string {
  return token.replace(/^:/, "").replace(/:$/, "");
}

/** stdin の 1 行をパースする (純関数)。 */
export function parseLine(line: string): ParsedLine {
  const trimmed = line.trim();
  if (trimmed === "") return { kind: "ignore" };

  if (trimmed.startsWith("!")) {
    return parseMeta(trimmed);
  }

  if (trimmed.startsWith(">")) {
    return parseThreadReply(trimmed);
  }

  if (trimmed === "@bot" || trimmed.startsWith("@bot ")) {
    return {
      kind: "post",
      text: trimmed.slice("@bot".length).trim(),
      mentionsBot: true,
    };
  }

  // 先頭が `/` でもチャットコマンドとして通常投稿する (runner 側が解釈する)
  return { kind: "post", text: trimmed, mentionsBot: false };
}

function parseThreadReply(trimmed: string): ParsedLine {
  // `>N text` / `>N @bot text` — `>` の直後 (空白なし) にトークン、続けて残り
  const m = /^>(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!m) {
    return { kind: "error", message: `不正なスレッド参照: ${trimmed}` };
  }
  const [, refToken, rest = ""] = m;
  const thread = parseThreadRef(refToken as string);
  if (thread === null) {
    return {
      kind: "error",
      message: `不正なスレッド参照 (数字または数字.数字 が必要): ${refToken}`,
    };
  }

  const restTrimmed = rest.trim();
  if (restTrimmed === "@bot" || restTrimmed.startsWith("@bot ")) {
    return {
      kind: "post",
      text: restTrimmed.slice("@bot".length).trim(),
      mentionsBot: true,
      thread,
    };
  }

  return { kind: "post", text: restTrimmed, mentionsBot: false, thread };
}

function parseMeta(trimmed: string): ParsedLine {
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0];

  switch (cmd) {
    case "!react": {
      const [, targetToken, emojiToken] = parts;
      if (targetToken === undefined || emojiToken === undefined) {
        return {
          kind: "error",
          message: "使い方: !react <N|ts> <emoji>",
        };
      }
      const target = parseThreadRef(targetToken);
      if (target === null) {
        return {
          kind: "error",
          message: `不正な参照 (数字または数字.数字 が必要): ${targetToken}`,
        };
      }
      return { kind: "react", target, emoji: stripEmojiColons(emojiToken) };
    }
    case "!channel": {
      const channelId = parts[1];
      if (channelId === undefined) {
        return { kind: "error", message: "使い方: !channel <id>" };
      }
      return { kind: "channel", channelId };
    }
    case "!dm": {
      const arg = parts[1];
      if (arg === "on") return { kind: "dm", on: true };
      if (arg === "off") return { kind: "dm", on: false };
      return { kind: "error", message: "使い方: !dm on|off" };
    }
    case "!user": {
      const userId = parts[1];
      if (userId === undefined) {
        return { kind: "error", message: "使い方: !user <id> [--bot]" };
      }
      const isBot = parts[2] === "--bot";
      if (parts[2] !== undefined && !isBot) {
        return { kind: "error", message: "使い方: !user <id> [--bot]" };
      }
      return { kind: "user", userId, isBot };
    }
    case "!quit":
      return { kind: "quit" };
    case "!help":
      return { kind: "help" };
    default:
      return { kind: "error", message: `不明なコマンド: ${cmd}` };
  }
}

// ── 2. REPL ループ ───────────────────────────────────────────────────────

export interface StartReplOptions {
  initialChannelId: string;
  /** stdin の差し替え (テスト用・docs/design/local-dev.md §5 の将来のシナリオ再生の
   * seam)。既定 process.stdin。 */
  input?: NodeJS.ReadableStream;
  /** stdout の差し替え。既定 process.stdout。 */
  output?: NodeJS.WritableStream;
}

const HELP_TEXT = `\
文法:
  text                    チャンネル直下投稿
  @bot text               mention 付き投稿
  >N text                 メッセージ N のスレッドへ返信 (N = seq番号 または 生ts)
  >N @bot text            スレッド返信 + mention
  !react <N|ts> <emoji>   メッセージにリアクションを注入 (emoji は eyes / :eyes: 両対応)
  !channel <id>           投稿先チャンネルを切替
  !dm on|off              conversation.isDm を切替
  !user <id> [--bot]      発言者を切替 (--bot で isBot: true)
  !quit                   終了 (Ctrl-D も同じ)
  !help                   この一覧を表示
`;

interface ReplState {
  channelId: string;
  userId: string;
  isBot: boolean;
  isDm: boolean;
}

function promptText(state: ReplState): string {
  const parts = [`#${state.channelId}`];
  if (state.isDm) parts.push("dm");
  parts.push(state.isBot ? `${state.userId}(bot)` : state.userId);
  return `${parts.join(" ")}> `;
}

/** ログ中の seq → ts の逆引き。見つからなければ undefined。 */
function seqForTs(chat: LocalChat, ts: string): number | undefined {
  return chat.log().find((m) => m.ts === ts)?.seq;
}

/** seq/ts 参照を解決する。seq 参照は対象 LoggedMessage の channelId も返す —
 * 呼び出し側 (react/post) はそれを state.channelId より優先することで、他チャンネル
 * から `>N`/`!react N` した際に N が属するチャンネルへ投稿する (local-dev.md §3)。
 * 生 ts 参照はログ非依存 (存在チェックしない) のため channelId を持たず、
 * 呼び出し側は従来どおり state.channelId を使う。 */
function resolveThreadRef(
  chat: LocalChat,
  ref: ThreadRef,
): { ts: string; channelId?: string } | { error: string } {
  if (ref.kind === "ts") return { ts: ref.ts };
  const msg = chat.bySeq(ref.seq);
  if (msg === undefined) {
    return { error: `不明な参照です: [${ref.seq}]` };
  }
  return { ts: msg.ts, channelId: msg.channelId };
}

function displayName(sender: { id: string; displayName?: string }): string {
  return sender.displayName ?? sender.id;
}

function formatMessageLine(chat: LocalChat, msg: LoggedMessage): string {
  const header = `[${msg.seq} ${msg.ts}]`;
  const who = displayName(msg.sender);
  const threadSuffix =
    msg.threadTs !== undefined
      ? (() => {
          const seq = seqForTs(chat, msg.threadTs as string);
          return ` (thread of [${seq !== undefined ? seq : msg.threadTs}])`;
        })()
      : "";
  const body = `${header}${threadSuffix} ${who}: ${msg.text}`;
  const filesSuffix =
    msg.files !== undefined && msg.files.length > 0
      ? `\n${msg.files.map((f) => `   file: ${f}`).join("\n")}`
      : "";

  if (msg.sender.isSelf) {
    return `${styleText("cyan", "⟵")} ${styleText("cyan", body)}${filesSuffix}`;
  }
  return `${body}${filesSuffix}`;
}

function formatUpdateLine(msg: LoggedMessage): string {
  return styleText(
    "cyan",
    `⟵ (update [${msg.seq}]) ${displayName(msg.sender)}: ${msg.text}`,
  );
}

function formatReactionLine(
  chat: LocalChat,
  record: { channelId: string; ts: string; emoji: string },
): string {
  const seq = seqForTs(chat, record.ts);
  const target = seq !== undefined ? `[${seq}]` : record.ts;
  return styleText("cyan", `⟵ :${record.emoji}: on ${target}`);
}

/** output が TTY かどうかを緩く判定する (PassThrough 等テスト用ストリームは
 * isTTY を持たないため false 扱い)。 */
function isTty(output: NodeJS.WritableStream): boolean {
  return (output as Partial<NodeJS.WriteStream>).isTTY === true;
}

/** node:readline のプロンプト行を崩さずに非同期出力を差し込む。output が TTY
 * でなければ clearLine/cursorTo (カーソル制御) はスキップする — テスト用の
 * PassThrough 等には効かず、かえって余計な制御文字を書き込んでしまうため。
 * prompt は readline が close 済みなら何もしない safePrompt を受け取る。 */
function printAbovePrompt(
  prompt: () => void,
  output: NodeJS.WritableStream,
  text: string,
): void {
  if (isTty(output)) {
    readline.clearLine(output, 0);
    readline.cursorTo(output, 0);
  }
  output.write(`${text}\n`);
  prompt();
}

export async function startRepl(
  chat: LocalChat,
  options: StartReplOptions,
): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;

  const state: ReplState = {
    channelId: options.initialChannelId,
    userId: "U_LOCAL",
    isBot: false,
    isDm: false,
  };

  const rl = readlinePromises.createInterface({
    input,
    output,
  });

  // in-flight の handleLine (chat.post 等) が完了する前に readline が
  // close することがある (EOF / !quit と競合するケース、fix 1)。close 後の
  // rl.prompt() は ERR_USE_AFTER_CLOSE で例外になるため、close 済みなら
  // 何もしないガードを介して呼ぶ。
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });
  const safePrompt = (): void => {
    if (!closed) rl.prompt();
  };

  chat.events.on("message", (msg) => {
    // 人間の入力も描画する — 払い出された [N ts] を見せないと `>N` での
    // スレッド返信や `!react N` の参照ができない (local-dev.md §3 の表示例)
    printAbovePrompt(safePrompt, output, formatMessageLine(chat, msg));
  });
  chat.events.on("update", (msg) => {
    printAbovePrompt(safePrompt, output, formatUpdateLine(msg));
  });
  chat.events.on("reaction", (record) => {
    printAbovePrompt(safePrompt, output, formatReactionLine(chat, record));
  });

  output.write(HELP_TEXT);
  rl.setPrompt(promptText(state));
  rl.prompt();

  // 複数行が一気に届いても到着順に 1 件ずつ処理する直列キュー (fix 1)。
  // 1 行の失敗が後続行の直列化や close 待ちを壊さないよう、各リンクで
  // catch して queue 自体は常に resolve する。
  let queue: Promise<void> = Promise.resolve();

  rl.on("line", (line) => {
    queue = queue
      .then(() => handleLine(chat, state, rl, output, safePrompt, line))
      .catch((err: unknown) => {
        output.write(`${styleText("red", String(err))}\n`);
        safePrompt();
      });
  });

  await new Promise<void>((resolve) => {
    rl.on("close", () => {
      // readline close 後もキューに実行中/未実行の handleLine が残っている
      // ことがある (!quit や EOF が in-flight の chat.post と競合するケース)。
      // それを握りつぶさず待ってから resolve する (fix 1)。pi のターン完了
      // (turn 全体) までは待たない — handleLine (chat.post の呼び出し) の
      // 完了で十分。
      void queue.then(() => resolve());
    });
  });
}

async function handleLine(
  chat: LocalChat,
  state: ReplState,
  rl: readlinePromises.Interface,
  output: NodeJS.WritableStream,
  safePrompt: () => void,
  line: string,
): Promise<void> {
  const parsed = parseLine(line);

  switch (parsed.kind) {
    case "ignore":
      safePrompt();
      return;

    case "error":
      output.write(`${styleText("red", parsed.message)}\n`);
      safePrompt();
      return;

    case "help":
      output.write(HELP_TEXT);
      safePrompt();
      return;

    case "quit":
      rl.close();
      return;

    case "channel":
      state.channelId = parsed.channelId;
      rl.setPrompt(promptText(state));
      safePrompt();
      return;

    case "dm":
      state.isDm = parsed.on;
      rl.setPrompt(promptText(state));
      safePrompt();
      return;

    case "user":
      state.userId = parsed.userId;
      state.isBot = parsed.isBot;
      rl.setPrompt(promptText(state));
      safePrompt();
      return;

    case "react": {
      const resolved = resolveThreadRef(chat, parsed.target);
      if ("error" in resolved) {
        output.write(`${styleText("red", resolved.error)}\n`);
        safePrompt();
        return;
      }
      await chat.react(resolved.ts, parsed.emoji, {
        // seq 参照なら対象メッセージのチャンネルへ、生 ts 参照なら現在の
        // チャンネルへ (fix 2, local-dev.md §3)。
        channelId: resolved.channelId ?? state.channelId,
        sender: { id: state.userId, isBot: state.isBot },
      });
      safePrompt();
      return;
    }

    case "post": {
      let threadTs: string | undefined;
      let channelId = state.channelId;
      if (parsed.thread !== undefined) {
        const resolved = resolveThreadRef(chat, parsed.thread);
        if ("error" in resolved) {
          output.write(`${styleText("red", resolved.error)}\n`);
          safePrompt();
          return;
        }
        threadTs = resolved.ts;
        channelId = resolved.channelId ?? state.channelId;
      }

      await chat.post(parsed.text, {
        channelId,
        ...(threadTs !== undefined ? { threadTs } : {}),
        mentionsBot: parsed.mentionsBot,
        sender: { id: state.userId, isBot: state.isBot },
        isDm: state.isDm,
      });
      safePrompt();
      return;
    }
  }
}
