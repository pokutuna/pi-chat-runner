import type { ChannelDoc } from "../config/channel-doc.js";

/** app 共通プロンプトのプラットフォーム中立な固定部分。ChannelDoc.systemPrompt は
 * これへの追記分 (architecture.md §2)。mention 記法の説明は mentionFormat に依存する
 * ため別関数 (mentionInstruction) で組み立て、buildSystemPrompt で結合する */
const APP_SYSTEM_PROMPT = [
  "You are an assistant running inside a chat thread.",
  "Your response reaches the user ONLY through the reply(thread_key, text) tool;",
  "plain assistant text is never delivered.",
  "If no response is needed, simply do not call reply.",
].join(" ");

/** ユーザーへの言及をレンダリングする関数 (返信本文に埋め込む記法)。
 * プラットフォームごとに記法が異なるため SessionRunnerOptions では必須
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

/** /new コマンドの拒否通知 (実行中セッションへは v1 の割り切りで交錯させない、
 * session-model.md §6)。abnormalShutdown の noticeText と同じ mrkdwn 絵文字スタイル */
export const REJECT_NOTICE_TEXT =
  ":warning: セッションが実行中のため、いまは /new できません。完了後にもう一度送ってください";

/** /new コマンド (rest なし) の受理通知 */
export const ACK_NOTICE_TEXT =
  ":new: 次のメッセージから新しいセッションを開始します";

/** /disable コマンドの受理通知 (session-model.md §5) */
export const DISABLE_NOTICE_TEXT =
  ":no_bell: このチャンネルでの起動を無効化しました。`/enable` (bot へのメンション付き) で再開できます";

/** /enable コマンドの受理通知 (session-model.md §5) */
export const ENABLE_NOTICE_TEXT =
  ":bell: このチャンネルでの起動を有効化しました";

/** shared 有効時に system prompt へ足す説明 (docs/design/shared.md §3)。
 * 使い方の規約 (memory の書き方) は組み込み memory skill 側が担い、ここでは
 * ディレクトリの存在と性質だけ知らせる */
const SHARED_DIR_PROMPT =
  "../shared/ (relative to your working directory) is a channel-wide " +
  "persistent directory: files there survive across sessions and threads " +
  "in this channel. Skills placed under ../shared/skills/ are loaded " +
  "automatically in future sessions.";

/** memory の索引 (MEMORY.md) をそのまま system prompt に注入するための前置き
 * (docs/design/memory.md §2)。索引は常時見える化し、本文ファイルの read は
 * 引き続き組み込み skill 側の判断に委ねる (skill 発火に頼らないのは索引だけ) */
const MEMORY_INDEX_PROMPT_HEADER =
  "The following is this channel's memory index " +
  "(../shared/memory/MEMORY.md), listing durable facts learned in past " +
  "sessions. Read the linked file under ../shared/memory/ only if it looks " +
  "relevant to the current task:";

/** app 共通 + mention 記法の説明 + shared の説明 + memory 索引 +
 * ChannelDoc.systemPrompt + thread_key の指示 (session-runtime.md §2) */
export function buildSystemPrompt(
  sessionKey: string,
  doc: ChannelDoc | null,
  mentionFormat: MentionFormat,
  sharedEnabled: boolean,
  memoryIndex?: string,
): string {
  const parts = [APP_SYSTEM_PROMPT, mentionInstruction(mentionFormat)];
  if (sharedEnabled) parts.push(SHARED_DIR_PROMPT);
  if (memoryIndex !== undefined && memoryIndex.trim() !== "") {
    parts.push(`${MEMORY_INDEX_PROMPT_HEADER}\n\n${memoryIndex.trim()}`);
  }
  if (doc?.systemPrompt !== undefined) parts.push(doc.systemPrompt.trim());
  parts.push(
    "Each incoming message is annotated with its thread_key. When calling " +
      "the reply tool, use the thread_key of the message you are replying to " +
      "(the most recent one if replying generally). " +
      `Fallback thread_key for this session: ${sessionKey}`,
  );
  return parts.join("\n\n");
}

export function prependContext(body: string, doc: ChannelDoc | null): string {
  const context = doc?.context;
  if (context === undefined || context.length === 0) return body;
  return `参考情報:\n${context.map((c) => c.trim()).join("\n\n")}\n\n${body}`;
}
