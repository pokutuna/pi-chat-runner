// Agent の起動準備 (docs/design/runtime.md §2 起動準備の順序、§4 Extension と Skill、
// §5.1 UID 分離、§5.2 Node Permission Model)。
//
// 「入力 → PiProcess を作るための準備」だけを担い、PiProcess の生成・イベント
// ハンドラ登録は Session 側に残る。Control State は読むだけで書かない
// (state.md §1) — /new マーカーのクリアは呼び出し側 (Dispatcher) の責務。

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
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

import type { ResolvedChannel } from "../config/config-source.js";
import { isIdleExpired, type SessionPolicy } from "../dispatch/policy.js";
import type { Logger } from "../logger.js";
import type { SharedStore, WorkdirStore } from "../state/agent/interfaces.js";
import type { PiPermissionConfig } from "./config.js";
import {
  buildPiPermissionOptions,
  type PiPermissionOptions,
} from "./pi-args.js";
import { buildSandboxSettings } from "./sandbox.js";
import { rotatedSessionFile, SESSION_FILE } from "./session-file.js";

/** Session 専用の一時ディレクトリ (pi に TMPDIR として渡す。runtime.md §5.5)。
 * workdir `<root>/<channelId>/<leaf>` に対し `<root>/<channelId>/tmp/<leaf>` —
 * workdir の外 (archive に巻き込まない) で、Session ごとに分かれる (同 uid の他
 * Session の書き込み先を /tmp 共有で開けない)。pi の bash 出力スピル
 * (tmpdir()/pi-bash-*.log) がここに落ちる。srt の allowWrite はグロブをディスク上に
 * 展開するため、まだ無い `/tmp/pi-bash-*` は許可できない — 実在するディレクトリを
 * 渡す必要があり、それがこのディレクトリ */
export function sessionTmpDir(workdir: string): string {
  return join(dirname(workdir), "tmp", basename(workdir));
}

