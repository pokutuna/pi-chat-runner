// ファイルコピーによる Agent State の棚の実装 — docs/design/state.md §5, §7
//
// pi の workdir (tmpfs) とセッション境界での退避先 (ローカルディレクトリ or GCS FUSE
// マウント) の間をファイルコピーだけで往復する。GCS SDK は使わない — baseDir が
// 普通のディレクトリでも FUSE マウントでも同じコードで動く。

import { cp, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { Logger } from "../../logger.js";
import { SESSION_FILE } from "../../runtime/session-file.js";
import type { SharedStore, WorkdirStore } from "./interfaces.js";
import { NoopWorkdirStore } from "./noop.js";

/** sessionKey (`<channelId>:<threadTs>`) を棚のパスに変換する。
 * `:` を `/` に置き換えると state.md §6 の `<workdirBase>/<channelId>/<threadTs>/`
 * と揃う。 */
function shelfPath(baseDir: string, sessionKey: string): string {
  const segments = sessionKey.split(":");
  return join(baseDir, ...segments);
}

/** ファイルコピーのみによる WorkdirStore 実装 (state.md §5)。 */
export class CopyWorkdirStore implements WorkdirStore {
  constructor(
    private readonly baseDir: string,
    private readonly logger?: Logger,
  ) {}

  async restore(sessionKey: string, workdir: string): Promise<boolean> {
    const shelf = shelfPath(this.baseDir, sessionKey);
    const entries = await readEntriesOrEmpty(shelf);
    if (!entries.includes(SESSION_FILE)) {
      return false;
    }

    const started = Date.now();
    const stats: CopyStats = { files: 0, bytes: 0 };
    await mkdir(workdir, { recursive: true });
    for (const entry of entries) {
      await copyRegularEntry(shelf, workdir, entry, stats);
    }
    logCopy(this.logger, "workdir restore", { sessionKey }, started, stats);
    return true;
  }

  async flush(sessionKey: string, workdir: string): Promise<void> {
    const shelf = shelfPath(this.baseDir, sessionKey);
    await mkdir(shelf, { recursive: true });

    const started = Date.now();
    const stats: CopyStats = { files: 0, bytes: 0 };
    const entries = await readEntriesOrEmpty(workdir);
    // session.jsonl 以外を先にコピーし、session.jsonl を最後にコピーする
    // (state.md §5.1: 「flush は session.jsonl を最後に書く」)。
    const rest = entries.filter((entry) => entry !== SESSION_FILE);
    for (const entry of rest) {
      await copyRegularEntry(workdir, shelf, entry, stats);
    }
    if (entries.includes(SESSION_FILE)) {
      await copyRegularEntry(workdir, shelf, SESSION_FILE, stats);
    }
    logCopy(this.logger, "workdir flush", { sessionKey }, started, stats);
  }
}

/** 棚のサイズがこれを超えたら warn する既定値 (state.md §5.1: ガードレールでは
 * なく気づきのため。想定は memory/skills/小さなドキュメントで数 MB オーダー、
 * その 10 倍程度を「気づくべき」ラインとする)。 */
const DEFAULT_SHARED_SIZE_WARN_BYTES = 50 * 1024 * 1024;

/** ファイルコピーのみによる SharedStore 実装。棚は `<baseDir>/<channelId>/`。 */
export class CopySharedStore implements SharedStore {
  constructor(
    private readonly baseDir: string,
    private readonly logger?: Logger,
    private readonly warnBytes: number = DEFAULT_SHARED_SIZE_WARN_BYTES,
  ) {}

  async restore(channelId: string, dest: string): Promise<void> {
    const shelf = join(this.baseDir, channelId);
    const entries = await readEntriesOrEmpty(shelf);
    if (entries.length === 0) return;

    const started = Date.now();
    const stats: CopyStats = { files: 0, bytes: 0 };
    await mkdir(dest, { recursive: true });
    for (const entry of entries) {
      await copyRegularEntry(shelf, dest, entry, stats);
    }
    logCopy(this.logger, "shared restore", { channelId }, started, stats);
  }

  async flush(channelId: string, src: string): Promise<void> {
    const shelf = join(this.baseDir, channelId);
    await mkdir(shelf, { recursive: true });
    const started = Date.now();
    const stats: CopyStats = { files: 0, bytes: 0 };
    for (const entry of await readEntriesOrEmpty(src)) {
      await copyRegularEntry(src, shelf, entry, stats);
    }
    logCopy(this.logger, "shared flush", { channelId }, started, stats);
    this.warnIfOversized(channelId, stats.bytes);
  }

  /** ロックなし・上限なしの割り切り (state.md §5.2, §5.1) を維持したまま、肥大化に
   * 運用者が気づけるようログだけ出す。
   *
   * 判定は「今 flush した staging の総バイト数」= コピー中に数えた値で行い、棚を
   * 走査し直さない。棚は staging のコピーなので概算として十分で、走査は棚 (FUSE
   * の場合ネットワーク越し) のファイル数に比例するコストを毎ターン払うことになる —
   * 気づきのための警告に対して高すぎる。削除が伝播しない分だけ棚は staging より
   * 大きくなりうる (#12) が、その差で警告の役目は損なわれない。 */
  private warnIfOversized(channelId: string, bytes: number): void {
    if (bytes > this.warnBytes) {
      this.logger?.warn(
        { channelId, bytes, warnBytes: this.warnBytes },
        "shared staging exceeds size warning threshold",
      );
    }
  }
}

/** コピー量と所要時間を記録する。どの案 (差分化 / 除外 / まとめて 1 エントリ) が
 * 効くかは files と bytes のどちらが支配的かで変わるため、判断材料として両方残す。
 * info で出す — Turn 境界ごとに 1 行で、頻度は session usage と同程度。 */
function logCopy(
  logger: Logger | undefined,
  msg: string,
  key: Record<string, string>,
  startedAt: number,
  stats: CopyStats,
): void {
  logger?.info({ ...key, durationMs: Date.now() - startedAt, ...stats }, msg);
}

/** sharedDir の設定値から対応する SharedStore を選ぶ。未設定/空文字なら
 * undefined (= shared 機能ごと無効。Dispatcher は undefined を見て staging の
 * 作成・skill 配線・system prompt への言及をすべて省く)。 */
export function createSharedStore(
  sharedDir: string | undefined,
  logger?: Logger,
  warnBytes?: number,
): SharedStore | undefined {
  return sharedDir !== undefined && sharedDir !== ""
    ? new CopySharedStore(sharedDir, logger, warnBytes)
    : undefined;
}

/** archiveDir の設定値から対応する WorkdirStore を選ぶ。未設定/空文字なら Noop。 */
export function createWorkdirStore(
  archiveDir: string | undefined,
  logger?: Logger,
): WorkdirStore {
  return archiveDir !== undefined && archiveDir !== ""
    ? new CopyWorkdirStore(archiveDir, logger)
    : new NoopWorkdirStore();
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

/** コピー量の計測結果。flush のコストは転送バイト数より往復回数 (= files) に
 * 支配される — 棚が GCS FUSE の場合 1 ファイルが 1 オブジェクト書き込みになるため。
 * どちらが効いているか切り分けられるよう両方記録する。 */
interface CopyStats {
  files: number;
  bytes: number;
}

/** 通常ファイル・ディレクトリのみをコピーする (socket 等の特殊ファイルを除外)。
 * コピー先の同名エントリは置き換える (上書き)。
 *
 * 計測は cp の filter に相乗りする — コピー後に改めて走査すると、棚が FUSE の
 * ときに stat の往復が二重になる。 */
async function copyRegularEntry(
  srcDir: string,
  destDir: string,
  entry: string,
  stats?: CopyStats,
): Promise<void> {
  const src = join(srcDir, entry);
  const dest = join(destDir, entry);
  await rm(dest, { recursive: true, force: true });
  await cp(src, dest, {
    recursive: true,
    filter: async (source) => {
      const info = await lstat(source).catch(() => undefined);
      if (info === undefined) return false;
      if (info.isFile()) {
        if (stats !== undefined) {
          stats.files += 1;
          stats.bytes += info.size;
        }
        return true;
      }
      return info.isDirectory();
    },
  });
}
