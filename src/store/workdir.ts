// WorkdirStorage — docs/design/persistence.md §2, §3
//
// pi の workdir (tmpfs) とセッション境界での退避先 (ローカルディレクトリ or GCS FUSE
// マウント) の間をファイルコピーだけで往復する。GCS SDK は使わない — baseDir が
// 普通のディレクトリでも FUSE マウントでも同じコードで動く。
//
// タスク指示により restore は「復元があったか」を boolean で返す
// (persistence.md 本文の擬似コードは Promise<void> だが、実装はこちらを正とする)。

import { cp, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { SESSION_FILE } from "../session/session-file.js";

/** workdir の退避と復元。実体はディレクトリコピー (persistence.md §2)。 */
export interface WorkdirStorage {
  /** 保存棚 → workdir へ復元。棚に無ければ何もしない。復元があったか boolean で返す */
  restore(threadKey: string, workdir: string): Promise<boolean>;
  /** workdir → 保存棚へ退避 */
  flush(threadKey: string, workdir: string): Promise<void>;
}

/** threadKey (`<channelId>:<threadTs>`) を棚のパスに変換する。
 * `:` を `/` に置き換えると session-runtime.md §3 の `/data/channels/<ch>/<threadTs>/`
 * と揃う。 */
function shelfPath(baseDir: string, threadKey: string): string {
  const segments = threadKey.split(":");
  return join(baseDir, ...segments);
}

/** ファイルコピーのみによる WorkdirStorage 実装 (persistence.md §2)。 */
export class CopyWorkdirStorage implements WorkdirStorage {
  constructor(private readonly baseDir: string) {}

  async restore(threadKey: string, workdir: string): Promise<boolean> {
    const shelf = shelfPath(this.baseDir, threadKey);
    const entries = await readEntriesOrEmpty(shelf);
    if (!entries.includes(SESSION_FILE)) {
      return false;
    }

    await mkdir(workdir, { recursive: true });
    for (const entry of entries) {
      await copyRegularEntry(shelf, workdir, entry);
    }
    return true;
  }

  async flush(threadKey: string, workdir: string): Promise<void> {
    const shelf = shelfPath(this.baseDir, threadKey);
    await mkdir(shelf, { recursive: true });

    const entries = await readEntriesOrEmpty(workdir);
    // session.jsonl 以外を先にコピーし、session.jsonl を最後にコピーする
    // (persistence.md §3: 「アトミック性は transcript を最後に置く順序で担保」)。
    const rest = entries.filter((entry) => entry !== SESSION_FILE);
    for (const entry of rest) {
      await copyRegularEntry(workdir, shelf, entry);
    }
    if (entries.includes(SESSION_FILE)) {
      await copyRegularEntry(workdir, shelf, SESSION_FILE);
    }
  }
}

/** 境界退避なし (アーカイブ先未設定時の既定)。restore は常に false、flush は何もしない。 */
export class NoopWorkdirStorage implements WorkdirStorage {
  async restore(_threadKey: string, _workdir: string): Promise<boolean> {
    return false;
  }
  async flush(_threadKey: string, _workdir: string): Promise<void> {}
}

/** archiveDir の設定値から対応する WorkdirStorage を選ぶ。未設定/空文字なら Noop。 */
export function createWorkdirStorage(
  archiveDir: string | undefined,
): WorkdirStorage {
  return archiveDir !== undefined && archiveDir !== ""
    ? new CopyWorkdirStorage(archiveDir)
    : new NoopWorkdirStorage();
}

async function readEntriesOrEmpty(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

/** 通常ファイル・ディレクトリのみをコピーする (socket 等の特殊ファイルを除外)。
 * コピー先の同名エントリは置き換える (上書き)。 */
async function copyRegularEntry(
  srcDir: string,
  destDir: string,
  entry: string,
): Promise<void> {
  const src = join(srcDir, entry);
  const dest = join(destDir, entry);
  await rm(dest, { recursive: true, force: true });
  await cp(src, dest, {
    recursive: true,
    filter: (source) => isRegularOrDirectory(source),
  });
}

async function isRegularOrDirectory(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isFile() || stat.isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}
