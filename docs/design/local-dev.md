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

- `N` は表示に付く短い連番 (`[3]`)。生の ts も受け付け、**ログに存在しない
  ts も許す** (存在チェックしない)。runner が観測していない過去メッセージへの
  スレッド返信 (スレッド途中 mention 等) は Slack 実機でふつうに起きる入力で、
  その再現に必要なため
- `/new ...` や `/enable` などの**チャットコマンドは通常のメッセージ本文**
  としてそのまま流れる (runner 側で解釈される)。REPL 自身のメタコマンドは
  衝突しないよう `!` prefix にする

### メタコマンド (`!` prefix、ChatEvent にならない)

| コマンド | 意味 |
|---|---|
| `!react N <emoji>` | メッセージ N に ReactionEvent (added: true) を注入 |
| `!channel <id>` | 投稿先チャンネルを切替 |
| `!dm on\|off` | `conversation.isDm` を切替 (DM gate の確認用) |
| `!user <id> [--bot]` | 発言者を切替。`--bot` で `isBot: true` (allowBots の確認用) |
| `!quit` | 終了 (Ctrl-D も同じ) |

`isSelf` は常に false (poster の出力をイベントとして還流させないため、
自己エコー経路自体が存在しない)。

### 表示

画面は ink (React ベースの TUI) で左右 2 ペインに分割する。pino の構造化ログと
チャットの会話が同じ stdout に混ざって読みにくかったための分離。両ペインは
端末の高さいっぱい (入力欄 1 行を除く) を 50% ずつ使い、下段全幅が入力欄:

```
┌ log ──────────────────┐┌ chat ─────────────────┐
│ [server] INFO lease…   ││ [1 …000001] you: @bot… │
│ [runtime] INFO pi turn…││ ⟵ [2 …000002] bot:     │
│ [session] DEBUG gate…  ││    調査します。まず …    │
│                        ││ ⟵ (update [2]) bot:    │
│                        ││ ⟵ :eyes: on [1]        │
└────────────────────────┘└────────────────────────┘
#local you> _
```

- 左ペイン (log): server.ts が local mode 専用に生成する pino ロガーの
  出力を NDJSON のまま受け取り、`[component] LEVEL msg key=val ...` に整形
  して表示する。level に応じて色分けする (50 以上=赤、40=黄、それ以外=既定/gray)
- 右ペイン (chat): メッセージは `[N ts]` を付けて表示する。bot 投稿はスレッド
  位置がわかる形で出す。`updateMessage` (進捗通知の上書き) は `(update [N])`
  として再表示する。`postMessage` の `files` はパスの列挙のみ (アップロード
  はしない)。`isSelf`/bot の行は cyan で表示する
- 最下行が入力欄。Enter で確定した行は repl-logic.ts の `handleLine` に渡す
- スクロール: 各ペインは末尾追従 (最新を表示) が既定。矢印↑↓で 1 行、
  PageUp/Down で 1 ページぶんスクロールバックでき、末尾まで戻ると追従を
  再開する (スクロールバック中は新着で流されない)。Tab でスクロール対象の
  ペインを切り替え、フォーカス中のペインは枠線を cyan で示す。行の折り返しは
  せず端末幅で切る (truncate) — ペイン高さと実描画行数を一致させ、端末の
  表示可能行数を超えて ink が前フレームを消せなくなる残像化を防ぐため

### ID 形式

ts は Slack 互換の `<epochSec>.<6桁連番>` を単調増加で払い出す。sessionKey
(`channelId:threadTs`) や affinity の窓判定が本番と同じ形で動く。

## 4. 実装方針

- 画面描画: `ink` (React ベース TUI) + `react`。ログペイン/チャットペイン/
  入力欄を宣言的に描く。npm 依存として追加している (旧版は
  `node:readline` + `styleText` の素朴な逐次出力のみで新規依存なしだったが、
  2 ペイン化にあたり手組みするより ink を使う方が保守しやすいと判断した)。
  スクロールは ink 用の既製ライブラリがどれも生後半年未満の個人パッケージで
  `minimumReleaseAge` ポリシーに反するため導入せず、既存の「末尾 N 行 slice」
  表示にオフセット state を足す自前実装にした (`visibleSlice`/`clampOffset`)
- 行入力: TTY/非 TTY を問わず `node:readline` (`terminal: false`) で統一的に
  行イベントを受ける。ink の `useInput` (raw mode) は入力欄のキー入力プレビュー
  表示 (エコー) と、矢印/PageUp/Down によるスクロール・Tab によるペイン切替に
  使い、行確定処理そのものには関与させない。矢印は常にスクロールに割り当てる
  ので入力欄のカーソル移動には使えない (REPL 用途では十分)。これにより
  非 TTY 入力 (テスト・パイプ) でも「複数行が来たら順に処理される」
  「EOF (close) では処理中のキューを待ってから終了する」という旧実装からの
  保証を維持する
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
