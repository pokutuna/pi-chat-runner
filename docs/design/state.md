# State — Control State と Agent State

State は実行プロセスの外に保持し、Runner の実行インスタンスが入れ替わっても Session を
再開できるようにする。用途によって Control State と Agent State に分ける。

関連: [message-dispatch.md](message-dispatch.md) (lease / inbox の使われ方)、
[runtime.md](runtime.md) (Agent State を Agent に見せる側)、
[session-model.md](session-model.md) (Session と Thread の区別)。

## 1. 2 つの State と不変条件

| 分類 | 内容 | 保存先 | アクセス主体 |
|---|---|---|---|
| Control State | Inbox、Thread → Session の対応、Session の実行状況、Lease、Channel の有効状態 | データベース | Runner のみ |
| Agent State | Session の Transcript と Workdir、Channel ごとの Shared | オブジェクトストレージ相当のディレクトリ | Agent (ファイルシステムとして) + Runner (復元・保存) |

分ける理由は参照の仕方が違うことにある。Control State はメッセージの配送や排他制御の
たびに個別のレコードを読み書きするためデータベースに置く。Agent State は
ディレクトリ単位で丸ごと復元・保存するためディレクトリのコピーとして扱う。

**不変条件: Agent は Control State に触れない。** Agent が読み書きするのは Agent State
だけで、Inbox・Lease・Session の実行状況は Runner が所有する。Runtime は Agent の起動
準備を行うが Control State を書かない ([runtime.md](runtime.md))。Control State の更新は
Dispatcher と Session の実行制御に限る。

Control State は Session の実行に必要な最小限だけを持つ。Agent の会話の中身は Transcript
(Agent State) にあり、Control State から会話を再構成することはしない。

## 2. Control State のキー

Control State のレコードは **sessionKey** で引く。sessionKey は Dispatcher が決めた
Session の識別子で、Thread Key とは別の概念である。

- sessionKey: Session の識別子。Session ごとの Inbox・Lease・実行状況・Workdir を引く
  - Thread ごとに Session を作る場合は `<channelId>:<threadTs>`、Channel 全体を 1 つの
    Session にする場合は `<channelId>`
- Thread Key: メッセージの返信先を指すキー。Agent が reply tool に渡す
  ([session-model.md](session-model.md))

ThreadStore はこの 2 つの間の対応 (どの Thread のメッセージがどの Session に合流するか)
を保持する唯一の場所である。

## 3. Control State の Store

Control State は 5 つの独立したインタフェースで構成する。1 つの巨大な Store にはしない
が、実装体は 1 つのオブジェクトが 5 つすべてを提供してよい。

```typescript
interface ControlState {
  inbox: InboxStore;
  sessions: SessionStore;
  threads: ThreadStore;
  leases: LeaseStore;
  channels: ChannelStateStore;
}
```

### 3.1 InboxStore

Gate を通ったメッセージの耐久キュー。

```typescript
interface InboxStore {
  enqueue(sessionKey: string, item: InboxItem): Promise<boolean>;
  drain(sessionKey: string): Promise<InboxItem[]>;
  ack(sessionKey: string, itemIds: string[]): Promise<void>;
}

interface InboxItem {
  id: string;
  event: InboundMessage;
  enqueuedAt: Date;
}
```

- **id は dedupe キー**: チャットアプリケーション側のイベント ID (`metadata.eventId`)、
  無ければメッセージ ID (`event.id`)。
- **enqueue は dedupe を兼ねる**: 同 id の 2 回目以降は積まず `false` を返す。
  at-least-once の再送を吸収する冪等操作。
- **「見た」記憶は ack 後も残る**: 処理を終えたメッセージの再送も `false` になる。
  ack で消えるのは drain の対象からだけである。
- **drain は非破壊で enqueue 順**: 未 ack の item を全件返し、削除しない。同じ item が
  何度でも返りうる。lease により同一 sessionKey を drain するのは常に 1 プロセスなので、
  「このターンで既に Agent へ渡した item」の記憶と重複除外は Session 側のインメモリ責務
  とする。プロセスが落ちればその記憶は消え、未 ack 分が丸ごと再配達される。
- **ack は処理完了の確定**: Agent State の flush に成功した後に呼ぶ
  ([message-dispatch.md](message-dispatch.md) の flush → ack 順序)。

