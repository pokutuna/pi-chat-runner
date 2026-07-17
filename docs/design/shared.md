# shared — チャンネル単位の共有永続ディレクトリ

セッション (スレッド) を越えて agent がドキュメントや skill を蓄積するための、
チャンネル単位の永続ディレクトリ。workdir の退避 ([persistence.md](persistence.md) §2)
がセッション単位の状態を守るのに対し、shared はチャンネル単位の知識を守る。
利用形態の代表である組み込み memory skill は [memory.md](memory.md)。

## 0. 結論

| 項目 | 決定 |
|---|---|
| 有効化 | env `SHARED_DIR` にパスを設定したら有効。未設定なら機能ごと無効 |
| 保存棚 | `<SHARED_DIR>/<channelId>/` (GCS FUSE でもローカルディレクトリでも可) |
| staging | `<workdirRoot>/<channelId>/shared/` — workdir の**隣**。agent からは cwd 相対 `../shared/` |
| skills | shared 有効時は常に `<staging>/skills/` を mkdir して pi の `--skill` に配線 |
| 排他 | ロック無し。ファイル単位 last-write-wins を受容 |
| 異常終了 | 書き戻さない (workdir flush と同じ 3 パス) |

## 1. パス規約 — workdir の隣に置く

```
<workdirRoot>/<channelId>/
  <threadTs>/          … workdir (session.mode: thread)
  channel/             … workdir (session.mode: channel)
  shared/              … staging。agent からはどちらのモードでも cwd 相対 ../shared/
    skills/            … 常に mkdir。pi --skill に配線 (空なら pi が黙って無視)
    memory/            … 組み込み memory skill の書き先 (memory.md)
    (任意のファイル)    … agent が自由に置ける

<SHARED_DIR>/<channelId>/   … 保存棚。staging と 1:1 のコピー
```

staging を workdir の **中** (`./shared/`) でなく **隣** (`../shared/`) に置く理由:

- workdir 内に置くと `CopyWorkdirStorage` の flush/restore から除外する処理が要る。
  除外漏れは「セッション棚の汚染」「古い shared の復活」という**静かな事故**になる。
  隣に置けば session 層と完全に直交し、除外処理も名前予約も不要。
- 代償は permission / chown の配線が別途要ること。だがこちらの漏れは
  「agent が書けない」という**うるさい失敗**であり、すぐ気づける。
- thread / channel どちらの session.mode でも workdir は `<channelId>/` の 1 階層下
  なので、agent に教える相対パスが常に `../shared/` で一定になる。

`session.mode: channel` でも sessionKey (`channelId`) 単位の workdir とは別物として
扱う — workdir はセッションの作業場 (transcript と一緒に世代交代しうる)、shared は
チャンネルの知識置き場 (セッションのライフサイクルと独立)、という役割分担。

## 2. restore / flush — workdir と同じ境界、ゲート無し

`SharedStorage` インタフェースと `CopySharedStorage` は
[persistence.md](persistence.md) §2 の `WorkdirStorage` / `CopyWorkdirStorage` と
同型 (src/store/workdir.ts)。差分は 2 つ:

- キーが threadKey でなく **channelId**。
- restore に **session.jsonl ゲートが無い**。workdir の復元は「transcript が
  あるか」で新規/再開を判定するが、shared は transcript を持たない
  ただのディレクトリなので、棚にエントリがあれば常に復元する。

タイミングは workdir と完全に同じ境界 (runner.ts):

1. **kick 時**: `mkdir <staging>/skills` → `sharedStorage.restore(channelId, staging)`
   (workdir restore の直後)。UID 分離時は staging も agent 所有 0700 に揃える
2. **agent_end 時** (ターン境界): `workdirStorage.flush` → `sharedStorage.flush`
   → `inbox.ack` の順。flush が throw すれば ack されず入力は再実行される
3. **異常終了 3 パス** (exit / abnormalShutdown / lease renew 失敗) では
   書き戻さない — 壊れた状態の伝播防止・排他喪失時の競合防止という
   workdir flush と同じ理由 ([persistence.md](persistence.md) §3)

## 3. 排他 — ロック無し、last-write-wins

同一チャンネルの複数スレッドが並行してターンを終えると、shared の flush が
交錯しうる。ロックは作らず**ファイル単位の last-write-wins** を受容する:

- lease はセッション (sessionKey) 単位の排他であり、チャンネル単位の shared は
  守らない。チャンネル単位のロックを足すと、無関係なスレッド同士がブロックし合い、
  クラッシュ時のロック回収という新しい故障モードを持ち込む。
