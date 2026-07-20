// REPL のロジック層 (docs/design/local-dev.md §2, §3)
//
// stdin 1 行 → 文法パース (純関数) → LocalChat の API 呼び出し、および
// LocalChat からの変化通知 → 表示用データへの整形、を ink (画面描画) に
// 依存しない形でまとめる。ink コンポーネント (repl.tsx) はここを呼ぶだけの
// 薄い層にする。
//
// types.ts の LocalChat インターフェイスにのみ依存する (local-chat.ts は import しない)。

import type { LoggedMessage, LocalChat, ReactionRecord } from "./types.js";

// ── 1. 行パーサ ──────────────────────────────────────────────────────────

/** スレッド参照。数字のみ = ログ上の seq 番号、`ts:X` = 未観測 ts の生指定
 * (local-dev.md §3)。 */
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

/** `!channels` — 設定ファイルの channels ブロックのエントリ一覧を表示する。 */
export interface ParsedChannels {
  kind: "channels";
}

/** `!thread N` / `!t N` — 指定スレッドに入る (以降の通常投稿がそのスレッドへ)。 */
export interface ParsedThread {
  kind: "thread";
  target: ThreadRef;
}

/** `!leave` — スレッドから出てチャンネル直下に戻る。 */
export interface ParsedLeave {
  kind: "leave";
}

export type ParsedLine =
  | ParsedIgnore
  | ParsedError
  | ParsedPost
  | ParsedReact
  | ParsedChannel
  | ParsedChannels
  | ParsedDm
  | ParsedUser
  | ParsedThread
  | ParsedLeave
  | ParsedQuit
  | ParsedHelp;

/** `数字のみ` = seq、`ts:X` = 未観測 ts の生指定として ThreadRef を作る。
 * どちらでもなければ null。 */
function parseThreadRef(token: string): ThreadRef | null {
  if (/^\d+$/.test(token)) {
    return { kind: "seq", seq: Number(token) };
  }
  if (token.startsWith("ts:") && token.slice(3) !== "") {
    return { kind: "ts", ts: token.slice(3) };
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
    return { kind: "error", message: `invalid thread reference: ${trimmed}` };
  }
  const [, refToken, rest = ""] = m;
  const thread = parseThreadRef(refToken as string);
  if (thread === null) {
    return {
      kind: "error",
      message: `invalid thread reference (expected a number or ts:<raw-ts>): ${refToken}`,
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

/** メタコマンドとして認識するコマンド名の一覧 (parseMeta の case と揃える)。 */
const META_COMMANDS = new Set([
  "!react",
  "!channel",
  "!channels",
  "!dm",
  "!user",
  "!thread",
  "!t",
  "!leave",
  "!quit",
  "!exit",
  "!help",
]);

/** 入力行の先頭が有効なメタコマンドなら、色付けすべき先頭文字数 (=!COMMAND
 * の長さ) を返す。無効なら 0。先頭トークン (最初の空白まで、または行末まで)
 * が既知メタコマンドに完全一致するときだけその長さを返す (前方一致は 0)。
 * 先頭に空白がある入力欄の生値もそのまま渡される前提なので、その場合も 0。 */
export function metaCommandHighlightLength(input: string): number {
  if (!input.startsWith("!")) return 0;
  const spaceIndex = input.indexOf(" ");
  const cmd = spaceIndex === -1 ? input : input.slice(0, spaceIndex);
  return META_COMMANDS.has(cmd) ? cmd.length : 0;
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
          message: "usage: !react <N|ts:X> <emoji>",
        };
      }
      const target = parseThreadRef(targetToken);
      if (target === null) {
        return {
          kind: "error",
          message: `invalid reference (expected a number or ts:<raw-ts>): ${targetToken}`,
        };
      }
      return { kind: "react", target, emoji: stripEmojiColons(emojiToken) };
    }
    case "!channel": {
      const channelId = parts[1];
      if (channelId === undefined) {
        return { kind: "error", message: "usage: !channel <id>" };
      }
      return { kind: "channel", channelId };
    }
    case "!channels":
      return { kind: "channels" };
    case "!dm": {
      const arg = parts[1];
      if (arg === "on") return { kind: "dm", on: true };
      if (arg === "off") return { kind: "dm", on: false };
      return { kind: "error", message: "usage: !dm on|off" };
    }
    case "!user": {
      const userId = parts[1];
      if (userId === undefined) {
        return { kind: "error", message: "usage: !user <id> [--bot]" };
      }
      const isBot = parts[2] === "--bot";
      if (parts[2] !== undefined && !isBot) {
        return { kind: "error", message: "usage: !user <id> [--bot]" };
      }
      return { kind: "user", userId, isBot };
    }
    case "!thread":
    case "!t": {
      const token = parts[1];
      if (token === undefined) {
        return { kind: "error", message: "usage: !thread <N|ts:X>" };
      }
      const target = parseThreadRef(token);
      if (target === null) {
        return {
          kind: "error",
          message: `invalid reference (expected a number or ts:<raw-ts>): ${token}`,
        };
      }
      return { kind: "thread", target };
    }
    case "!leave":
      return { kind: "leave" };
    case "!quit":
    case "!exit":
      return { kind: "quit" };
    case "!help":
      return { kind: "help" };
    default:
      return { kind: "error", message: `unknown command: ${cmd}` };
  }
}

