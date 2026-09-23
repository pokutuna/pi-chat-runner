// セッションファイル名の single source of truth。
// src/runtime/prepare.ts (spawn 時のパス組み立て・rotate) と src/state/agent/copy.ts
// (境界退避での対象ファイル判定) の両方から参照する。

/** pi の --session に渡すセッションファイル名。1 sessionKey = 1 workdir = この固定名 1 ファイル。
 * pi 由来の名前ではなく本プロジェクトの命名 (pi の --session は任意パスを受け取る)。 */
export const SESSION_FILE = "session.jsonl";

/** 世代交代時のリネーム先を生成する (session-<epoch ms>.jsonl)。 */
export function rotatedSessionFile(epochMs: number): string {
  return `session-${epochMs}.jsonl`;
}
