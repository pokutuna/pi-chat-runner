// Agent State の archive — docs/design/state.md §5, §7
//
// Session 単位の archive (Workdir) と Channel 単位の archive (Shared) の 2 つ。どちらも
// ディレクトリのコピーで往復するだけなので、archive の実体が Cloud Storage のマウント先
// でもローカルのディレクトリでも同じに動く。
//
// restore は「復元があったか」を boolean で返す (state.md §5.1 の
// 「restore は session.jsonl の有無で gate する」判定そのもの)。

/** workdir の退避と復元。実体はディレクトリコピー (state.md §5)。 */
export interface WorkdirStore {
  /** archive → workdir へ復元。archive に無ければ何もしない。復元があったか boolean
   * で返す */
  restore(sessionKey: string, workdir: string): Promise<boolean>;
  /** workdir → archive へ退避 */
  flush(sessionKey: string, workdir: string): Promise<void>;
}

/** チャンネル単位の共有ディレクトリの退避と復元 (docs/design/state.md §5)。
 * WorkdirStore と違いキーは channelId のみで、transcript を持たないため
 * session.jsonl の有無によるゲートもコピー順序の担保も行わない。 */
export interface SharedStore {
  /** archive → staging へ復元。archive に無ければ何もしない */
  restore(channelId: string, dest: string): Promise<void>;
  /** staging → archive へ退避 */
  flush(channelId: string, src: string): Promise<void>;
}
