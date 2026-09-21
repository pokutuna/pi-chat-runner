// Agent State の棚 — docs/design/state.md §5, §7
//
// Session 単位の棚 (Workdir) と Channel 単位の棚 (Shared) の 2 つ。どちらも
// ディレクトリのコピーで往復するだけなので、棚の実体が Cloud Storage のマウント先でも
// ローカルのディレクトリでも同じに動く。
//
// restore は「復元があったか」を boolean で返す (state.md §5.1 の
// 「restore は session.jsonl の有無で gate する」判定そのもの)。

/** workdir の退避と復元。実体はディレクトリコピー (state.md §5)。 */
export interface WorkdirStore {
  /** 保存棚 → workdir へ復元。棚に無ければ何もしない。復元があったか boolean で返す */
  restore(sessionKey: string, workdir: string): Promise<boolean>;
  /** workdir → 保存棚へ退避 */
  flush(sessionKey: string, workdir: string): Promise<void>;
}

/** チャンネル単位の共有ディレクトリの退避と復元 (docs/design/state.md §5)。
 * WorkdirStore と違いキーは channelId のみで、transcript を持たないため
 * session.jsonl の有無によるゲートもコピー順序の担保も行わない。 */
export interface SharedStore {
  /** 保存棚 → staging へ復元。棚に無ければ何もしない */
  restore(channelId: string, dest: string): Promise<void>;
  /** staging → 保存棚へ退避 */
  flush(channelId: string, src: string): Promise<void>;
}
