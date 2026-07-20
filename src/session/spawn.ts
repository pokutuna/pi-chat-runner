// kick 前半 (spawn 準備) の抽出先 — 「入力 → PiProcess を作るための準備」であり
// SessionRecord の可変状態にはほぼ依存しない (docs/design/components.md
// 「spawn の引数・env の掃除・workdir と flush」は session-runtime.md の関心事)。
// PiProcess の生成・イベントハンドラ登録・SessionRecord への書き込みは kick に残す。

import { existsSync } from "node:fs";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ChannelDoc } from "../config/channel-doc.js";
import type { Logger } from "../logger.js";
import type { SessionStore } from "../store/state/interfaces.js";
import type { SharedStorage, WorkdirStorage } from "../store/workdir.js";
import { isIdleExpired, type SessionPolicy } from "./policy.js";
import {
  buildPiPermissionOptions,
  type PiPermissionOptions,
} from "./runtime.js";
import { rotatedSessionFile, SESSION_FILE } from "./session-file.js";

/** 組み込み extension のファイル名 (リポジトリ/パッケージ直下の extensions/)。
 * reply は唯一の返信経路、permission-gate は事故防止層 (config.md §5) で、どの
 * プラットフォームで使う場合も常時注入する — プラットフォーム非依存なので呼び出し側に
 * 渡させず SessionRunner 自身が解決する。export は標準機能として同様に扱う。
 * pi が --extension で TS ソースを直接ロードするためビルド対象外。 */
export const BUILTIN_EXTENSION_NAMES = [
  "reply.ts",
  "permission-gate.ts",
  "export.ts",
] as const;

/** 組み込み extension の絶対パスを解決する。extensions/ はソースツリーでもパッケージ
 * 配布物 (package.json files) でもルート直下にあるが、このモジュール自身の位置が
 * tsx 実行時 (src/session/) とバンドル後 (dist/ 直下) で深さが変わるため、候補を
 * 実在チェックで選ぶ。見つからなければ配置が壊れているので fail-loud。 */
export function resolveBuiltinExtensionPaths(): string[] {
  for (const rel of ["../extensions/", "../../extensions/"]) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(join(dir, BUILTIN_EXTENSION_NAMES[0]))) {
      return BUILTIN_EXTENSION_NAMES.map((name) => join(dir, name));
    }
  }
  throw new Error(
    `built-in extensions not found relative to ${import.meta.url} (expected an "extensions/" directory at the package root)`,
  );
}

/** 組み込み memory skill (リポジトリ/パッケージ直下の builtin-skills/memory/) の
 * 絶対パスを解決する (docs/design/memory.md)。shared 有効時のみ使われる。
 * ルート直下の skills/ (利用者が $AGENT_HOME に焼き込む全チャンネル共通 skill の口。
 * Dockerfile 参照) とは別物 — そちらに置くと pi の HOME 自動発見で全チャンネルに
 * 効いてしまい、ChannelDoc.memory の opt-out が効かない。配置と解決規則は
 * resolveBuiltinExtensionPaths と同じ — ソースツリーとバンドル後で深さが変わるため
 * 候補を実在チェックで選び、見つからなければ fail-loud。 */
export function resolveBuiltinMemorySkillPath(): string {
  for (const rel of [
    "../builtin-skills/memory",
    "../../builtin-skills/memory",
  ]) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(join(dir, "SKILL.md"))) {
      return dir;
    }
  }
  throw new Error(
    `built-in memory skill not found relative to ${import.meta.url} (expected "builtin-skills/memory/SKILL.md" at the package root)`,
  );
}

/** チャンネル別の追加 skill / extension パス (ChannelDoc.skills / .extensions,
 * config.md §2) を検証し realpath で正規化する。イメージに焼き込んだパスを指す
 * 想定なので、実在しないパスは設定ミスとして fail-loud で throw する。
 * extension は pi の --extension がディレクトリを受けないため .ts/.js に限る。 */
export async function resolveChannelResourcePaths(
  paths: string[] | undefined,
  kind: "skills" | "extensions",
): Promise<string[]> {
  if (paths === undefined || paths.length === 0) return [];
  return await Promise.all(
    paths.map(async (path) => {
      if (
        kind === "extensions" &&
        !path.endsWith(".ts") &&
        !path.endsWith(".js")
      ) {
        throw new Error(
          `channel extensions entry must be a .ts/.js file: ${path}`,
        );
      }
      try {
        return await realpath(path);
      } catch (err) {
        throw new Error(`channel ${kind} path not found: ${path}`, {
          cause: err,
        });
      }
    }),
  );
}

