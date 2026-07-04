# 永続化の抽象 — Store と Storage の差し替え

inbox / セッション状態 / lease (DB 系) と workdir の退避先 (Storage 系) を
インタフェースで抽象し、実装を差し替え可能にする。関連:
[session-model.md](session-model.md) §4 (実行ロック), [session-runtime.md](session-runtime.md) §3
(tmpfs + 境界 flush), [architecture.md](architecture.md) §2-5, [../build-plan.md](../build-plan.md) Step 4。

## 0. 結論

| 抽象 | インタフェース | 実装 | 本番 | ローカル |
|---|---|---|---|---|
| DB (状態) | `InboxStore` / `SessionStore` / `LeaseStore` | InMemory / SQLite / Firestore | Firestore | InMemory (既定) or SQLite |
| Storage (workdir 退避) | `WorkdirStorage` | ファイルコピー実装 **1 つだけ** | ベース = GCS FUSE マウント | ベース = ローカルディレクトリ |

- **DB はインタフェースが正、実装は差し込み**。SessionRunner はコンストラクタで
  Store 群を受け取るだけで、どの実装かを知らない (現行の `InboxStore` と同じ形)。
- **Storage は抽象がほぼ消える**。退避はただのファイルコピーであり、コピー先の
  ベースディレクトリが普通のディレクトリか GCS FUSE マウントかの違いしかない。
  GCS SDK は使わない (build-plan の技術選定どおり)。
- ローカル開発に Firestore エミュレータは**不要になる**。`pnpm run dev` は
  InMemory で動き、永続化込みの確認をしたければ SQLite を選ぶ。
  エミュレータ (compose) は Firestore 実装のテスト専用に格下げする。

## 1. DB 抽象 — 3 つの Store

永続化が必要な状態は 3 つで、それぞれ独立したインタフェースにする
(1 つの巨大な `Store` にしない。実装体は 1 つのクラスが 3 つを implements してよい)。

```typescript
/** イベントの耐久キュー。enqueue は dedupe を兼ねる (session-model.md §4) */
interface InboxStore {
  /** 追加。同 id が既に見えていれば false (at-least-once の再送吸収) */
  enqueue(threadKey: string, item: InboxItem): Promise<boolean>;
  /** 未処理分を取り出す。Step 4 以降は「取り出し=削除」ではなく ack 分離 (§4) */
  drain(threadKey: string): Promise<InboxItem[]>;
  /** 処理完了の確定。flush 成功後に呼ぶ (session-runtime.md §3 の順序) */
  ack(threadKey: string, itemIds: string[]): Promise<void>;
}

/** thread_key ごとのセッション状態 (session-model.md §9 の状態機械の永続部分) */
interface SessionStore {
  get(threadKey: string): Promise<SessionDoc | null>;
  put(threadKey: string, doc: SessionDoc): Promise<void>;
}

/** 実行ロック。TTL 付き lease で多重起動を排他する (session-model.md §4) */
interface LeaseStore {
  /** 取得を試みる。既に有効な lease があれば null (CAS 的取得) */
  acquire(threadKey: string, owner: string, ttlMs: number): Promise<Lease | null>;
  /** 延長。owner 不一致 / 期限切れなら false (fencing) */
  renew(lease: Lease, ttlMs: number): Promise<boolean>;
  release(lease: Lease): Promise<void>;
}
```

意味論はインタフェース側で固定し、実装差を隠す:

- **enqueue の dedupe** — 同一 `item.id` (= event_id 由来) の 2 回目以降は false。
  「見たことがある」の記憶は ack 後も保持する (再送は処理後にも届く)。
- **lease** — `acquire` は「有効な lease が無いときだけ作る」原子的操作。
  Firestore は txn / create、SQLite は `INSERT ... ON CONFLICT` + 期限比較、
  InMemory は Map 操作で実現する。owner は `インスタンスID:PID` 程度でよい。
- **時刻** — lease の期限判定に使う時計は Store 実装の内部事項とする
  (Firestore はサーバ時刻、SQLite/InMemory はプロセス時刻)。

### 実装は 3 つ

| 実装 | 用途 | 備考 |
|---|---|---|
| **InMemory** | 既定。ローカルお試し・単体テスト | Step 3 の InMemoryInbox を拡張。プロセス再起動で消えるが transcript は workdir に残るため会話の文脈は失われない |
| **SQLite** | ローカルで永続化・排他込みの動作確認 | better-sqlite3 (同期 API)。1 ファイル。compose 不要で Step 4 の受け入れ条件 (kill → 再起動 → 再開) をローカル検証できる |
| **Firestore** | 本番 (Cloud Run) | @google-cloud/firestore。テストはエミュレータ (compose) に対して行う |