/** 起動時にチャットペインへ出す短い案内。詳細な文法は !help (HELP_TEXT) へ誘導する。 */
export const WELCOME_TEXT = `\
Display: [N] = message number, ↳N = thread (e.g. [4]↳2 = [4] is a reply in thread of [2])
Post: text | @bot text (Tab completes @bot) | >N text (reply in thread of N)
Keys: Tab cycles focus (focused pane marked *), C-p C-n input history, mouse wheel to scroll
Type !help for the full command list`;

export const HELP_TEXT = `\
Display: [N] = message number, ↳N = thread (e.g. [4]↳2 = [4] is a reply in thread of [2])
Syntax (N = message number [N]):
  text                post to current channel
  @bot text           post with a bot mention (Tab completes @bot)
  >N text             reply in thread of N
  >N @bot text        thread reply + mention
  >ts:X text          reply to unobserved raw ts X
  !thread <N|ts:X>    enter thread (alias !t); posts go there
  !leave              leave thread, back to channel
  !react <N|ts:X> <e> react (e: eyes or :eyes:)
  !channel <id>       switch posting channel
  !channels           list channels in config
  !dm on|off          toggle conversation.isDm
  !user <id> [--bot]  switch sender (--bot=isBot)
  !quit               quit (alias !exit, Ctrl-D too)
  !help               show this list
  Unknown /commands are posted as-is (for runner chat commands like /new)
Focus: Tab cycles input/log/chat (focused pane marked *), Esc returns to input
History: C-p / C-n recall previous/next input (while in the input line)
Scroll: arrows / PageUp-Down / C-p C-n on the focused pane, mouse wheel on any pane`;

// ── 2. REPL 状態と行ハンドラ ─────────────────────────────────────────────

export interface ReplState {
  channelId: string;
  userId: string;
  isBot: boolean;
  isDm: boolean;
  /** `!thread N` で入っているスレッドの ts。未設定 = チャンネル直下。
   * seq 参照のラベルは表示用に thread も併せ持つ ({@link threadSeq})。 */
  threadTs?: string;
  /** プロンプト表示用: 入っているスレッドの seq (ログにあれば)。ts のみ参照
   * (`!thread ts:123.456`) で入った場合は undefined。 */
  threadSeq?: number;
}

export function initialReplState(initialChannelId: string): ReplState {
  return {
    channelId: initialChannelId,
    userId: "U_LOCAL",
    isBot: false,
    isDm: false,
  };
}