/** workdir の session.jsonl が既に存在するか (pi が既存 transcript を読んで
 * 文脈継続するかどうかの判定。restore 後に評価すれば保存棚からの復元も拾える)。 */
export async function transcriptExists(sessionPath: string): Promise<boolean> {
  try {
    await stat(sessionPath);
    return true;
  } catch {
    return false;
  }
}

/** channel モードの idle リセット (session-model.md §3): workdir 直下の
 * session.jsonl が存在すれば session-<epoch ms>.jsonl にリネームして世代交代する。
 * pi は transcript が無ければ新規会話として開始する。workdir の他のファイルは残す */
export async function rotateTranscript(
  workdir: string,
  now: number,
): Promise<void> {
  const from = join(workdir, SESSION_FILE);
  const to = join(workdir, rotatedSessionFile(now));
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

/** dir 配下 (dir 自身含む) を再帰的に chown する。workdir 専用 — UID 分離時、
 * restore で root 所有のままコピーされたファイルを agent 所有に揃えるための
 * 最小実装 (エントリ数が少ない workdir 前提。fs.cp に uid/gid オプションは
 * 無いためコピー後にここで chown する)。
 * シンボリックリンクは辿らずスキップする: pi が workdir 内に /data 等への
 * リンクを仕込み、次の restore 後に root の Runner がリンク先を chown して
 * 所有権を奪われる経路を防ぐ (リンク自体の所有者は挙動に影響しない) */
export async function chownRecursive(
  dir: string,
  uid: number,
  gid: number,
): Promise<void> {
  await chown(dir, uid, gid);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    const info = await lstat(path).catch(() => null);
    if (info === null || info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      await chownRecursive(path, uid, gid);
    } else {
      await chown(path, uid, gid);
    }
  }
}

/** kick 前半、設定バリデーション warn 群 (session-model.md §3)。session.mode /
 * reply.mode の非推奨な組み合わせ、channel モード専用オプションの thread モードでの
 * 指定、affinity.scope=channel の冗長設定を検知して warn するのみ (throw しない)。
 * record への書き込みは行わない */
export function warnPolicyMismatches(
  logger: Logger,
  sessionKey: string,
  channelId: string,
  policy: SessionPolicy,
  doc: ChannelDoc | null,
): void {
  // session.mode=thread かつ reply.mode=flat は文脈が切れるのに返事だけ散らばる
  // 非推奨な組み合わせ。動作は許可するので warn のみ (session-model.md §3)
  if (policy.sessionMode === "thread" && policy.replyMode === "flat") {
    logger.warn(
      { sessionKey, channelId },
      "session.mode=thread with reply.mode=flat is discouraged (session-model.md §3)",
    );
  }
  // idleResetMinutes / maxTranscriptKb は channel モード専用 (session-model.md §3)。
  // thread モードで設定されていても効果がないため warn して無視する
  if (
    policy.sessionMode === "thread" &&
    (doc?.session?.idleResetMinutes !== undefined ||
      doc?.session?.maxTranscriptKb !== undefined)
  ) {
    logger.warn(
      { sessionKey, channelId },
      "session.idleResetMinutes / maxTranscriptKb are only effective with session.mode=channel; ignored",
    );
  }
  // affinity は mode=channel では自明に成立 (同一 sessionKey) するため意味を持たない。
  // windowSec も scope=channel 以外では読まれない (session-model.md §3)
  const affinity = doc?.session?.affinity;
  if (affinity?.scope === "channel" && policy.sessionMode === "channel") {
    logger.warn(
      { sessionKey, channelId },
      "session.affinity.scope=channel is redundant with session.mode=channel; ignored",
    );
  }
  if (
    affinity?.windowSec !== undefined &&
    affinity.windowSec > 0 &&
    affinity.scope !== "channel"
  ) {
    logger.warn(
      { sessionKey, channelId },
      "session.affinity.windowSec is only effective with scope=channel; ignored",
    );
  }
}

/** prepareWorkdir が返す、kick 後続処理 (extension/skill 解決・PiProcess 生成) に
 * 必要な値。record への書き込みはここでは行わず、呼び出し側 (kick) が
 * resumed の記録・ログ出力等に使う */
export interface PreparedWorkdir {
  /** realpath 正規化済みの workdir 絶対パス */
  workdirReal: string;
  /** realpath 正規化済みの agentHome 絶対パス */
  agentHomeReal: string;
  /** shared staging の realpath 正規化済み絶対パス (shared 無効なら undefined) */
  sharedDirReal: string | undefined;
  /** workdirReal 直下の session.jsonl 絶対パス */
  sessionPath: string;
  /** kick 開始時点で session.jsonl が既に存在したか (resume 判定用ログに使う) */
  resumed: boolean;
}

