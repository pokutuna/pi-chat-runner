# ローカル開発コネクタ (local mode)

Slack を介さず、ターミナルの stdin/stdout だけで gate → inbox → lease → pi →
egress の全パイプラインを実配線で動かす開発用コネクタ。

## 0. 目的と位置づけ

動作確認の手段は 3 層あり、local mode はその中間を埋める:

| 層 | pi | チャット | 用途 |
|---|---|---|---|
| vitest (fake-pi) | フェイク | フェイク | ロジックの回帰テスト |
| **local mode** | **本物** | **stdin/stdout** | **開発中の手元確認** |
| dev:socket / 本番 | 本物 | 実 Slack | 公開前の実機確認 |

vitest は fake-pi なので「本物の pi + 本物の config で挙動を見る」層が抜けて
いた。local mode はそこを埋める。実 Slack でしか確認できないもの (mrkdwn の
実際の見た目、ファイルアップロード、rate limit) は従来どおり dev:socket で行う。

原則: **専用の分岐を後段に持ち込まない**。SessionRunner 以下は local mode を
知らない。差し替えるのは composition root (server.ts / bridge.ts) の注入点のみ
(architecture.md §1 の EventSource 差し替えと同じ考え方)。

## 1. 起動

`dump` と同様の server.ts サブコマンドとして実装する:

```sh
node dist/server.mjs local [channelId]   # 既定チャンネルは "local"
pnpm run dev:local                       # tsx --env-file-if-exists=.env.local src/server.ts local
```

- 設定ファイルは通常どおり `CONFIG_PATH` から読む。**connector ブロックは
  不要** (読まない)。channels / store / agent ブロックはそのまま効くため、
  本番と同じ config で gate・affinity・prompt の挙動を確認できる
- `channelId` は ChannelDoc のキーとしてそのまま使われる。既定は `local`
  (examples の agent.yaml に `local:` エントリ例を置く)。実在チャンネルの
  ID を渡せば本番向け設定の確認もできる
- pi は本物が起動する。必要な env (GOOGLE_CLOUD_PROJECT 等) は `.env.local`
  に置く。permissionMode / uid 分離などの agent.runtime は dev:socket と同じ
  扱い
- `dev:local` は watch なし (`tsx watch` だと再起動のたびに REPL とインメモリ
  状態が飛ぶため)

## 2. 構成 — LocalChat core と REPL アダプタ

I/O を持たないプログラマブルな core と、それを stdin/stdout に繋ぐ REPL
アダプタの 2 層に分ける。core は e2e テストからそのまま使える (REPL は
core の一利用者にすぎない):

```
LocalChat (core, src/ingress/local/local-chat.ts — I/O なし)
  提供する注入物:
    ingress:      Ingress        — post()/react() で合成したイベントを onEvent へ流す
    poster:       ChatPoster     — postMessage/updateMessage をログに積み、変化を通知
    reactions:    Reactions      — reactions.add をログ上の記録 + 通知にする
    userResolver: UserResolver   — 固定マップ (U_LOCAL → "you" 等)
    fetchMessage: FetchMessage   — 自前のメッセージログから解決
  プログラマブル API (REPL と e2e が使う):
    post(text, options?)  — InboundMessage を合成して流す (channelId/threadTs/
                            mentionsBot/sender/isDm を options で指定)
    react(ts, emoji)      — ReactionEvent を流す
    log() / bySeq(n)      — 構造化メッセージログの参照 ([N] 連番 → ts 解決)
    変化通知 (EventEmitter) — bot 投稿・更新・reaction を購読できる
                            (REPL は描画に、e2e は「返信が来るまで待つ」に使う)

REPL アダプタ (src/ingress/local/ — dev:local のみが使う、2 ファイル構成)
  repl-logic.ts (純粋なロジック層、I/O なし)
    - parseLine        — stdin 1 行 → 文法パース
    - handleLine        — パース結果 + core の API 呼び出し (async)
    - ReplState/resolveThreadRef/displayName — 現在チャンネル・現在ユーザー・
      DM フラグなどの「今の状態」はここが持つ (core はステートレスにイベント
      を受けるだけ)
    - formatMessageLine/formatUpdateLine/formatReactionLine — 表示用整形
  repl.tsx (ink ベースの画面、React コンポーネント)
    - App           — repl-logic の関数を呼び出す ink コンポーネント本体。
                      ink-testing-library から直接 render するためにも export する
    - startRepl     — App を ink の render() でマウントし、終了まで待つ入口

  ロジックと画面表示を分離したのは、handleLine 等を ink/React なしで単体
  テストできるようにするため (repl-logic.test.ts)。画面側は
  ink-testing-library での最小スモークテストのみ (repl.smoke.test.tsx)。
```

