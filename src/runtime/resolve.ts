// RuntimeConfig の組み立て (docs/design/runtime.md §5.3, §5.5)。
//
// System Config (config.md §1.1 の system.runtime) と、インストール済み pi 本体の
// 実パス・プロセス環境から Runtime レイヤの静的設定を導く。composition root
// (server.ts) はこのモジュールの createRuntimeConfig を呼ぶだけで、pi / srt の
// パス解決を自分では持たない。

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ResolvedSystemConfig } from "../config/system-config.js";
import type { RuntimeConfig } from "./config.js";

/** workdir のルートの既定値 (state.md §6)。 */
const DEFAULT_WORKDIR_ROOT = "/tmp/pi-chat-runner/sessions";

/** GCP 関連 env のうち process.env に存在するものだけを集める。pi の google-vertex
 * プロバイダが GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_LOCATION / GOOGLE_APPLICATION_CREDENTIALS
 * を env から読む (runtime.md §5.3 の allowlist に相当)。 */
export function collectGcpEnv(
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const keys = [
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_APPLICATION_CREDENTIALS",
    // gcp-metadata の環境検出 (DMI ファイル read 等) は sandbox 下で当てにならない。
    // Cloud Run では assume-present を設定して検出をスキップし metadata server へ
    // 直行させる (gcp-metadata 8.x の METADATA_SERVER_DETECTION)
    "METADATA_SERVER_DETECTION",
  ];
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = baseEnv[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** pi 本体パッケージを import.meta.resolve で解決し、entrypoint (bin.pi の絶対パス)
 * を導く。決め打ちパスの env 変数には頼らず、実際にインストールされた場所から求める。
 *
 * require.resolve(`${pkg}/package.json`) ではなく import.meta.resolve(pkg) (パッケージ
 * ルート "." の解決) を使う: pi 本体は ESM 専用で package.json の exports に "."
 * (→ dist/index.js) しか定義しておらず "./package.json" は公開していないため、
 * require.resolve 経由のサブパス解決は ERR_PACKAGE_PATH_NOT_EXPORTED で必ず失敗する。
 * import.meta.resolve は ESM の解決アルゴリズムを使うため "." の import 条件を
 * 正しく解決できる。dist/index.js から dist/cli.js (bin.pi) を相対で導く。 */
const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

export function resolvePiEntrypoint(): string {
  const indexPath = fileURLToPath(import.meta.resolve(PI_PACKAGE_NAME));
  // indexPath = <...>/@earendil-works/pi-coding-agent/dist/index.js
  return join(dirname(dirname(indexPath)), "dist/cli.js");
}

/** srt が対応する OS (runtime.md §5.5)。 */
const SRT_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set([
  "linux",
  "darwin",
]);

/** srt (@anthropic-ai/sandbox-runtime) の CLI エントリポイント (dist/cli.js) を
 * import.meta.resolve で解決する (runtime.md §5.5)。Runner は srt をライブラリとして
 * は使わず、pi の起動コマンドを `node <cli.js> --settings <file> -- <pi>` で包む —
 * srt のネットワーク許可リストはプロセス単位で 1 つしか持てないため、Channel ごとに
 * 異なる許可リストを与えるには Session ごとに srt プロセスを立てる必要がある。
 * パッケージが解決できない (依存が入っていない) 場合は undefined を返し、sandbox を
 * 有効にした Channel の起動時に fail-closed で落とす判断は Session 側に委ねる。 */
const SRT_PACKAGE_NAME = "@anthropic-ai/sandbox-runtime";

export function resolveSrtPath(): string | undefined {
  let indexUrl: string;
  try {
    indexUrl = import.meta.resolve(SRT_PACKAGE_NAME);
  } catch {
    return undefined;
  }
  // indexPath = <...>/@anthropic-ai/sandbox-runtime/dist/index.js
  return join(dirname(fileURLToPath(indexUrl)), "cli.js");
}

export interface CreateRuntimeConfigOptions {
  /** workdir のルート。既定 /tmp/pi-chat-runner/sessions */
  workdirRoot?: string;
  /** env allowlist の読み出し元。既定 process.env */
  baseEnv?: Record<string, string | undefined>;
}

/** System Config から Runtime レイヤの静的設定 (RuntimeConfig) を組み立てる。
 *
 * pi のパス解決 (resolvePiEntrypoint) → srt CLI のパス解決 (resolveSrtPath) → 子プロセスへ渡す env のコード既定 (collectGcpEnv + PI_EXPORT_ENTRYPOINT) の順。
 * PI_EXPORT_ENTRYPOINT は export extension (孫プロセスとして `pi --export` を
 * 起動する) がホストの pi エントリポイントを知るために必要。
 * Channel ごとの Agent Config の env はここでは重ねない — 足し算モデル
 * (config.md §1.3) の「コード既定」部分だけを持ち、Channel 分は起動時に上へ重ねる。 */
export function createRuntimeConfig(
  system: ResolvedSystemConfig,
  options: CreateRuntimeConfigOptions = {},
): RuntimeConfig {
  const { runtime } = system;
  const baseEnv = options.baseEnv ?? process.env;
  const piEntrypoint = resolvePiEntrypoint();
  const extraEnv = {
    ...collectGcpEnv(baseEnv),
    PI_EXPORT_ENTRYPOINT: piEntrypoint,
  };
  // srt が動くのは Linux (bwrap + netns。本番) と macOS (sandbox-exec。開発用) だけ。
  // 他 OS では解決できても使えないので伏せ、Session 側の fail-closed (srtEntrypoint
  // 未定義 + sandbox 有効 → 起動失敗) に一本化する。解決できなくても boot は止めない
  // (全 Channel が sandbox: false の構成を許すため。runtime.md §5.5)
  const srtEntrypoint = SRT_PLATFORMS.has(process.platform)
    ? resolveSrtPath()
    : undefined;
  return {
    piEntrypoint,
    ...(srtEntrypoint !== undefined ? { srtEntrypoint } : {}),
    ...(Object.keys(extraEnv).length > 0 ? { extraEnv } : {}),
    // system.runtime.uid/gid (env PI_AGENT_UID/GID) 未設定なら UID 分離なし
    ...(runtime.uid !== undefined ? { agentUid: runtime.uid } : {}),
    ...(runtime.gid !== undefined ? { agentGid: runtime.gid } : {}),
    // home は resolveSystemConfig が既定 "/home/agent" を埋めて返すので常に渡る
    agentHome: runtime.home,
    workdirRoot: options.workdirRoot ?? DEFAULT_WORKDIR_ROOT,
  };
}