/** kick 前半、workdir/shared の mkdir + restore、transcript 世代交代 (manual →
 * idle → size)、UID 分離 (chown/chmod)、agentHome 作成、realpath 正規化をまとめて
 * 行う (session-runtime.md §1 restore → spawn の restore 側、§6 UID 分離)。
 *
 * 副作用の実行順序はそのまま維持する: mkdir → restore (workdir → shared) →
 * transcript 世代交代 (manual → idle → size) → workdir/shared の chown → agentHome
 * 作成/chown → realpath 正規化。sessions store への書き込み (rotateRequestedAt
 * クリア) はここで行うが、SessionRecord の可変状態には触れない。 */
export async function prepareWorkdir(args: {
  sessionKey: string;
  channelId: string;
  workdir: string;
  policy: SessionPolicy;
  doc: ChannelDoc | null;
  sessions: SessionStore;
  workdirStorage: WorkdirStorage;
  sharedStorage: SharedStorage | undefined;
  sharedStagingDir: (channelId: string) => string;
  agentUid: number | undefined;
  agentGid: number | undefined;
  agentHome: string;
  logger: Logger;
}): Promise<PreparedWorkdir> {
  const {
    sessionKey,
    channelId,
    workdir,
    policy,
    doc,
    sessions,
    workdirStorage,
    sharedStorage,
    sharedStagingDir,
    agentUid,
    agentGid,
    agentHome,
    logger,
  } = args;

  // 同 sessionKey は常に同じ workdir/session.jsonl を使う。再 trigger 時は
  // 同じパスで再 spawn され、pi が JSONL を読んで文脈を継続する (再開の専用フローなし)
  await mkdir(workdir, { recursive: true });
  await workdirStorage.restore(sessionKey, workdir);
  // チャンネル共有ディレクトリ (docs/design/shared.md)。sessionKey ではなく
  // channelId 単位で復元し、スレッド (セッション) を跨いで持ち越す。skills/ は
  // 空でも常に作る — pi の --skill は空ディレクトリを黙って無視するので配線は
  // 無条件でよく、agent は mkdir なしで skill を置ける
  const sharedDir =
    sharedStorage !== undefined ? sharedStagingDir(channelId) : undefined;
  if (sharedStorage !== undefined && sharedDir !== undefined) {
    await mkdir(join(sharedDir, "skills"), { recursive: true });
    await sharedStorage.restore(channelId, sharedDir);
  }
  // 世代交代 (session-model.md §3, §6): manual (/new マーカー) → idle 超過 →
  // transcript サイズ超過の優先順位で、いずれか 1 回だけ transcript を
  // 世代交代する。previous は idle 判定にも使うため、ここで常時 1 回だけ fetch
  // して使い回す。rotate は chown より前 (rotate されたファイルの所有権も
  // chown で揃うため)
  const previous = await sessions.get(sessionKey);
  let rotated = false;
  // manual は session.mode に依存しない (thread モードでも効く) — idle/size が
  // channel モード限定なのとは異なる、明示的なユーザー意図のため (session-model.md §6)
  if (previous?.rotateRequestedAt !== undefined) {
    const now = Date.now();
    await rotateTranscript(workdir, now);
    rotated = true;
    logger.info({ sessionKey }, "manual reset: transcript rotated");
    // マーカーをクリアして put し直す (exactOptionalPropertyTypes: true のため
    // rotateRequestedAt を持つプロパティ自体を作らない)
    const { rotateRequestedAt: _rotateRequestedAt, ...cleared } = previous;
    await sessions.put(sessionKey, cleared);
  }
  // idleResetMinutes / maxTranscriptKb は channel モード専用 (session-model.md §3)
  if (policy.sessionMode === "channel") {
    const idleResetMinutes = doc?.session?.idleResetMinutes;
    if (!rotated && idleResetMinutes !== undefined && previous !== null) {
      const now = Date.now();
      if (isIdleExpired(previous.updatedAt, idleResetMinutes, now)) {
        await rotateTranscript(workdir, now);
        rotated = true;
        logger.info(
          {
            sessionKey,
            idleResetMinutes,
            idleMs: now - previous.updatedAt.getTime(),
          },
          "idle reset: transcript rotated",
        );
      }
    }
    const maxTranscriptKb = doc?.session?.maxTranscriptKb;
    if (!rotated && maxTranscriptKb !== undefined) {
      const info = await stat(join(workdir, SESSION_FILE)).catch((err) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      });
      if (info !== null && info.size > maxTranscriptKb * 1024) {
        const now = Date.now();
        await rotateTranscript(workdir, now);
        logger.info(
          { sessionKey, maxTranscriptKb, sizeBytes: info.size },
          "size reset: transcript rotated",
        );
      }
    }
  }
  // UID 分離 (session-runtime.md §6) が有効なら、workdir を agent 所有 0700 に
  // する。mkdir は Runner (root) 実行なので root 所有で作られ、restore で
  // コピーされたファイルも root 所有になる — agent uid で書き込めるよう
  // restore 後に再帰的に chown する (root だけが chown できるので、この処理は
  // uid オプションが設定されているときだけ行う)
  if (agentUid !== undefined && agentGid !== undefined) {
    await chownRecursive(workdir, agentUid, agentGid);
    await chmod(workdir, 0o700);
    // shared staging も同じ理由で agent 所有 0700 に揃える (restore のコピーは
    // root 所有で置かれる)
    if (sharedDir !== undefined) {
      await chownRecursive(sharedDir, agentUid, agentGid);
      await chmod(sharedDir, 0o700);
    }
  }
  // agentHome は常に pi の HOME になるため、存在しなければここで作る
  // (Dockerfile の useradd --create-home + COPY --chown で作成済みならほぼ
  // no-op だが、PI_AGENT_HOME で既定と異なるパスを指定した場合に備える)。
  // 所有権の規則は「Runner (root) が作ったものだけ chown する」— 既存の
  // home には一切触れない。mkdir(recursive) は新規作成時だけ作成した
  // パスを返すため、それを使って新規作成時のみ chown/chmod する
  // (home 全体を毎回再帰的に stat/chown する必要はない。既存 home 配下に
  // 読み取り専用マウントがあっても衝突しない)
  const createdHome = await mkdir(agentHome, { recursive: true });
  if (
    createdHome !== undefined &&
    agentUid !== undefined &&
    agentGid !== undefined
  ) {
    await chown(agentHome, agentUid, agentGid);
    await chmod(agentHome, 0o700);
  }
  // pi は cwd を canonicalize してから trust probe / migration の existsSync を
  // 行う (dist/core/trust-manager.js の normalizeCwd)。macOS では /tmp が
  // /private/tmp への symlink のため、allow パス・cwd・HOME も realpath で
  // 正規化して渡さないと Permission Model の判定と食い違い pi が即死する
  // (Linux では通常 no-op)
  const workdirReal = await realpath(workdir);
  const agentHomeReal = await realpath(agentHome);
  const sharedDirReal =
    sharedDir !== undefined ? await realpath(sharedDir) : undefined;
  const sessionPath = join(workdirReal, SESSION_FILE);
  const resumed = await transcriptExists(sessionPath);

  return { workdirReal, agentHomeReal, sharedDirReal, sessionPath, resumed };
}