### 3.2 SessionStore

Session の実行状況。

```typescript
interface SessionRecord {
  channelId: string;
  threadTs: string;
  /** Session を起こしたトリガーメッセージの ID (Session の同一性) */
  triggerMessageId: string;
  startedAt: Date;
  lastActiveAt: Date;
  /** Turn の完了で Session が畳まれた時刻。undefined = 稼働中 (生死の真実は lease 側) */
  endedAt?: Date;
  /** 明示的な新規 Session 要求の時刻。次の起動が消費してクリアする */
  rotateRequestedAt?: Date;
}

interface SessionStore {
  get(sessionKey: string): Promise<SessionRecord | null>;
  put(sessionKey: string, record: SessionRecord): Promise<void>;
}
```

`lastActiveAt` は idle による Session の終了判定に、`rotateRequestedAt` は明示的な新規
Session 要求 (`/new`) の伝達に使う。Session が「実行中かどうか」の真実は LeaseStore が
持ち、SessionRecord は判断材料であって排他の根拠ではない。

### 3.3 ThreadStore

Thread と Session の対応、および Channel の最新 Session へのポインタ。

```typescript
interface ThreadStore {
  /** Thread → 合流先 sessionKey。未登録なら null */
  resolve(threadKey: string): Promise<string | null>;
  bind(threadKey: string, sessionKey: string): Promise<void>;
  /** Channel の最新 Session (affinity の合流候補) */
  latest(channelId: string): Promise<
    { sessionKey: string; lastActiveAt: Date; endedAt?: Date } | null
  >;
  touchLatest(channelId: string, sessionKey: string): Promise<void>;
  markLatestEnded(channelId: string, sessionKey: string): Promise<void>;
}
```

- `resolve` / `bind` は affinity の結果を永続化する。Session が別 Thread のメッセージを
  取り込んだとき、その Thread Key を合流先 sessionKey に束ねる。以後その Thread への
  返信は、Runner の実行インスタンスが入れ替わっても同じ Session へ届く。
- `latest` / `touchLatest` / `markLatestEnded` は Channel ごとに「直近の Session は
  どれか」を保持する。Dispatcher が affinity の合流候補を探すときに読む。
  `touchLatest` は Session の発生と Turn の進行で、`markLatestEnded` は Session の終了で
  呼ぶ。`endedAt` が付いていても合流候補から自動的に外れるわけではなく、判定は
  Dispatcher の窓の設定による ([message-dispatch.md](message-dispatch.md))。

### 3.4 LeaseStore

Session の実行の排他制御。

```typescript
interface Lease {
  sessionKey: string;
  owner: string;
  /** fencing token。acquire (奪取を含む) ごとに単調増加 */
  token: number;
  expiresAt: Date;
}

interface LeaseStore {
  acquire(sessionKey: string, owner: string, ttlMs: number): Promise<Lease | null>;
  renew(lease: Lease, ttlMs: number): Promise<boolean>;
  release(lease: Lease): Promise<void>;
}
```

- `acquire` は「有効な lease が無いときだけ作る」原子的操作。既に有効なら `null`。
  期限切れの lease は奪える — その場合 token を 1 増やして再発行する。
- `renew` は渡した lease の token と owner が現行と一致し、かつ期限切れでないときだけ
  期限を延ばす。不一致・期限切れなら `false` を返す (fencing)。奪われた側は `false` を
  見て自分が既に権利を失ったことを知る。
- `release` は token が現行の lease と一致するときのみ削除する。不一致なら何もしない —
  奪った側の lease を誤って消さないため。
- `owner` は「インスタンス ID:PID」程度でよい。期限判定に使う時計は backend の内部事項。

### 3.5 ChannelStateStore

Channel の有効・無効。チャットからのコマンドで書き換わる実行時状態であり、設定ではない。

```typescript
interface ChannelStateDoc {
  enabled: boolean;
  updatedAt: Date;
  /** 最後に切り替えた送信者 id (監査用) */
  updatedBy?: string;
}

interface ChannelStateStore {
  get(channelId: string): Promise<ChannelStateDoc | null>;
  put(channelId: string, doc: ChannelStateDoc): Promise<void>;
}
```

doc が存在しない Channel は **enabled が既定**。無効化して初めてレコードができる。

