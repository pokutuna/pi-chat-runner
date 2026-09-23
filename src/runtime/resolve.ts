// RuntimeConfig の組み立て (docs/design/runtime.md §5.2, §5.3)。
//
// System Config (config.md §1.1 の system.runtime) と、インストール済み pi 本体の
// 実パス・プロセス環境から Runtime レイヤの静的設定を導く。composition root
// (server.ts) はこのモジュールの createRuntimeConfig を呼ぶだけで、pi のパス解決や
// Permission Model の allow パス組み立てを自分では持たない。

import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ResolvedRuntimeConfig,
  ResolvedSystemConfig,
} from "../config/system-config.js";
import type { PiPermissionConfig, RuntimeConfig } from "./config.js";

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

/** pi 本体パッケージを import.meta.resolve で解決し、Node Permission Model 用の
 * entrypoint (bin.pi の絶対パス) と nodeModulesDir (pi の全依存を含む node_modules
 * ルート) を自動検出する。決め打ちパスの env 変数には頼らず、実際にインストール
 * された場所から常に正しい値を導く。
 *
 * require.resolve(`${pkg}/package.json`) ではなく import.meta.resolve(pkg) (パッケージ
 * ルート "." の解決) を使う: pi 本体は ESM 専用で package.json の exports に "."
 * (→ dist/index.js) しか定義しておらず "./package.json" は公開していないため、
 * require.resolve 経由のサブパス解決は ERR_PACKAGE_PATH_NOT_EXPORTED で必ず失敗する
 * (exports map が定義された ESM パッケージは CJS の require.resolve では解決不能)。
 * import.meta.resolve は ESM の解決アルゴリズムを使うため "." の import 条件を
 * 正しく解決できる。dist/index.js から dist/cli.js (bin.pi) を相対で導く。
 *
 * nodeModulesDir は allow-fs-read に `${nodeModulesDir}/*` として渡り、pi が起動時に
 * 読む全ファイル (自身のコード + 実行時依存) をこの 1 パスでカバーする必要がある。
 * ここで求めるのは pi の依存を実際に張っている **平坦な node_modules ルート**
 * (= install 先の最外殻の node_modules) であって、pi パッケージの直上ディレクトリ
 * ではない。両者は npm の平坦構成では一致するが pnpm では食い違う: import.meta.resolve
 * は symlink を実体化するため indexPath が
 * `<root>/.pnpm/@earendil-works+pi-coding-agent@x/node_modules/@earendil-works/
 * pi-coding-agent/dist/index.js` を指し、pi の直上 node_modules は pi 専用の仮想
 * ストア (兄弟の cross-spawn 等を含まない) になる。そこを許可しても pi が spawn 時に
 * 読む cross-spawn が ERR_ACCESS_DENIED で pi が即死する。pnpm は全依存を `<root>/.pnpm`
 * 配下に置き `<root>` 直下に top-level symlink を張るので、パス上で最も外側に現れる
 * `node_modules` セグメントを採れば npm(平坦)/pnpm どちらでも「全依存を含むルート」に
 * 一致する (個別パスを列挙し続けないための正規化)。 */
const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

export function resolvePiPaths(): {
  entrypoint: string;
  nodeModulesDir: string;
} {
  const indexUrl = import.meta.resolve(PI_PACKAGE_NAME);
  const indexPath = fileURLToPath(indexUrl);
  // indexPath = <...>/@earendil-works/pi-coding-agent/dist/index.js
  const packageDir = dirname(dirname(indexPath));
  const entrypoint = join(packageDir, "dist/cli.js");
  return { entrypoint, nodeModulesDir: outermostNodeModules(indexPath) };
}

/** path 上で最も外側 (ルート寄り) に現れる `node_modules` セグメントまでのパスを返す。
 * pnpm の仮想ストア (`<root>/.pnpm/<pkg>/node_modules/...`) では複数の node_modules が
 * ネストするが、全依存を張るのは最外殻の `<root>` なのでそれを選ぶ。`node_modules` が
 * 無ければ入力の dirname を返す (想定外の配置でのフォールバック)。 */
export function outermostNodeModules(path: string): string {
  const marker = `${sep}node_modules${sep}`;
  const idx = path.indexOf(marker);
  if (idx === -1) return dirname(path);
  return path.slice(0, idx + marker.length - 1);
}

/** system.runtime.permissionMode (既定 true, system-config.ts) で Node
 * Permission Model 起動を切り替える (runtime.md §5.2)。コード既定は ON — 何も
 * 書かなければ隔離が効く。false のときだけ無効化する (ローカル開発・テストの
 * fake pi (test/fixtures/fake-pi.mjs) はこの機構を使わなくても動く)。
 * entrypoint/nodeModulesDir は resolvePiPaths の自動検出値を使う。 */
export function buildPiPermissionConfig(
  runtime: ResolvedRuntimeConfig,
  piPaths: { entrypoint: string; nodeModulesDir: string },
  baseEnv: Record<string, string | undefined> = process.env,
): PiPermissionConfig | undefined {
  if (!runtime.permissionMode) return undefined;
  // HOME を agentHome に固定するとローカルのユーザー ADC ($HOME/.config/gcloud) は
  // HOME 経由で見えなくなるため、GOOGLE_APPLICATION_CREDENTIALS で明示された
  // ファイルだけ read を許可する
  const credentialsPath = baseEnv.GOOGLE_APPLICATION_CREDENTIALS;
  return {
    ...piPaths,
    ...(credentialsPath !== undefined ? { extraRead: [credentialsPath] } : {}),
    ...(runtime.allowAddons ? { allowAddons: true } : {}),
  };
}

export interface CreateRuntimeConfigOptions {
  /** workdir のルート。既定 /tmp/pi-chat-runner/sessions */
  workdirRoot?: string;
  /** env allowlist の読み出し元。既定 process.env */
  baseEnv?: Record<string, string | undefined>;
}

/** System Config から Runtime レイヤの静的設定 (RuntimeConfig) を組み立てる。
 *
 * pi のパス解決 (resolvePiPaths) → Permission Model 設定 (buildPiPermissionConfig)
 * → 子プロセスへ渡す env のコード既定 (collectGcpEnv + PI_EXPORT_ENTRYPOINT) の順。
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
  const piPaths = resolvePiPaths();
  const extraEnv = {
    ...collectGcpEnv(baseEnv),
    PI_EXPORT_ENTRYPOINT: piPaths.entrypoint,
  };
  const piPermission = buildPiPermissionConfig(runtime, piPaths, baseEnv);
  return {
    piEntrypoint: piPaths.entrypoint,
    ...(Object.keys(extraEnv).length > 0 ? { extraEnv } : {}),
    // system.runtime.uid/gid (env PI_AGENT_UID/GID) 未設定なら UID 分離なし
    ...(runtime.uid !== undefined ? { agentUid: runtime.uid } : {}),
    ...(runtime.gid !== undefined ? { agentGid: runtime.gid } : {}),
    // home は resolveSystemConfig が既定 "/home/agent" を埋めて返すので常に渡る
    agentHome: runtime.home,
    // permissionMode: false (env PI_PERMISSION_MODE=0 または YAML) なら
    // Node Permission Model なし。コード既定は ON
    ...(piPermission !== undefined ? { piPermission } : {}),
    workdirRoot: options.workdirRoot ?? DEFAULT_WORKDIR_ROOT,
  };
}