/** buildSpawnOptions が返す、PiProcess construction に必要な値一式 */
export interface SpawnPaths {
  extensionPaths: string[];
  skillPaths: string[];
  memoryEnabled: boolean;
  permission: PiPermissionOptions | undefined;
}

/** kick 中盤、extension/skill パス解決 (channel resource + builtin) と Node
 * Permission Model オプション組み立てをまとめる (session-runtime.md §5, §6)。
 * record への書き込みは行わない。 */
export async function buildSpawnOptions(args: {
  agentHomeReal: string;
  workdirReal: string;
  sharedDirReal: string | undefined;
  doc: ChannelDoc | null;
  builtinExtensionPaths: string[];
  memorySkillPath: string | undefined;
  piPermission:
    | {
        entrypoint: string;
        nodeModulesDir: string;
        extraWrite?: string[];
        extraRead?: string[];
        allowAddons?: boolean;
      }
    | undefined;
}): Promise<SpawnPaths> {
  const {
    agentHomeReal,
    workdirReal,
    sharedDirReal,
    doc,
    builtinExtensionPaths,
    memorySkillPath,
    piPermission,
  } = args;

  // 利用者が拡張イメージに焼き込んだ extension を skill と同じ規約で拾う場所
  // (session-runtime.md §5)。pi の --extension はディレクトリを直接受け付けない
  // ため、直下の .ts/.js を個別に列挙して渡す。ディレクトリが無ければ何も
  // 足さない (ベースイメージのみの利用者はこのディレクトリを持たない)
  const agentExtensionsDir = join(agentHomeReal, ".pi/agent/extensions");
  const agentExtensionFiles = await readdir(agentExtensionsDir)
    .then((names) =>
      names
        .filter((name) => name.endsWith(".ts") || name.endsWith(".js"))
        .map((name) => join(agentExtensionsDir, name)),
    )
    .catch(() => []);
  // チャンネル別の追加 skill / extension (config.md §2)。相対パスは ConfigSource が
  // 設定ファイル基準で絶対化済み。イメージに焼いたパスを指す想定なので、存在しなければ
  // 設定ミスとして fail-loud で落とす (黙って無効のまま動くと「skill が効かない」の
  // 調査が辛い)。realpath は workdir/HOME と同じ理由 (macOS /tmp symlink) の正規化
  const channelSkillPaths = await resolveChannelResourcePaths(
    doc?.skills,
    "skills",
  );
  const channelExtensionFiles = await resolveChannelResourcePaths(
    doc?.extensions,
    "extensions",
  );
  // memory 機能 (組み込み skill + MEMORY.md 注入) の有効判定。shared 有効かつ
  // doc.memory !== false のとき (config.md §2)
  const memoryEnabled =
    sharedDirReal !== undefined &&
    doc?.memory !== false &&
    memorySkillPath !== undefined;
  // shared skills (存在は上の mkdir で保証済み) と組み込み memory skill
  const sharedSkillPaths =
    sharedDirReal !== undefined
      ? [
          join(sharedDirReal, "skills"),
          ...(memoryEnabled && memorySkillPath !== undefined
            ? [memorySkillPath]
            : []),
        ]
      : [];
  const skillPaths = [...channelSkillPaths, ...sharedSkillPaths];
  const extensionPaths = [
    ...builtinExtensionPaths,
    ...agentExtensionFiles,
    ...channelExtensionFiles,
  ];

  // Node Permission Model (session-runtime.md §6, pi-tools-and-sandbox.md
  // 「リーズナブルな sandbox レイヤ案」) が opt-in で有効なら、pi 本体の
  // JS 実装ツール (read/write/edit/grep) の fs アクセスをこのセッションの
  // workdir/home に閉じ込める。home は pi 子プロセスに渡す HOME (常に agentHome)
  // と揃える — ズレると pi 起動時の ~/.pi probe (auth.json migration 等) が
  // ERR_ACCESS_DENIED になり pi が exit 1 で即死する
  const home = agentHomeReal;
  // extension (reply / permission-gate) は appDir 包括許可の廃止に伴い、
  // 各ファイルの所在ディレクトリを個別に read 許可する (write は与えない —
  // 読めるが書けない)。ディレクトリ単位なので重複していても Set で 1 回に畳む
  const extensionReadDirs = [...new Set(extensionPaths.map((p) => dirname(p)))];
  // shared staging は workdir/home の外にある唯一の agent 書き込み先。
  // ディレクトリ自体の read は ls (readdir) に要る
  const sharedPermissionWrite =
    sharedDirReal !== undefined ? [`${sharedDirReal}/*`] : [];
  const sharedPermissionRead =
    sharedDirReal !== undefined ? [sharedDirReal, `${sharedDirReal}/*`] : [];
  const permission =
    piPermission !== undefined
      ? buildPiPermissionOptions({
          entrypoint: piPermission.entrypoint,
          nodeModulesDir: piPermission.nodeModulesDir,
          workdir: workdirReal,
          home,
          extraWrite: [
            ...(piPermission.extraWrite ?? []),
            ...sharedPermissionWrite,
          ],
          extraRead: [
            ...extensionReadDirs.map((dir) => `${dir}/*`),
            // skill は pi がディレクトリごと再帰で読む (SKILL.md 探索 + 参照
            // ファイル)。readdir にディレクトリ自体の read も要るため両方許可する
            ...skillPaths.flatMap((dir) => [dir, `${dir}/*`]),
            ...sharedPermissionRead,
            ...(piPermission.extraRead ?? []),
          ],
          ...(piPermission.allowAddons !== undefined
            ? { allowAddons: piPermission.allowAddons }
            : {}),
        })
      : undefined;

  return { extensionPaths, skillPaths, memoryEnabled, permission };
}

/** kick 後半、memory index (MEMORY.md) の読み込み (docs/design/memory.md §2)。
 * memory 無効 or ファイル未作成なら undefined を返す。ENOENT 以外は fail-loud。 */
export async function loadMemoryIndex(
  memoryEnabled: boolean,
  sharedDirReal: string | undefined,
): Promise<string | undefined> {
  if (!memoryEnabled || sharedDirReal === undefined) return undefined;
  return await readFile(
    join(sharedDirReal, "memory", "MEMORY.md"),
    "utf-8",
  ).catch((err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  });
}