## 4. Control State の backend

意味論はインタフェース側で固定し、backend の差は隠す。選択は System Config で行い、
Dispatcher 以下には実装の別を漏らさない ([config.md](config.md))。

| backend | 用途 | 実現手段 |
|---|---|---|
| memory | 既定。ローカルのお試し・単体テスト | Map 操作。プロセス再起動で消えるが、Transcript は Agent State に残るため会話の文脈は失われない |
| SQLite | ローカルで永続化・排他込みの動作確認 | better-sqlite3 (同期 API)、1 ファイル、WAL モード |
| Firestore | Cloud Run 上での運用 | @google-cloud/firestore。トランザクションと `create()` |

### 4.1 SQLite のレイアウト

| テーブル | 主キー | 列 |
|---|---|---|
| `inbox_items` | `(session_key, item_id)` | `payload`, `enqueued_at`, `acked` |
| `sessions` | `session_key` | `doc` (JSON) |
| `threads` | `thread_key` | `session_key` |
| `channel_latest` | `channel_id` | `session_key`, `last_active_at`, `ended_at` |
| `leases` | `session_key` | `owner`, `token`, `expires_at` |
| `channel_state` | `channel_id` | `doc` (JSON) |

- enqueue は `INSERT OR IGNORE` の変更行数で dedupe を判定する。drain は
  `acked = 0` を `rowid` 昇順で返す。
- lease の `acquire` は同期トランザクションで現行行を読んでから `INSERT ... ON CONFLICT`、
  `renew` は条件付き `UPDATE` 1 文で原子性を担保する。

### 4.2 Firestore のレイアウト

全コレクションを親ドキュメント `rootDoc` (既定 `pi-chat-runner/default`) の
サブコレクションに置く。既存プロジェクトの Firestore に同居してもトップレベルを
散らかさず、`rootDoc` を変えるだけで複数インスタンスが同居できる。親ドキュメント自体は
書かない。

| コレクション | パス |
|---|---|
| inbox | `<rootDoc>/inbox/{sessionKey}/items/{itemId}` |
| sessions | `<rootDoc>/sessions/{sessionKey}` |
| threads | `<rootDoc>/threads/{threadKey}` |
| channel latest | `<rootDoc>/channel_latest/{channelId}` |
| leases | `<rootDoc>/leases/{sessionKey}` |
| channels | `<rootDoc>/channels/{channelId}` |

- enqueue は `create()` の `ALREADY_EXISTS` を `false` に写像して dedupe とする。
- drain の順序は enqueue 時に書く `seq` フィールド (注入された `now()` と同 ms 内の
  単調化カウンタ) でクライアント側ソートする。`where` と `orderBy` の併用は複合
  インデックスを要求するため使わない。
- lease の期限判定は注入された `now()` と数値の `expiresAtMs` の比較で行う。
  `acquire` / `renew` / `release` はトランザクション内で token と owner の一致を確認する。

### 4.3 Contract test が仕様

3 つの backend は同じ振る舞いをすべきなので、テストは「インタフェースに対する契約
テスト」を 1 セットだけ書き、backend ごとにパラメタライズして流す。backend 固有の
テストではなく、この契約スイートに書くことが仕様の追加である。

Firestore は `FIRESTORE_EMULATOR_HOST` が立っているときだけ実行し、未起動なら skip する。

## 5. Agent State の棚

Agent State は Session 単位の棚と Channel 単位の棚の 2 つに分かれる。どちらもディレクトリ
のコピーで往復するだけなので、棚の実体が Cloud Storage のマウント先でもローカルの
ディレクトリでも同じに動く。

| 棚 | パス | キー | 中身 |
|---|---|---|---|
| Workdir (Session) | `<workdirBase>/<channelId>/<threadTs\|channel>/` | sessionKey | `session.jsonl` (Transcript) + Agent の作業ファイル |
| Shared (Channel) | `<sharedBase>/<channelId>/` | channelId | `skills/`、`memory/`、Agent が置いた任意のファイル |

Transcript と Workdir は 1 つの棚に同居させる。Transcript は Agent が `--session` で
読み書きする Workdir 内の 1 ファイルであり、別の保存先に分ける理由がない。