core を 1 モジュールにまとめるのは、注入物すべてが**同一のメッセージログを
共有する**ため: poster が投稿した bot メッセージもログに積むことで、bot
投稿への reaction 起動 (`fetchMessage`) やスレッド返信が Slack と同じに動く。
bot 投稿はログに `isSelf: true` で記録するが、ChatEvent として還流はさせない
(自己エコー経路を持たない)。`ingress.start()` 前に post された分は
バッファし、start 時に流す。

### e2e テストでの利用

vitest の既存ハーネスは SessionRunner を直接組んでおり、bridge の Layer 0
(二重配信 dedupe・self-echo 除外・enrich・reaction 分岐) はテスト圏外
だった。LocalChat core + fake-pi + startBridge の組み合わせで bridge 込みの
経路を回帰テストに入れられる。本物 pi との組み合わせは課金と非決定性が
あるため CI 常用にはせず、手動 smoke 用とする。

### bridge.ts の変更 (2 点)

1. `web?: WebClient` — 省略可にする。省略時は poster / reactions /
   userResolver / fetchMessage の全注入が必須 (欠けていれば起動時に throw)
2. `fetchMessage?: FetchMessage` — 注入点を追加する。現在 bridge 内部で
   `web.conversations.replies` から組み立てている唯一の web 直依存で、
   これを seam にすれば web なしで完結する

`mentionFormat` (`<@U...>`) と `toMrkdwn` は差し替えない。local mode でも
Slack 向けの最終整形を通した文字列を表示する — 「実際に投稿される mrkdwn」
がそのまま見えることは確認手段としてむしろ望ましい (パリティ優先)。

server.ts の `runLocal()` は main() と同じ store/agent/pi パス解決を再利用し、
connector 構築だけを createLocalChat に置き換えて startBridge を呼ぶ。

## 3. REPL 文法

### 入力 → ChatEvent

| 入力 | 意味 |
|---|---|
| `text` | チャンネル直下投稿 (mentionsBot: false) |
| `@bot text` | mention 付き投稿 (mentionsBot: true、prefix は除去) |
| `>N text` | メッセージ N のスレッドへの返信 (`threadTs` = N の ts) |
| `>N @bot text` | スレッド返信 + mention |
| `>ts:X text` | 生 ts `X` のスレッドへの返信 (無検証) |

- `N` は表示に付く連番 (`[3]`) で、ts そのもの (下記「ID 形式」)。ログに
  実在しない `N` はエラーにする (typo 保護)
- `ts:X` は **ログに存在しない ts も無検証で許す**。runner が観測していない
  過去メッセージへのスレッド返信 (スレッド途中 mention 等) は Slack 実機で
  ふつうに起きる入力で、その再現に必要なため
- `/new ...` や `/enable` などの**チャットコマンドは通常のメッセージ本文**
  としてそのまま流れる (runner 側で解釈される)。REPL 自身のメタコマンドは
  衝突しないよう `!` prefix にする

### メタコマンド (`!` prefix、ChatEvent にならない)

| コマンド | 意味 |
|---|---|
| `!react <N\|ts:X> <emoji>` | メッセージに ReactionEvent (added: true) を注入 |
| `!thread <N\|ts:X>` (alias `!t`) | スレッドに入る (以降の通常投稿がそこへ) |
| `!leave` | スレッドから出てチャンネル直下に戻る |
| `!channel <id>` | 投稿先チャンネルを切替 |
| `!dm on\|off` | `conversation.isDm` を切替 (DM gate の確認用) |
| `!user <id> [--bot]` | 発言者を切替。`--bot` で `isBot: true` (allowBots の確認用) |
| `!quit` | 終了 (Ctrl-D も同じ) |

`isSelf` は常に false (poster の出力をイベントとして還流させないため、
自己エコー経路自体が存在しない)。

### 表示

画面は ink (React ベースの TUI) で上下 2 ペイン (上: log、下: chat) に分割
する。pino の構造化ログとチャットの会話が同じ stdout に混ざって読みにくかった
ための分離。両ペインは端末の高さ (入力欄 1 行を除く) を 50% ずつ使い、最下行
全幅が入力欄:

```
┌ logging ─────────────────────────────┐
│ INFO  [session] session start sess…  │
│ DEBUG [pi] agent_start sessionKey=…  │
│ DEBUG [pi] message_end role=assist…  │
│ INFO  [egress] reply delivered thr…  │
└──────────────────────────────────────┘
┌ chat ────────────────────────────────┐
│ [1] you: @bot 調査して                │
│ :eyes: on [1]                        │
│ [2]↳1 bot: 調査します。まず …          │
│ [2]↺ bot: (進捗の上書き)              │
└──────────────────────────────────────┘
#local you> _
```