- flush はファイルごとのコピーなので、負けた側も「ファイル単位で古い」だけで
  ディレクトリ全体が壊れることはない。memory の規約 (1 事実 1 ファイル、
  [memory.md](memory.md)) はこの特性に合わせて衝突面を小さくしている。
- 同種の chat runner である pi-chat (earendil-works) も同じ割り切りで運用している。

## 4. pi への見せ方 — skills 配線・プロンプト・permission

shared 有効時に kick が行う配線 (runner.ts):

- **skills**: realpath した `<staging>/skills/` を常に `--skill` へ渡す。pi は
  空ディレクトリを黙って無視するので、無条件配線で害が無い。agent が
  `../shared/skills/<name>/SKILL.md` を書けば**次のセッションから自動ロード**される。
  組み込み memory skill (`builtin-skills/memory/`) も `doc.memory !== false` のとき
  ここに並ぶ ([memory.md](memory.md))。
- **system prompt**: 「`../shared/` はチャンネル共有の永続ディレクトリで、
  スレッドとセッションを越えて残る」ことを 1 段落追記する (`SHARED_DIR_PROMPT`)。
- **Node Permission Model**: staging は workdir / agent HOME の外にある唯一の
  agent 書き込み先なので、`--allow-fs-write` / `--allow-fs-read` に staging を
  追加する ([session-runtime.md](session-runtime.md) §6)。
- **UID 分離**: restore のコピーは root (Runner) が行うため、workdir と同様に
  staging を `chownRecursive` + chmod 0700 で agent に渡す。

## 5. デプロイ形態 — 棚は「ただのディレクトリ」

`CopySharedStorage` は境界コピーだけなので、棚の実体は問わない
([persistence.md](persistence.md) §2 の FUSE 前提と同じ理屈):

| 環境 | SHARED_DIR の例 |
|---|---|
| Cloud Run | `/data/shared` (WORKDIR_ARCHIVE_DIR (`/data/channels`) と同じ GCS FUSE マウント上に種類別サブディレクトリとして同居。examples/service.yaml) |
| ローカル (dev:socket) | `/tmp/pi-chat-runner/shared` 等を明示 |
| コンテナ (compose) | volume をマウントしたパス (develop/compose.local-container.yaml) |

Cloud Run では 1 つの GCS FUSE マウント (`/data`) を種類別に分けて共有する:

```
/data/
  channels/<channelId>/<threadTs>/   … セッション棚 (WORKDIR_ARCHIVE_DIR)
  shared/<channelId>/                … shared 棚 (SHARED_DIR)
  docs/                              … 予約地 (未実装)
```

GCS FUSE は uid=0 / dir-mode=0700 でマウントされるため agent からは直接見えない —
pi が触るのは staging のコピーだけで、restore/flush はホストの仕事。この隔離境界は
workdir と同一 ([session-runtime.md](session-runtime.md) §6)。

## 6. セキュリティ — チャンネル内 self-modification の受容

`../shared/skills/` への書き込みは「agent が自分の将来セッションの能力
(プロンプトに乗る指示) を書き換えられる」ことを意味する。位置づけ:

- 影響は**そのチャンネルに閉じる**。棚が channelId 単位で分かれ、他チャンネルの
  staging は復元されない。全チャンネル共通の skill 口
  (`$AGENT_HOME/.pi/agent/skills/`、イメージ焼き込み) とは別経路であり、
  shared 経由で全チャンネルに効く指示は書けない。
- prompt injection でチャンネルの shared に悪性の skill を書かれるリスクは、
  そのチャンネルの入力の信頼度に依存する。信頼できない入力が流れるチャンネルでは
  `SHARED_DIR` を設定しない (機能ごと無効) か、運用でチャンネルを分ける。
- 実行権限は従来と同じ agent 相当 (UID 分離 + permission-gate) で、shared は
  権限の昇格面を増やさない。

## 7. 既知の制約

- **reply の files に `../shared/` のファイルは添付できない**。resolveReplyFiles は
  workdir 境界内のパスしか許さない ([chat-model.md](chat-model.md) §5.6 の配線)。
  添付したければ workdir にコピーしてから reply する (agent がやればよい)。
- flush は staging 全体のコピーなので、shared が肥大するとターン境界のコストが
  増える。想定は memory / skills / 小さなドキュメントで数 MB オーダー。
  大きな成果物は workdir の artifacts 側に置く。
- 削除の伝播はしない (コピーは上書きのみ)。棚から消したいファイルは
  staging と棚の両方から消す必要がある — 現状は運用 (手動) で対応。
