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

import type { Logger } from "../logger.js";
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

/** チャンネル単位の共有ディレクトリの退避と復元 (docs/design/shared.md §2)。
 * WorkdirStorage と違いキーは channelId のみで、transcript を持たないため
 * session.jsonl の有無によるゲートもコピー順序の担保も行わない。 */
export interface SharedStorage {
  /** 保存棚 → staging へ復元。棚に無ければ何もしない */
  restore(channelId: string, dest: string): Promise<void>;
  /** staging → 保存棚へ退避 */
  flush(channelId: string, src: string): Promise<void>;
}

/** 棚のサイズがこれを超えたら warn する既定値 (shared.md §7: ガードレールでは
 * なく気づきのため。想定は memory/skills/小さなドキュメントで数 MB オーダー、
 * その 10 倍程度を「気づくべき」ラインとする)。 */
const DEFAULT_SHARED_SIZE_WARN_BYTES = 50 * 1024 * 1024;

/** ファイルコピーのみによる SharedStorage 実装。棚は `<baseDir>/<channelId>/`。 */
export class CopySharedStorage implements SharedStorage {
  constructor(
    private readonly baseDir: string,
    private readonly logger?: Logger,
    private readonly warnBytes: number = DEFAULT_SHARED_SIZE_WARN_BYTES,
  ) {}

  async restore(channelId: string, dest: string): Promise<void> {
    const shelf = join(this.baseDir, channelId);
    const entries = await readEntriesOrEmpty(shelf);
    if (entries.length === 0) return;

    await mkdir(dest, { recursive: true });
    for (const entry of entries) {
      await copyRegularEntry(shelf, dest, entry);
    }
  }

  async flush(channelId: string, src: string): Promise<void> {
    const shelf = join(this.baseDir, channelId);
    await mkdir(shelf, { recursive: true });
    for (const entry of await readEntriesOrEmpty(src)) {
      await copyRegularEntry(src, shelf, entry);
    }
    await this.warnIfOversized(channelId, shelf);
  }

  /** ロックなし・上限なしの割り切り (shared.md §3, §7) を維持したまま、肥大化に
   * 運用者が気づけるようログだけ出す。サイズ計測の失敗でターンを失敗させない。 */
  private async warnIfOversized(
    channelId: string,
    shelf: string,
  ): Promise<void> {
    if (this.logger === undefined) return;
    try {
      const bytes = await dirSize(shelf);
      if (bytes > this.warnBytes) {
        this.logger.warn(
          { channelId, bytes, warnBytes: this.warnBytes },
          "shared shelf exceeds size warning threshold",
        );
      }
    } catch {
      // サイズ計測の失敗は無視 (flush 自体は既に成功している)
    }
  }
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readEntriesOrEmpty(dir)) {
    const path = join(dir, entry);
    const info = await lstat(path).catch(() => undefined);
    if (info === undefined) continue;
    total += info.isDirectory() ? await dirSize(path) : info.size;
  }
  return total;
}

/** sharedDir の設定値から対応する SharedStorage を選ぶ。未設定/空文字なら
 * undefined (= shared 機能ごと無効。SessionRunner は undefined を見て staging の
 * 作成・skill 配線・system prompt への言及をすべて省く)。 */
export function createSharedStorage(
  sharedDir: string | undefined,
  logger?: Logger,
  warnBytes?: number,
): SharedStorage | undefined {
  return sharedDir !== undefined && sharedDir !== ""
    ? new CopySharedStorage(sharedDir, logger, warnBytes)
    : undefined;
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