```typescript
interface WorkdirStore {
  /** 棚 → workdir。復元したかを返す */
  restore(sessionKey: string, workdir: string): Promise<boolean>;
  flush(sessionKey: string, workdir: string): Promise<void>;
}

interface SharedStore {
  restore(channelId: string, dest: string): Promise<void>;
  flush(channelId: string, src: string): Promise<void>;
}
```

### 5.1 復元と保存の規則

- **restore は `session.jsonl` の有無で gate する**: 棚に Transcript が無ければ何も
  復元せず `false` を返す。これが「新規 Session か再開か」の判定そのものになる。
  Shared にはこの gate が無い — Transcript を持たないただのディレクトリなので、棚に
  エントリがあれば常に復元する。
- **flush は `session.jsonl` を最後に書く**: それ以外のファイルを先にコピーし、
  Transcript を最後に置く。コピーの途中で落ちても「Transcript があるのに作業ファイルが
  古い」状態にはならず、restore の gate が「Transcript がある = 一式が揃っている」を
  意味できる。
- **コピーは通常ファイルとディレクトリのみ**: socket 等の特殊ファイルは除外し、コピー先
  の同名エントリは置き換える。削除は伝播しない (コピーは上書きのみ)。
- **サイズの警告**: Shared の flush でコピーしたバイト数が閾値 (既定 50MiB) を超えたら
  warn を出す。ブロックはしない。判定にはコピー中に数えた実測値を使い、棚を走査し直さ
  ない — 棚がネットワーク越しなら走査はファイル数に比例する往復になり、気づきのための
  警告には高すぎる。
- restore / flush は所要時間・ファイル数・バイト数をログに出す。肥大化対策の判断材料は
  files と bytes のどちらが支配的かで変わるため両方残す。

### 5.2 排他

Workdir の棚は sessionKey 単位なので、lease により同時に flush するプロセスは常に 1 つ
に保たれる。Shared の棚は Channel 単位で、同一 Channel の複数 Session が並行して Turn を
終えると flush が交錯しうる。ここにはロックを置かず、**ファイル単位の last-write-wins**
を受容する。Channel 単位のロックは無関係な Session 同士をブロックし、クラッシュ時の
ロック回収という新しい故障モードを持ち込む。flush はファイルごとのコピーなので、負けた
側も「ファイル単位で古い」だけでディレクトリ全体は壊れない。

## 6. Workdir と Shared staging のパス

Agent が触るのは棚そのものではなく、tmpfs 上に置いた実行用のディレクトリである。
棚との往復は Runner の仕事で、Agent は棚の存在を知らない。

```
/tmp/pi-chat-runner/sessions/<channelId>/
  <threadTs>/          … Workdir (Thread ごとに Session を作る場合の cwd)
  channel/             … Workdir (Channel 全体を 1 つの Session にする場合の cwd)
    session.jsonl      … Transcript。pi に --session で渡す
  shared/              … Shared の staging。Agent からは cwd 相対 ../shared/
    skills/            … Agent が書ける skill 置き場。常に mkdir する
    memory/            … 組み込み memory skill の書き先
```

staging を Workdir の**中**ではなく**隣**に置く。中に置くと Workdir の flush / restore
から除外する処理が要り、除外漏れは「Session の棚の汚染」「古い Shared の復活」という
静かな事故になる。隣に置けば Session 層と完全に直交し、除外処理も名前の予約も要らない。
代償は権限の配線が別途要ることだが、こちらの漏れは「Agent が書けない」というすぐ気づく
失敗になる。Workdir は Session のどちらのモードでも `<channelId>/` の 1 階層下なので、
Agent に教える相対パスが常に `../shared/` で一定になる。

## 7. 復元と保存のタイミング

| 契機 | 処理 |
|---|---|
| Session の起動時 | Workdir を mkdir → `WorkdirStore.restore` → `SharedStore.restore` |
| Turn 境界 (Agent が応答の完了を通知) | `WorkdirStore.flush` → `SharedStore.flush` → `InboxStore.ack` |
| 異常終了 (プロセス終了・Turn のタイムアウト・lease の renew 失敗) | flush しない |

flush → ack の順序が正である。逆にするとクラッシュで入力が消える。flush が throw すれば
ack されず、未 ack のメッセージは次の実行で拾い直される (at-least-once)。ack の対象は
flush 前にスナップショットした id — flush の await 中に届いたメッセージを、そのターンの
成果に含まれていないのに ack してしまわないため。

