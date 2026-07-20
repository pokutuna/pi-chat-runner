import { preview } from "./pi-events.js";

/** 進捗通知でツール名ごとに絵文字を出し分ける (progress-notice.md)。
 * reply は呼び出し元 (tool_execution_start ハンドラ) で除外済みなのでここには
 * 来ない。分類が当たらないツールは既定の :gear: にフォールバックする。bash は
 * 頻出のため呼び出しごとに候補からランダムに1つ選び、単調な見た目にならない
 * ようにする */
export function progressEmoji(toolName: string): string {
  switch (toolName) {
    case "bash":
      return (
        BASH_EMOJIS[Math.floor(Math.random() * BASH_EMOJIS.length)] ??
        ":computer:"
      );
    case "read":
    case "grep":
    case "find":
    case "ls":
      return ":mag:";
    case "write":
    case "edit":
      return ":memo:";
    default:
      return ":gear:";
  }
}

const BASH_EMOJIS = [
  ":computer:",
  ":keyboard:",
  ":zap:",
  ":gear:",
  ":hammer_and_wrench:",
  ":rocket:",
  ":robot_face:",
  ":satellite:",
];

/** pi 組み込みツール (bash/read/write/edit/grep/find/ls) の主要な引数キー1つの
 * 値だけを取り出す。JSON.stringify のキー名込み表示 (`{"command":"..."}`) は
 * 進捗通知としては冗長なため。組み込み以外の (extension 由来の) ツールは
 * キー構成を把握できないので preview() の汎用フォールバックに委ねる */
export function toolArgsPreview(
  toolName: string,
  args: unknown,
  maxChars: number,
): string {
  const key = BUILTIN_TOOL_PRIMARY_ARG_KEY[toolName];
  if (key === undefined) return preview(args, maxChars);
  const value =
    typeof args === "object" && args !== null
      ? (args as Record<string, unknown>)[key]
      : undefined;
  return value === undefined ? "" : preview(value, maxChars);
}

const BUILTIN_TOOL_PRIMARY_ARG_KEY: Record<string, string> = {
  bash: "command",
  read: "path",
  ls: "path",
  write: "path",
  edit: "path",
  grep: "pattern",
  find: "pattern",
};
