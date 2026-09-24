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
  /** 解決済みの pi 本体 entrypoint JS。`node <entrypoint>` で起動する */
  piEntrypoint?: string;
  /** 解決済みの srt (@anthropic-ai/sandbox-runtime) CLI entrypoint JS
   * (runtime.md §5.5)。agent.sandbox を有効にした Channel の Session は pi の起動
   * コマンドをこれで包む。未解決 (undefined) のまま sandbox 有効の Session を起動
   * しようとすると fail-closed で起動を拒む */
  srtEntrypoint?: string;
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
   * HOME にする — コンテナ側で設定・skill を固定パスに配置できるようにするため */
  agentHome: string;
  /** workdir のルート。`<workdirRoot>/<channelId>/<threadTs|channel>/` が
   * 1 Session の workdir になる (state.md §6) */
  workdirRoot: string;
}
