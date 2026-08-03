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
  constructor(
    private readonly baseDir: string,
    private readonly logger?: Logger,
  ) {}

  async restore(threadKey: string, workdir: string): Promise<boolean> {
    const shelf = shelfPath(this.baseDir, threadKey);
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
    logCopy(this.logger, "workdir restore", { threadKey }, started, stats);
    return true;
  }

  async flush(threadKey: string, workdir: string): Promise<void> {
    const shelf = shelfPath(this.baseDir, threadKey);
    await mkdir(shelf, { recursive: true });

    const started = Date.now();
    const stats: CopyStats = { files: 0, bytes: 0 };
    const entries = await readEntriesOrEmpty(workdir);
    // session.jsonl 以外を先にコピーし、session.jsonl を最後にコピーする
    // (persistence.md §3: 「アトミック性は transcript を最後に置く順序で担保」)。
    const rest = entries.filter((entry) => entry !== SESSION_FILE);
    for (const entry of rest) {
      await copyRegularEntry(workdir, shelf, entry, stats);
    }
    if (entries.includes(SESSION_FILE)) {
      await copyRegularEntry(workdir, shelf, SESSION_FILE, stats);
    }
    logCopy(this.logger, "workdir flush", { threadKey }, started, stats);
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

  /** ロックなし・上限なしの割り切り (shared.md §3, §7) を維持したまま、肥大化に
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
 * info で出す — ターン境界ごとに 1 行で、頻度は turn usage と同程度。 */
function logCopy(
  logger: Logger | undefined,
  msg: string,
  key: Record<string, string>,
  startedAt: number,
  stats: CopyStats,
): void {
  logger?.info({ ...key, durationMs: Date.now() - startedAt, ...stats }, msg);
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
  logger?: Logger,
): WorkdirStorage {
  return archiveDir !== undefined && archiveDir !== ""
    ? new CopyWorkdirStorage(archiveDir, logger)
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
