// Agent への入力 (system prompt / context 前置き) の組み立て
// (docs/design/runtime.md §6)。チャットへ返す通知文は Egress 側 (egress/notices.ts)。

import type { ResolvedChannel } from "../config/config-source.js";

/** app 共通プロンプトのプラットフォーム中立な固定部分。AgentConfig.systemPrompt は
 * これへの追記分 (runtime.md §6)。mention 記法の説明は mentionFormat に依存する
 * ため別関数 (mentionInstruction) で組み立て、buildSystemPrompt で結合する */
const APP_SYSTEM_PROMPT = [
  "You are an assistant running inside a chat thread.",
  "Your response reaches the user ONLY through the reply(thread_key, text) tool;",
  "plain assistant text is never delivered.",
  "If no response is needed, simply do not call reply.",
].join(" ");

/** ユーザーへの言及をレンダリングする関数 (返信本文に埋め込む記法)。
 * プラットフォームごとに記法が異なるため DispatcherOptions では必須
 * (bridge が利用先プラットフォームの記法を渡す。bridge 以外の利用者は自分で実装を渡す) */
export type MentionFormat = (userId: string) => string;

/** mention 記法の説明文を組み立てる。mentionFormat の出力例をそのまま
 * システムプロンプトへ埋め込み、実際の記法をエージェントに示す */
function mentionInstruction(mentionFormat: MentionFormat): string {
  return (
    "Users appear as `name (USER_ID)`; to mention one in a reply, write " +
    `${mentionFormat("USER_ID")} (not the plain name).`
  );
}

/** shared 有効時に system prompt へ足す説明 (docs/design/runtime.md §6)。
 * 使い方の規約 (memory の書き方) は組み込み memory skill 側が担い、ここでは
 * ディレクトリの存在と性質だけ知らせる */
const SHARED_DIR_PROMPT =
  "../shared/ (relative to your working directory) is a channel-wide " +
  "persistent directory: files there survive across sessions and threads " +
  "in this channel. Skills placed under ../shared/skills/ are loaded " +
  "automatically in future sessions.";

/** memory の索引 (MEMORY.md) をそのまま system prompt に注入するための前置き
 * (docs/design/runtime.md §6)。索引は常時見える化し、本文ファイルの read は
 * 引き続き組み込み skill 側の判断に委ねる (skill 発火に頼らないのは索引だけ) */
const MEMORY_INDEX_PROMPT_HEADER =
  "The following is this channel's memory index " +
  "(../shared/memory/MEMORY.md), listing durable facts learned in past " +
  "sessions. Read the linked file under ../shared/memory/ only if it looks " +
  "relevant to the current task:";

/** app 共通 + mention 記法の説明 + shared の説明 + memory 索引 +
 * AgentConfig.systemPrompt + thread_key の指示 (runtime.md §6) */
export function buildSystemPrompt(
  sessionKey: string,
  channel: ResolvedChannel | null,
  mentionFormat: MentionFormat,
  sharedEnabled: boolean,
  memoryIndex?: string,
): string {
  const parts = [APP_SYSTEM_PROMPT, mentionInstruction(mentionFormat)];
  if (sharedEnabled) parts.push(SHARED_DIR_PROMPT);
  if (memoryIndex !== undefined && memoryIndex.trim() !== "") {
    parts.push(`${MEMORY_INDEX_PROMPT_HEADER}\n\n${memoryIndex.trim()}`);
  }
  if (channel?.agent.systemPrompt !== undefined)
    parts.push(channel.agent.systemPrompt.trim());
  parts.push(
    "Each incoming message is annotated with its thread_key. When calling " +
      "the reply tool, use the thread_key of the message you are replying to " +
      "(the most recent one if replying generally). " +
      `Fallback thread_key for this session: ${sessionKey}`,
  );
  return parts.join("\n\n");
}

export function prependContext(
  body: string,
  channel: ResolvedChannel | null,
): string {
  const context = channel?.agent.context;
  if (context === undefined || context.length === 0) return body;
  return `参考情報:\n${context.map((c) => c.trim()).join("\n\n")}\n\n${body}`;
}