選択は env `STORE_BACKEND=memory|sqlite|firestore` (既定 memory)。
server.ts の組み立て時に 1 箇所で分岐し、SessionRunner 以下には漏らさない。

### 共通コントラクトテスト

3 実装は同じ振る舞いをすべきなので、テストは「インタフェースに対する
コントラクトテスト」を 1 セット書き、実装ごとにパラメタライズして流す
(dedupe、drain/ack の順序、lease の排他・期限切れ・fencing)。
Firestore 実装だけ `FIRESTORE_EMULATOR_HOST` が立っているときのみ実行する
(CI では compose でエミュレータを立てる。ローカルで未起動なら skip)。

## 2. Storage 抽象 — WorkdirStorage

### 前提: pi の書き込み特性 (実測)

pi (v0.79.9 session-manager) は transcript を**エントリごとに `appendFileSync`**
(open → append → close) で書き、compaction 等では**ファイル全体を書き直す**
(`_rewriteFile`)。一方 GCS FUSE は追記も変更も**オブジェクト全体の再アップロード**
になる (v3 の streaming write は新規ファイルのシーケンシャル書きのみで、
既存ファイルへの追記は staged write にフォールバックし close ごとにアップロード)。

したがって session-runtime.md §3 の結論を維持する:
**pi はローカル (tmpfs) の workdir で走らせ、セッション境界でコピーで退避する**。
FUSE 側に「書き込みを debounce する」設定は存在しないが、境界退避なら不要。

### インタフェース

```typescript
/** workdir の退避と復元。実体はディレクトリコピー */
interface WorkdirStorage {
  /** 保存棚 → workdir。棚に無ければ何もしない (新規セッション) */
  restore(threadKey: string, workdir: string): Promise<void>;
  /** workdir → 保存棚。アトミック性は「transcript を最後に置く」順序で担保 (§3) */
  flush(threadKey: string, workdir: string): Promise<void>;
}
```

実装は**ファイルコピー 1 つだけ** (`CopyWorkdirStorage(baseDir)`)。
`baseDir` がローカルの普通のディレクトリなら「ローカル永続化」、
Cloud Run で GCS FUSE のマウントポイント (`/data`) なら「GCS 永続化」になり、
コードは同一。GCS SDK 実装は作らない (必要になった時に足せる形は保たれる)。

選択は env `WORKDIR_ARCHIVE_DIR` (未設定なら退避なし = Step 3 相当の挙動)。

### FUSE 前提の明記

- flush/restore は一括コピーなので FUSE の書き込み増幅の影響は「セッション境界に
  1 回」に抑えられる。transcript は数百 KB オーダーを想定し許容。
- インスタンス跨ぎの同時書き込みは FUSE では守られないが、lease で
  「同一 thread_key を flush するのは常に 1 プロセス」が保証されるため前提にできる。
- クラッシュ時は最後の flush 以降の transcript が失われる (= 会話の文脈が
  少し巻き戻る)。入力は inbox に残っており再実行される (at-least-once)。
  これは手動退避でも FUSE 直書き (close 前クラッシュ) でも同じ残余リスク。

## 3. flush のタイミングと順序

session-runtime.md §3 の規則をインタフェース語彙で言い直す:

1. **kick 時**: `restore` → pi spawn (`--session` が復元済み transcript を読む)
2. **agent_end 時** (ターン境界): `flush` 成功 → `inbox.ack` の順。
   逆にするとクラッシュで入力が消える
3. **セッション終了時** (✅): 最終 `flush` → lease release

flush 内部のコピー順序: workspace/ など他ファイル → 最後に transcript.jsonl。
restore は transcript が存在するかで「復元があったか」を判定できる
(現行の `resumed` ログと同じ判定が保存棚側にも適用できる)。

## 4. Step 3 からの差分 (何が置き換わるか)

| Step 3 (現行) | Step 4 (この設計) |
|---|---|
| InMemoryInbox (drain = 取り出し即消し) | `InboxStore` に ack を追加し、drain/ack 分離 |
| 排他 = インメモリ Map (`sessions`) | Map は「このプロセスが動かしている分」のビューに格下げし、正は `LeaseStore` |
| kick 失敗時に dedupe が残り再送が死ぬ (既知の穴) | ack しない限り inbox に残るため、再 kick で拾い直せる |
| agent_end 直後の追いメッセージ喪失レース (既知の穴) | lease 解放前に inbox を再確認する linger で解消 (session-model.md §4) |
| workdir はローカルに置きっぱなし | `WorkdirStorage` で境界退避。未設定なら現行どおり |
| Firestore エミュレータが開発の前提 (build-plan) | InMemory/SQLite で開発、エミュレータは Firestore 実装のテスト専用 |