異常終了パスで書き戻さないのは、壊れた状態を棚へ伝播させないためと、lease を失った側が
棚を上書きして排他を破らないためである。失われるのは最後の flush 以降の Transcript
(会話の文脈が少し巻き戻る) だけで、入力は Inbox に残っており再実行される。

## 8. 保存先が未設定のときの挙動

Agent State の保存先は設定しなくても動く。ローカルで動作を確認するときに保存先の用意を
強制しないためである。

| 設定 | 未設定時 |
|---|---|
| Workdir の棚 (`system.state.agent.workdirDir`) | 境界での退避を行わない。restore は常に `false`、flush は何もしない。Session はプロセスが生きている間だけ文脈を保つ |
| Shared の棚 (`system.state.agent.sharedDir`) | Shared 機能ごと無効。staging の作成、skill の配線、システムプロンプトへの言及をすべて省く |

Shared には「何もしない実装」を置かない。無効時は Runtime が Shared に関する配線を丸ごと
省くため、空の Store を渡す意味がない。

## 9. Shared の用途

Shared は Channel 単位の知識置き場である。Workdir の棚が Session 単位の状態を守るのに
対し、Shared は Session を越えて残るものを守る。

- `../shared/skills/` — Agent が自分で書いた skill。次の Session から自動でロードされる
  ([runtime.md](runtime.md))。空でも常に mkdir する
- `../shared/memory/` — 組み込み memory skill の書き先。索引 `MEMORY.md` と
  `<slug>.md` の本文ファイルで構成する。索引は Runtime がシステムプロンプトへ注入し、
  本文は Agent が必要と判断したときだけ読む
- その他、Agent が Channel の文脈で残したい任意のファイル

memory を「1 事実 1 ファイル」に分けるのは、Shared がロック無しの last-write-wins だから
である。並行する Session が同時に学んでも、衝突面が「同じ 1 事実を同時に書いた」場合に
縮む。索引だけは追記が競合しうるが、負けても本文ファイルは残り、次に気づいた Session が
索引を直せる。

影響範囲は棚が channelId 単位で分かれるため**その Channel に閉じる**。他 Channel の
staging は復元されず、Shared 経由で全 Channel に効く指示は書けない。信頼できない入力が
流れる Channel では、Shared の保存先を設定しない (機能ごと無効) か Channel を分ける。

## 10. 実装対応

| 設計上の名前 | 現在の実装 |
|---|---|
| ControlState | 同名 (`src/state/control/interfaces.ts`) |
| SessionRecord | 同名 (同上) |
| ThreadStore | 同名 (同上)。`SessionRunner` は `threads.resolve` / `bind` / `latest` 経由で参照する |
| InboxStore / SessionStore / LeaseStore / ChannelStateStore | 同名 (同上)。引数名は `sessionKey` |
| Control State backend | `InMemoryControlState` / `SqliteControlState` / `FirestoreControlState` (`src/state/control/backends/`) |
| SQLite / Firestore のキー名 | 列 `session_key`、`Lease.sessionKey`、コレクション `<rootDoc>/inbox/{sessionKey}/items/{itemId}`。旧列 `thread_key` の DB は SQLite を開くときに `ALTER TABLE ... RENAME COLUMN` で移行する |
| contract test | `test/state/control/contract.ts` |
| InboxItem.id の導出 | `inboxItemId` (`src/state/control/inbox-item.ts`) |
| WorkdirStore / SharedStore | 同名 (`src/state/agent/interfaces.ts`)、`CopyWorkdirStore` / `CopySharedStore` (`src/state/agent/copy.ts`)、`NoopWorkdirStore` (`src/state/agent/noop.ts`) |
| 棚の選択 | `createWorkdirStore` / `createSharedStore` (`src/state/agent/copy.ts`)、`src/server.ts` が env から組み立てる |
| restore / flush の呼び出し | `prepareWorkdir` (`src/runtime/prepare.ts`)、`ActiveSession.#onAgentEnd` (`src/session/active-session.ts`) |
| Workdir / staging のパス | `SessionRunner.workdirRoot` / `sharedStagingDir` (`src/session/runner.ts`) |