export function promptText(state: ReplState): string {
  const channel = state.isDm
    ? `#${state.channelId}(dm)`
    : `#${state.channelId}`;
  // 既定ユーザー U_LOCAL はチャット行の表示名 (userResolver の固定マップ) と揃えて
  // you と出す。
  const name = state.userId === "U_LOCAL" ? "you" : state.userId;
  const user = state.isBot ? `${name}(bot)` : name;
  const thread =
    state.threadTs !== undefined
      ? ` ↳[${state.threadSeq ?? state.threadTs}]`
      : "";
  return `${channel} ${user}${thread}> `;
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
export function resolveThreadRef(
  chat: LocalChat,
  ref: ThreadRef,
): { ts: string; channelId?: string } | { error: string } {
  if (ref.kind === "ts") return { ts: ref.ts };
  const msg = chat.bySeq(ref.seq);
  if (msg === undefined) {
    return { error: `unknown reference: [${ref.seq}]` };
  }
  return { ts: msg.ts, channelId: msg.channelId };
}

export function displayName(sender: {
  id: string;
  displayName?: string;
}): string {
  return sender.displayName ?? sender.id;
}

/** handleLine の実行結果。ink 側はこれだけを見て state 更新・prompt 更新・
 * quit 判定・エラー/ヘルプ表示をする (chat.post/react の副作用は本関数の中で
 * 完結させる)。 */
export type HandleLineResult =
  | { kind: "noop" }
  | { kind: "error"; message: string }
  | { kind: "help" }
  | { kind: "channels" }
  | { kind: "quit" }
  | { kind: "state-changed" };

/** 1 行を解釈し、必要なら chat.post/react を呼ぶ。state はその場で書き換える
 * (呼び出し側は同じ state オブジェクトを保持し続ける前提)。 */
export async function handleLine(
  chat: LocalChat,
  state: ReplState,
  line: string,
): Promise<HandleLineResult> {
  const parsed = parseLine(line);

  switch (parsed.kind) {
    case "ignore":
      return { kind: "noop" };

    case "error":
      return { kind: "error", message: parsed.message };

    case "help":
      return { kind: "help" };

    case "channels":
      return { kind: "channels" };

    case "quit":
      return { kind: "quit" };

    case "channel":
      state.channelId = parsed.channelId;
      return { kind: "state-changed" };

    case "dm":
      state.isDm = parsed.on;
      return { kind: "state-changed" };

    case "user":
      state.userId = parsed.userId;
      state.isBot = parsed.isBot;
      return { kind: "state-changed" };

    case "thread": {
      const resolved = resolveThreadRef(chat, parsed.target);
      if ("error" in resolved) {
        return { kind: "error", message: resolved.error };
      }
      state.threadTs = resolved.ts;
      // seq 参照ならプロンプトに [N] を出す。生 ts 参照なら seq 不明。
      if (parsed.target.kind === "seq") {
        state.threadSeq = parsed.target.seq;
      } else {
        delete state.threadSeq;
      }
      // seq 参照でメッセージが別チャンネルに属していれば、そのチャンネルへ移る。
      if (resolved.channelId !== undefined) {
        state.channelId = resolved.channelId;
      }
      return { kind: "state-changed" };
    }

    case "leave":
      delete state.threadTs;
      delete state.threadSeq;
      return { kind: "state-changed" };

    case "react": {
      const resolved = resolveThreadRef(chat, parsed.target);
      if ("error" in resolved) {
        return { kind: "error", message: resolved.error };
      }
      await chat.react(resolved.ts, parsed.emoji, {
        // seq 参照なら対象メッセージのチャンネルへ、生 ts 参照なら現在の
        // チャンネルへ (local-dev.md §3)。
        channelId: resolved.channelId ?? state.channelId,
        sender: { id: state.userId, isBot: state.isBot },
      });
      return { kind: "noop" };
    }

    case "post": {
      let threadTs: string | undefined;
      let channelId = state.channelId;
      if (parsed.thread !== undefined) {
        // 明示 `>N` は入っているスレッドより優先する。
        const resolved = resolveThreadRef(chat, parsed.thread);
        if ("error" in resolved) {
          return { kind: "error", message: resolved.error };
        }
        threadTs = resolved.ts;
        channelId = resolved.channelId ?? state.channelId;
      } else if (state.threadTs !== undefined) {
        // `!thread` で入っているスレッドへ流す。
        threadTs = state.threadTs;
      }

      await chat.post(parsed.text, {
        channelId,
        ...(threadTs !== undefined ? { threadTs } : {}),
        mentionsBot: parsed.mentionsBot,
        sender: { id: state.userId, isBot: state.isBot },
        isDm: state.isDm,
      });
      return { kind: "noop" };
    }
  }
}

// ── 3. 表示用整形 (装飾なし。ANSI 色付けは呼び出し側 (ink) が isSelf 等で行う) ──

export interface FormattedLine {
  text: string;
  /** bot 由来 (postMessage/updateMessage/reaction) の行かどうか。ink 側は
   * これで着色するかを決める。 */
  isSelf: boolean;
}

export function formatMessageLine(
  chat: LocalChat,
  msg: LoggedMessage,
): FormattedLine {
  const header = `[${msg.seq}]`;
  const who = displayName(msg.sender);
  const threadSuffix =
    msg.threadTs !== undefined
      ? (() => {
          const seq = seqForTs(chat, msg.threadTs as string);
          return `↳${seq !== undefined ? seq : msg.threadTs}`;
        })()
      : "";
  const mentionPrefix = msg.mentionsBot === true ? "@bot " : "";
  const body = `${header}${threadSuffix} ${who}: ${mentionPrefix}${msg.text}`;
  const filesSuffix =
    msg.files !== undefined && msg.files.length > 0
      ? `\n${msg.files.map((f) => `   file: ${f}`).join("\n")}`
      : "";

  return { text: `${body}${filesSuffix}`, isSelf: msg.sender.isSelf };
}

export function formatUpdateLine(msg: LoggedMessage): FormattedLine {
  return {
    text: `[${msg.seq}]↺ ${displayName(msg.sender)}: ${msg.text}`,
    isSelf: true,
  };
}

export function formatReactionLine(
  chat: LocalChat,
  record: ReactionRecord,
): FormattedLine {
  const seq = seqForTs(chat, record.ts);
  const target = seq !== undefined ? `[${seq}]` : record.ts;
  return { text: `:${record.emoji}: on ${target}`, isSelf: true };
}
