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
  | ParsedDm
  | ParsedUser
  | ParsedThread
  | ParsedLeave
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
    return { kind: "error", message: `invalid thread reference: ${trimmed}` };
  }
  const [, refToken, rest = ""] = m;
  const thread = parseThreadRef(refToken as string);
  if (thread === null) {
    return {
      kind: "error",
      message: `invalid thread reference (expected a number or number.number): ${refToken}`,
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
          message: "usage: !react <N|ts> <emoji>",
        };
      }
      const target = parseThreadRef(targetToken);
      if (target === null) {
        return {
          kind: "error",
          message: `invalid reference (expected a number or number.number): ${targetToken}`,
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
        return { kind: "error", message: "usage: !thread <N|ts>" };
      }
      const target = parseThreadRef(token);
      if (target === null) {
        return {
          kind: "error",
          message: `invalid reference (expected a number or number.number): ${token}`,
        };
      }
      return { kind: "thread", target };
    }
    case "!leave":
      return { kind: "leave" };
    case "!quit":
      return { kind: "quit" };
    case "!help":
      return { kind: "help" };
    default:
      return { kind: "error", message: `unknown command: ${cmd}` };
  }
}

export const HELP_TEXT = `\
Syntax (N = seq or raw ts):
  text               post to current channel
  @bot text          post with a bot mention
  >N text            reply in thread of N
  >N @bot text       thread reply + mention
  !thread <N|ts>     enter thread (alias !t); posts go there
  !leave             leave thread, back to channel
  !react <N|ts> <e>  react (e: eyes or :eyes:)
  !channel <id>      switch posting channel
  !dm on|off         toggle conversation.isDm
  !user <id> [--bot] switch sender (--bot=isBot)
  !quit              quit (Ctrl-D too)
  !help              show this list
Scroll: arrows/PageUp-Down, Tab switches pane`;

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
   * (`!thread 123.456`) で入った場合は undefined。 */
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
  const parts = [`#${state.channelId}`];
  if (state.isDm) parts.push("dm");
  parts.push(state.isBot ? `${state.userId}(bot)` : state.userId);
  if (state.threadTs !== undefined) {
    // スレッド内にいることを明示 (seq が分かればそれを、なければ ts 末尾)
    const label =
      state.threadSeq !== undefined
        ? `[${state.threadSeq}]`
        : `[${state.threadTs}]`;
    parts.push(`thread:${label}`);
  }
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
    return { text: `⟵ ${body}${filesSuffix}`, isSelf: true };
  }
  return { text: `${body}${filesSuffix}`, isSelf: false };
}

export function formatUpdateLine(msg: LoggedMessage): FormattedLine {
  return {
    text: `⟵ (update [${msg.seq}]) ${displayName(msg.sender)}: ${msg.text}`,
    isSelf: true,
  };
}

export function formatReactionLine(
  chat: LocalChat,
  record: ReactionRecord,
): FormattedLine {
  const seq = seqForTs(chat, record.ts);
  const target = seq !== undefined ? `[${seq}]` : record.ts;
  return { text: `⟵ :${record.emoji}: on ${target}`, isSelf: true };
}
