// Runtime レイヤの静的設定 (docs/design/runtime.md §1)。
//
// pi 子プロセスの起動に必要で、Session ごとには変わらない値をひとまとめにする。
// 組み立ては composition root の担当 (runtime/resolve.ts の createRuntimeConfig を
// server.ts が呼ぶ)。Dispatcher / Session はこの型を丸ごと受け取って持ち回るだけで、
// 個々のフィールドを options に展開し直さない。

/** Runtime レイヤの静的設定一式 (runtime.md §1、§5)。 */
export interface RuntimeConfig {
  /** 明示的に差し替える pi バイナリ。テストや埋め込み用途向け。
   * 指定時は piEntrypoint より優先する */
  piBinary?: string;
  /** 解決済みの pi 本体 entrypoint JS。permission の有無に関わらず使用する */
  piEntrypoint?: string;
  /** allowlist (PATH/HOME) に追加で pi 子プロセスへ渡す env (runtime.md §5.3)。
   * コード既定 (gcpEnv / PI_EXPORT_ENTRYPOINT) 相当で、Channel ごとの Agent Config
   * の env はこの上へ起動時に重ねる (config.md §1.3) */
  extraEnv?: Record<string, string>;
  /** pi 子プロセスの実行 uid/gid (runtime.md §5.1: UID 分離)。両方指定時のみ有効。
   * 有効な場合のみ workdir の chown/chmod を行う */
  agentUid?: number;
  agentGid?: number;
  /** pi 子プロセスへ常に HOME として渡すディレクトリ (既定 "/home/agent" は
   * RuntimeConfig を組み立てる側で埋める)。UID 分離の有無に関わらず常にこれを
   * HOME にする — コンテナ側で設定・skill を固定パスに配置できるようにするため、
   * また Node Permission Model の allow パス (`${home}/*`) と実際の HOME を
   * ズレなく一致させるため (runtime.md §5.2) */
  agentHome: string;
  /** Node Permission Model 経由での起動設定 (opt-in。未指定なら pi をそのまま
   * spawn する。runtime.md §5.2) */
  piPermission?: PiPermissionConfig;
  /** workdir のルート。`<workdirRoot>/<channelId>/<threadTs|channel>/` が
   * 1 Session の workdir になる (state.md §6) */
  workdirRoot: string;
}

/** Node Permission Model 有効化の静的パラメタ (runtime.md §5.2)。
 * workdir / home はセッションごとに決まるため kick 時に buildPiPermissionOptions
 * へ都度渡す — ここに載るのはイメージ内で固定のパスだけ */
export interface PiPermissionConfig {
  /** pi 本体のエントリポイント JS の絶対パス (import.meta.resolve で自動検出する。
   * server.ts 参照) */
  entrypoint: string;
  /** pi 本体・依存が入る npm パッケージの node_modules ルート (import.meta.resolve で
   * 自動検出する。server.ts 参照) */
  nodeModulesDir: string;
  /** 追加で write を許可したいパス (例 "/tmp/*")。既定なし */
  extraWrite?: string[];
  /** 追加で read を許可したいパス (例 GOOGLE_APPLICATION_CREDENTIALS のファイル
   * パス)。HOME を agentHome に固定するとローカルのユーザー ADC は HOME 経由で
   * 見えなくなるため、明示指定されたファイルだけ個別に許可する用途。既定なし。
   * extension (reply / permission-gate) の読み込みに必要な read 許可は kick 時に
   * extensionPaths の dirname から自動導出してここへ足すため、呼び出し側が
   * 明示する必要はない (appDir 包括許可の廃止に伴う対応) */
  extraRead?: string[];
  /** native addon (.node) を含む extension を使う場合の `--allow-addons` 付与。
   * agent.runtime.allowAddons 由来 (config.md §1.3)。既定 false */
  allowAddons?: boolean;
}