/** 組み込み extension のファイル名 (リポジトリ/パッケージ直下の extensions/)。
 * reply は唯一の返信経路、permission-gate は事故防止層 (runtime.md §4.1) で、どの
 * プラットフォームで使う場合も常時注入する — プラットフォーム非依存なので呼び出し側に
 * 渡させず Dispatcher 自身が解決する。export は標準機能として同様に扱う。
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
 * 絶対パスを解決する (docs/design/runtime.md §4.4)。shared 有効時のみ使われる。
 * ルート直下の skills/ (利用者が $AGENT_HOME に焼き込む全チャンネル共通 skill の口。
 * Dockerfile 参照) とは別物 — そちらに置くと pi の HOME 自動発見で全チャンネルに
 * 効いてしまい、AgentConfig.memory の opt-out が効かない。配置と解決規則は
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

/** チャンネル別の追加 skill / extension パス (AgentConfig.skills / .extensions,
 * config.md §3.5) を検証し realpath で正規化する。イメージに焼き込んだパスを指す
 * 想定なので、実在しないパスは設定ミスとして fail-loud で throw する。
 * extension は pi の --extension がディレクトリを受けないため、拡張子から
 * JS モジュールファイル (.ts/.js/.mjs/.cjs) であることだけ確認する。 */
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
        !path.endsWith(".js") &&
        !path.endsWith(".mjs") &&
        !path.endsWith(".cjs")
      ) {
        throw new Error(
          `channel extensions entry must be a .ts/.js/.mjs/.cjs file: ${path}`,
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
 * 文脈継続するかどうかの判定。restore 後に評価すれば archive からの復元も拾える)。 */
export async function transcriptExists(sessionPath: string): Promise<boolean> {
  try {
    await stat(sessionPath);
    return true;
  } catch {
    return false;
  }
}

/** channel モードの idle リセット (runtime.md §2.1): workdir 直下の
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

/** Session 起動前半、設定バリデーション warn 群 (session-model.md §2)。session.mode /
 * reply.mode の非推奨な組み合わせ、channel モード専用オプションの thread モードでの
 * 指定、affinity.scope=channel の冗長設定を検知して warn するのみ (throw しない)。
 * record への書き込みは行わない */
export function warnPolicyMismatches(
  logger: Logger,
  sessionKey: string,
  channelId: string,
  policy: SessionPolicy,
  channel: ResolvedChannel | null,
): void {
  // session.mode=thread かつ reply.mode=flat は文脈が切れるのに返事だけ散らばる
  // 非推奨な組み合わせ。動作は許可するので warn のみ (session-model.md §2)
  if (policy.sessionMode === "thread" && policy.replyMode === "flat") {
    logger.warn(
      { sessionKey, channelId },
      "session.mode=thread with reply.mode=flat is discouraged (session-model.md §3)",
    );
  }
  // idleResetMinutes / maxTranscriptKb は channel モード専用 (runtime.md §2.1)。
  // thread モードで設定されていても効果がないため warn して無視する
  if (
    policy.sessionMode === "thread" &&
    (channel?.session?.idleResetMinutes !== undefined ||
      channel?.session?.maxTranscriptKb !== undefined)
  ) {
    logger.warn(
      { sessionKey, channelId },
      "session.idleResetMinutes / maxTranscriptKb are only effective with session.mode=channel; ignored",
    );
  }
  // affinity は mode=channel では自明に成立 (同一 sessionKey) するため意味を持たない。
  // windowSec も scope=channel 以外では読まれない (message-dispatch.md §3.2)
  const affinity = channel?.session?.affinity;
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

/** prepareWorkdir が Control State から見るもの (state.md §3.2 の Session 実行状況の
 * うち、起動準備が読む 2 フィールドだけ)。Runtime は Store を持たず、呼び出し側が
 * 読んだ値を受け取る */
export interface PreviousSession {
  lastActiveAt: Date;
  /** 明示的な新規 Session 要求 (/new) の時刻 */
  rotateRequestedAt?: Date;
}

/** prepareWorkdir が返す、Session 起動の後続処理 (extension/skill 解決・PiProcess 生成) に
 * 必要な値。record への書き込みはここでは行わず、呼び出し側 (Dispatcher) が
 * resumed の記録・ログ出力等に使う */
export interface PreparedWorkdir {
  /** realpath 正規化済みの workdir 絶対パス */
  workdirReal: string;
  /** realpath 正規化済みの agentHome 絶対パス */
  agentHomeReal: string;
  /** realpath 正規化済みの Session 専用 TMPDIR (sessionTmpDir)。起動ごとに空で作り直す */
  tmpDirReal: string;
  /** shared staging の realpath 正規化済み絶対パス (shared 無効なら undefined) */
  sharedDirReal: string | undefined;
  /** workdirReal 直下の session.jsonl 絶対パス */
  sessionPath: string;
  /** Session 起動時点で session.jsonl が既に存在したか (resume 判定用ログに使う) */
  resumed: boolean;
  /** /new マーカー (rotateRequestedAt) を消費して transcript を世代交代したか。
   * マーカーのクリア (Control State への書き込み) は Dispatcher 側が行う
   * (state.md §1「Runtime は Control State を書かない」) */
  rotateConsumed: boolean;
  /** この起動で transcript を世代交代したか (manual / idle / size のいずれか。
   * session-model.md §6)。Transcript が新しく始まったことを示すので、呼び出し側は
   * SessionRecord の startedAt をこの起動時刻に置き直す */
  transcriptRotated: boolean;
}

/** Session 起動前半、workdir/shared の mkdir + restore、transcript 世代交代 (manual →
 * idle → size)、UID 分離 (chown/chmod)、agentHome 作成、realpath 正規化をまとめて
 * 行う (runtime.md §2 準備順序、§5.1 UID 分離)。
 *
 * 副作用の実行順序はそのまま維持する: mkdir → restore (workdir → shared) →
 * transcript 世代交代 (manual → idle → size) → workdir/shared の chown → agentHome
 * 作成/chown → realpath 正規化。Control State は読むだけで書かない (state.md §1) —
 * /new マーカーのクリアは rotateConsumed を通じて Dispatcher 側に委ねる。 */
export async function prepareWorkdir(args: {
  sessionKey: string;
  channelId: string;
  workdir: string;
  policy: SessionPolicy;
  channel: ResolvedChannel | null;
  /** 前回の Session 実行状況 (Control State から呼び出し側が読んで渡す)。
   * rotateRequestedAt (/new マーカー) と lastActiveAt (idle 判定) だけを見る。
   * Runtime は Control State を読み書きしない (state.md §1) */
  previousSession: PreviousSession | null;
  workdirStore: WorkdirStore;
  sharedStore: SharedStore | undefined;
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
    channel,
    previousSession,
    workdirStore,
    sharedStore,
    sharedStagingDir,
    agentUid,
    agentGid,
    agentHome,
    logger,
  } = args;

  // 同 sessionKey は常に同じ workdir/session.jsonl を使う。再 trigger 時は
  // 同じパスで再 spawn され、pi が JSONL を読んで文脈を継続する (再開の専用フローなし)
  await mkdir(workdir, { recursive: true });
  await workdirStore.restore(sessionKey, workdir);
  // チャンネル共有ディレクトリ (docs/design/state.md §6)。sessionKey ではなく
  // channelId 単位で復元し、スレッド (セッション) を跨いで持ち越す。skills/ は
  // 空でも常に作る — pi の --skill は空ディレクトリを黙って無視するので配線は
  // 無条件でよく、agent は mkdir なしで skill を置ける
  const sharedDir =
    sharedStore !== undefined ? sharedStagingDir(channelId) : undefined;
  if (sharedStore !== undefined && sharedDir !== undefined) {
    await mkdir(join(sharedDir, "skills"), { recursive: true });
    await sharedStore.restore(channelId, sharedDir);
  }
  // 世代交代 (runtime.md §2.1): 明示 (/new マーカー) → idle 超過 →
  // transcript サイズ超過の優先順位で、いずれか 1 回だけ transcript を
  // 世代交代する。previous は idle 判定にも使う。rotate は chown より前
  // (rotate されたファイルの所有権も chown で揃うため)
  const previous = previousSession;
  let rotated = false;
  // 明示 (/new マーカー) は session.mode に依存しない (thread モードでも効く) —
  // idle/size が channel モード限定なのとは異なる、明示的なユーザー意図のため
  // (runtime.md §2.1)
  if (previous?.rotateRequestedAt !== undefined) {
    const now = Date.now();
    await rotateTranscript(workdir, now);
    rotated = true;
    logger.info({ sessionKey }, "transcript rotated (explicit)");
    // マーカーのクリアはここでは書かない。Runtime の準備は Control State を
    // 書かない (state.md §1) ので、rotateConsumed を返して Dispatcher に消費させる
  }
  const rotateConsumed = previous?.rotateRequestedAt !== undefined;
  // idleResetMinutes / maxTranscriptKb は channel モード専用 (runtime.md §2.1)
  if (policy.sessionMode === "channel") {
    const idleResetMinutes = channel?.session?.idleResetMinutes;
    if (!rotated && idleResetMinutes !== undefined && previous !== null) {
      const now = Date.now();
      if (isIdleExpired(previous.lastActiveAt, idleResetMinutes, now)) {
        await rotateTranscript(workdir, now);
        rotated = true;
        logger.info(
          {
            sessionKey,
            idleResetMinutes,
            idleMs: now - previous.lastActiveAt.getTime(),
          },
          "transcript rotated (idle)",
        );
      }
    }
    const maxTranscriptKb = channel?.session?.maxTranscriptKb;
    if (!rotated && maxTranscriptKb !== undefined) {
      const info = await stat(join(workdir, SESSION_FILE)).catch((err) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      });
      if (info !== null && info.size > maxTranscriptKb * 1024) {
        const now = Date.now();
        await rotateTranscript(workdir, now);
        rotated = true;
        logger.info(
          { sessionKey, maxTranscriptKb, sizeBytes: info.size },
          "transcript rotated (size)",
        );
      }
    }
  }
  // UID 分離 (runtime.md §5.1) が有効なら、workdir を agent 所有 0700 に
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
  // Session 専用の TMPDIR (runtime.md §5.5)。前回起動のスピルファイルを持ち越さない
  // よう起動ごとに空にして作り直す。workdir と同じく UID 分離時は agent 所有 0700
  const tmpDir = sessionTmpDir(workdir);
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });
  if (agentUid !== undefined && agentGid !== undefined) {
    await chown(tmpDir, agentUid, agentGid);
    await chmod(tmpDir, 0o700);
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
  const tmpDirReal = await realpath(tmpDir);
  const sharedDirReal =
    sharedDir !== undefined ? await realpath(sharedDir) : undefined;
  const sessionPath = join(workdirReal, SESSION_FILE);
  const resumed = await transcriptExists(sessionPath);

  return {
    workdirReal,
    agentHomeReal,
    tmpDirReal,
    sharedDirReal,
    sessionPath,
    resumed,
    rotateConsumed,
    transcriptRotated: rotated,
  };
}

