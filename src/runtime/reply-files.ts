// reply tool の files 引数の境界チェック (docs/design/runtime.md §5.4)。
//
// agent は semi-trusted なので、返信に添付できるファイルを Session の workdir 配下に
// 閉じ込める。Session の状態には依存しない純関数なので Runtime レイヤに置き、
// Session から呼ぶ。

import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

/** 除外したパスを報告する先。Session からは sessionKey 付きの logger が渡る */
export type ReplyFileRejectLogger = (path: string, reason: string) => void;

/** reply の files (agent が渡した workdir 相対パス) を workdirReal 基準の絶対パスへ
 * 解決し、workdir 外へ出るパス (`../` エスケープ、絶対パス指定) は除外して warn する
 * (trust boundary: agent は semi-trusted)。加えて symlink 越しの workdir 外ファイル
 * 参照 (例: `/proc/1/environ` への symlink を workdir 内に作る) を防ぐため、lstat で
 * symlink/非通常ファイルを拒否し、realpath 済みの実体が workdir 配下にあることも
 * 確認する。files 未指定、または全件除外後に空なら undefined を返し、text だけの
 * 従来 payload として deliver させる */
export async function resolveReplyFiles(
  workdirReal: string,
  files: string[] | undefined,
  onReject?: ReplyFileRejectLogger,
): Promise<string[] | undefined> {
  if (files === undefined) return undefined;
  const resolved: string[] = [];
  for (const file of files) {
    const abs = resolve(workdirReal, file);
    const rel = relative(workdirReal, abs);
    const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
    if (!inside) {
      onReject?.(file, "reply file path escapes workdir; dropped");
      continue;
    }
    let fileStat: Awaited<ReturnType<typeof lstat>>;
    try {
      fileStat = await lstat(abs);
    } catch {
      onReject?.(file, "reply file does not exist; dropped");
      continue;
    }
    if (!fileStat.isFile()) {
      onReject?.(
        file,
        "reply file is a symlink or not a regular file; dropped",
      );
      continue;
    }
    const real = await realpath(abs);
    const realRel = relative(workdirReal, real);
    const realInside =
      realRel !== "" && !realRel.startsWith("..") && !isAbsolute(realRel);
    if (!realInside) {
      onReject?.(file, "reply file resolves outside workdir; dropped");
      continue;
    }
    resolved.push(abs);
  }
  return resolved.length > 0 ? resolved : undefined;
}