- log ペイン: server.ts が local mode 専用に生成する pino ロガーの出力を
  NDJSON のまま受け取り、`LEVEL [tag] head key=val ...` に整形して表示する。
  長いエントリは端末幅で複数行に折り返す (span の色を維持したまま折り返す
  `wrapSpans`。スクロール単位は折り返し後の端末行)。level 名 (赤=50 以上 /
  黄=40 / 緑=30 / gray=それ以外)・tag・fields を span 単位で色分けする。
  pi 子プロセス由来のログ (`pi event` の各イベント・`pi stderr`) は tag を
  `[pi]` (magenta) に付け替え、runner 自身のログ (`[session]` 等、blue) と
  一目で区別できるようにする。`pi stderr` は `line` フィールドの本文を head に
  昇格して全文表示する
- chat ペイン: メッセージは `[N]` を付けて表示する。スレッド返信は `[N]↳M`
  (M は親の番号)、`updateMessage` (進捗通知の上書き) は `[N]↺`、mention は
  本文先頭に `@bot` を復元して表示する。`postMessage` の `files` はパスの
  列挙のみ (アップロードはしない)。`isSelf` (bot 由来) の行は cyan で表示
  する。長い行は端末幅で折り返す
- 最下行が入力欄。Enter で確定した行は repl-logic.ts の `handleLine` に渡す。
  入力全体が `@bot` の前方一致 (`@`, `@b`, …) のときだけ Tab で `@bot ` に
  補完する (それ以外の Tab はフォーカス切替)
- フォーカス: Tab / Shift-Tab で input → log → chat を巡回し、Escape で
  input に戻る。フォーカス中のペインは枠線の cyan とタイトル末尾の ` *`
  マーカー (色が出ない環境向け) で示す。input フォーカスでは文字入力・
  カーソル移動 (←→ / C-a C-e 等の readline 風バインド) が効き、log/chat
  フォーカスではスクロールのみ効く
- スクロール: 各ペインは末尾追従 (最新を表示) が既定。フォーカス中のペインを
  ↑↓ / C-p C-n で 1 行、PageUp/Down で 1 ページぶんスクロールバックでき、
  末尾まで戻ると追従を再開する (スクロールバック中は新着で流されない)。
  マウスホイールはフォーカスに関係なくカーソル下のペインをスクロールする
  (SGR マウストラッキング mode 1000+1006 を実 TTY のときだけ有効化し、終了時
  に解除する。有効中は端末ネイティブのドラッグ選択が奪われるため、選択は
  多くの端末で Shift+ドラッグになる)

### ID 形式

ts はログ連番 seq の文字列表現 (`"1"`, `"2"`, …) で、表示の `[N]` と同一。
sessionKey は `local:3` のようになり、log ペインの sessionKey とチャットの
`[N]` を直接突合できる。Slack 互換の epoch 形式にはしない — ローカル経路で
ts を数値パースする箇所はなく (sessionKey は不透明な文字列連結、affinity の
窓判定は Date ベース)、短い方が読みやすさで勝るため。

## 4. 実装方針

- 画面描画: `ink` (React ベース TUI) + `react`。ログペイン/チャットペイン/
  入力欄を宣言的に描く。npm 依存として追加している (旧版は
  `node:readline` + `styleText` の素朴な逐次出力のみで新規依存なしだったが、
  2 ペイン化にあたり手組みするより ink を使う方が保守しやすいと判断した)。
  スクロールは ink 用の既製ライブラリがどれも生後半年未満の個人パッケージで
  `minimumReleaseAge` ポリシーに反するため導入せず、既存の「末尾 N 行 slice」
  表示にオフセット state を足す自前実装にした (`visibleSlice`/`clampOffset`)
- 行入力: 実 TTY (raw mode が効く) では ink の `useInput` が stdin の唯一の
  消費者になり、文字編集・Enter による行確定・フォーカス切替・スクロールを
  すべて担う。非 TTY (テスト・パイプ) では `useInput` は inert なので
  `node:readline` (`terminal: false`) が行確定を担う。どちらの経路でも確定
  行は共通の直列化キューを通し、「複数行が来たら順に処理される」「EOF/quit
  では処理中のキューを待ってから終了する」という保証を維持する
- ロガー差し替え: `runLocal()` はローカル専用に `pino(..., passThroughStream)`
  で別インスタンスを作り、共有の `rootLogger` (Slack 起動経路) には触れない。
  その PassThrough を `startRepl` に `logStream` として渡し、ログペインが
  NDJSON を読んで整形する
- 引数解釈: `dump` サブコマンドと同じ argv 直読み

## 5. スコープ外 / 将来

- **シナリオ再生**: 入力を Readable stream として抽象化しておき、将来
  `local --script <file>` で「イベント列 + sleep」を流せるようにする
  (連鎖アラートのような時間の絡む再現手順のファイル化)。v1 は REPL のみ
- 複数行入力 (heredoc 等) は v1 では持たない。1 行 = 1 メッセージ
- 添付ファイル (Attachment) の注入は未対応 (Slack 側も処理未実装のため)