/** buildSpawnOptions が返す、PiProcess construction に必要な値一式 */
export interface SpawnPaths {
  extensionPaths: string[];
  skillPaths: string[];
  memoryEnabled: boolean;
  permission: PiPermissionOptions | undefined;
  /** srt に渡す合成済み settings (runtime.md §5.5)。Channel の agent.sandbox が
   * 無効 (省略 / false) なら undefined。ファイルへの書き出しと srt CLI での包み方は
   * Session 側 */
  sandbox: SandboxRuntimeConfig | undefined;
}

/** Session 起動中盤、extension/skill パス解決 (channel resource + builtin) と Node
 * Permission Model オプション組み立て、srt settings の合成をまとめる
 * (runtime.md §4, §5.2, §5.5)。record への書き込みは行わない。 */
export async function buildSpawnOptions(args: {
  agentHomeReal: string;
  workdirReal: string;
  tmpDirReal: string;
  sharedDirReal: string | undefined;
  channel: ResolvedChannel | null;
  builtinExtensionPaths: string[];
  memorySkillPath: string | undefined;
  piPermission: PiPermissionConfig | undefined;
}): Promise<SpawnPaths> {
  const {
    agentHomeReal,
    workdirReal,
    tmpDirReal,
    sharedDirReal,
    channel,
    builtinExtensionPaths,
    memorySkillPath,
    piPermission,
  } = args;

  // 利用者が拡張イメージに焼き込んだ extension を skill と同じ規約で拾う場所
  // (runtime.md §4.2)。pi の --extension はディレクトリを直接受け付けない
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
  // チャンネル別の追加 skill / extension (runtime.md §4.3)。相対パスは ConfigSource が
  // 設定ファイル基準で絶対化済み。イメージに焼いたパスを指す想定なので、存在しなければ
  // 設定ミスとして fail-loud で落とす (黙って無効のまま動くと「skill が効かない」の
  // 調査が辛い)。realpath は workdir/HOME と同じ理由 (macOS /tmp symlink) の正規化
  const channelSkillPaths = await resolveChannelResourcePaths(
    channel?.agent.skills,
    "skills",
  );
  const channelExtensionFiles = await resolveChannelResourcePaths(
    channel?.agent.extensions,
    "extensions",
  );
  // memory 機能 (組み込み skill + MEMORY.md 注入) の有効判定。shared 有効かつ
  // channel.memory !== false のとき (runtime.md §4.4)
  const memoryEnabled =
    sharedDirReal !== undefined &&
    channel?.agent.memory !== false &&
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

  // Node Permission Model (runtime.md §5.2, pi-tools-and-sandbox.md
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

  // srt settings の合成 (runtime.md §5.5)。Runner が足す allowWrite は Permission
  // Model の allowFsWrite と同じ集合 (workdir / TMPDIR / home / shared staging) を
  // ディレクトリで渡す。利用者の allowRead / allowWrite は Permission Model 側にも写す
  const rules = channel?.agent.sandbox;
  const sandboxSettings =
    rules !== undefined && rules !== false
      ? buildSandboxSettings({
          rules,
          allowWrite: [
            workdirReal,
            tmpDirReal,
            home,
            ...(sharedDirReal !== undefined ? [sharedDirReal] : []),
          ],
          home,
          cwd: workdirReal,
        })
      : undefined;

  const permission =
    piPermission !== undefined
      ? buildPiPermissionOptions({
          entrypoint: piPermission.entrypoint,
          nodeModulesDir: piPermission.nodeModulesDir,
          workdir: workdirReal,
          home,
          tmpDir: tmpDirReal,
          extraWrite: [
            ...(piPermission.extraWrite ?? []),
            ...sharedPermissionWrite,
            ...(sandboxSettings?.permission.allowWrite ?? []),
          ],
          extraRead: [
            ...extensionReadDirs.map((dir) => `${dir}/*`),
            // skill は pi がディレクトリごと再帰で読む (SKILL.md 探索 + 参照
            // ファイル)。readdir にディレクトリ自体の read も要るため両方許可する
            ...skillPaths.flatMap((dir) => [dir, `${dir}/*`]),
            ...sharedPermissionRead,
            ...(piPermission.extraRead ?? []),
            ...(sandboxSettings?.permission.allowRead ?? []),
          ],
          ...(piPermission.allowAddons !== undefined
            ? { allowAddons: piPermission.allowAddons }
            : {}),
        })
      : undefined;

  return {
    extensionPaths,
    skillPaths,
    memoryEnabled,
    permission,
    sandbox: sandboxSettings?.settings,
  };
}

/** Session 起動後半、memory index (MEMORY.md) の読み込み (docs/design/runtime.md §6)。
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
