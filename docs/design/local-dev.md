# Local Development

特定の実行環境を前提とせず、デプロイしなくてもローカルで動作を確認できるようにする
([design.md](../design.md) Portability)。Runner のパイプラインはそのままに、チャット接続と
State の実装だけを差し替える。

## 1. 確認手段の使い分け

| 手段 | Agent | チャット | State | 用途 |
|---|---|---|---|---|
| vitest | フェイク | フェイク | memory | ロジックの回帰テスト |
| `test:e2e` | 本物 | in-memory chat | memory / sqlite | 実 LLM を叩く回帰確認。`E2E_LIVE_LLM` で opt-in、CI では回さない |
| `test:e2e:sandbox` | probe (シェルを実行する pi のスタブ) | in-memory chat | memory | srt sandbox ([runtime.md](runtime.md) §5.5) の遮断を Docker (Linux + bubblewrap) で決定的に確認。CI でも回す |
| `dev:local` | 本物 | in-memory chat + TUI | memory / sqlite | 手元での確認 |
| `dev:socket` | 本物 | Slack (Socket Mode) | sqlite / firestore | 公開前の実機確認 |

vitest はフェイクの Agent で回すため、「本物の Agent と本物の設定で挙動を見る」層が要る。
`dev:local` と `test:e2e` がそこを埋める。実際の mrkdwn の見た目、ファイルアップロード、
rate limit のように実 Slack でしか確認できないものは `dev:socket` で行う。

`test:e2e` のスイートは `test/e2e/` に置く。Runner をライブラリとして (`startRunner` を
直接呼んで) 起動し、in-memory chat の core に post/react して返信・リアクションを待つ。
TUI も Slack も通さないので、`dev:local` で手で叩いていた確認をそのまま自動化できる —
mention 起動、実行中 Session への steering、`/new` `/disable` `/enable`、Gate の種別ごとの
判定、再起動をまたぐ再開、affinity の合流と窓切れ、debounce による連投のまとめと mention に
よるバイパス、linger 中の継続と満了後の起こし直し、lease による 2 プロセス間の排他が
1 シナリオ 1 ファイルで並ぶ。実 LLM を叩いて課金が発生するため
`E2E_LIVE_LLM` が設定されたときだけ走り、それ以外では skip として現れる。認証情報と
`PI_AGENT_HOME` は `.env.local` から読む。

Dispatcher の判断 (debounce の遅延、合流先の選択、lease が取れなかったこと) は返信本文に
現れないので、ヘルパー (`test/e2e/helpers/live.ts`) が Runner の pino ログを配列に集め、
Control State をそのまま公開する。シナリオは「どのスレッドに返ったか」「どのログが出たか」
「Session レコードがどうなっているか」で確かめ、LLM の文面には依存させない。linger や
`windowSec` のように待ち時間が支配的なものは、本番既定より短い値を `startLiveRunner` に
渡して回す。

`test:e2e:sandbox` のスイートは `test/e2e-sandbox/` に置く。LLM は使わず、Runner の本物の
spawn 経路 (settings ファイル → `srt --settings` → bubblewrap → 子) を
通して、子に pi のスタブ (`test/fixtures/probe-pi.mjs`) を起動する。スタブは最初の prompt に
書かれたシェルコマンド列を実行して exit code と出力を reply で返すだけなので、allowlist の
通過・拒否、他 Session の Workdir への EROFS、env の隠蔽、turn timeout 後にプロセスが
残らないことを厳密に assert できる。遮断の項目には必ず対照 (同じコマンドが許可側で通る) を
添える — 「全部 blocked」は設定ミスでも出るため。bubblewrap が要るので Docker の `e2e`
ステージで回し、`--cap-add SYS_ADMIN --security-opt seccomp=unconfined
--security-opt apparmor=unconfined --security-opt systempaths=unconfined` を渡す
(user namespace と `/proc` の mount のため)。ホストに bubblewrap が無ければ skip する。
srt を実 pi + 実 LLM で通す確認は `test/e2e/sandbox.test.ts` (`test:e2e` 側、Linux のみ)。

設定は YAML ではなくテスト専用の `ConfigSource` (`test/e2e/helpers/static-config-source.ts`)
に TS オブジェクトで渡す。シナリオごとの `channels` をファイルを増やさずに書けるようにする
ためで、マージ自体は `resolveChannelConfig` をそのまま呼んで `FileConfigSource` と共有する。
本番のローダー実装は `FileConfigSource` 1 つだけ ([config.md](config.md) §3) という前提は
変えない。

```sh
pnpm run dev:local     # in-memory chat + TUI (.env.local)
pnpm run dev:socket    # Slack Socket Mode (.env.socket)
node dist/server.mjs local [channelId]  # ビルド済みバイナリから
```

- 設定ファイルは `CONFIG_PATH` から読む。未設定なら `examples/config/agent.yaml`
  (コンテナイメージにも同梱するため、何も設定しなくても起動できる)。
- `channelId` は Channel Config のキーとしてそのまま使われる。既定は `local`。実在する
  チャンネルの ID を渡せば、その Channel Config での挙動を確認できる。
- `dev:local` は watch しない。再起動のたびに TUI と Control State が飛ぶため。
- Agent は本物が起動する。必要な環境変数は `.env.local` に置く。`system.runtime` の
  uid 分離は `dev:socket` と同じ扱い ([runtime.md](runtime.md))。

差し替えるのは Runner に渡す `ChatPlatform` だけで、Gate 以降には local 専用の分岐を
持ち込まない ([architecture.md](architecture.md) §3, §4)。

## 2. in-memory chat

Slack の代わりに、プロセス内で完結するチャット実装を注入する。I/O を持たないプログラマブルな
core と、それを端末に繋ぐ TUI の 2 層に分ける。core は e2e テストからそのまま使え、TUI は
core の一利用者でしかない。

core が提供する 5 つの seam は、すべて**同一のメッセージログ**を裏打ちにする。

| seam | 実装 |
|---|---|
| Ingress | `post()` / `react()` で合成したイベントを onEvent へ流す |
| 送信 | 投稿と更新をログに積み、変化を通知する |
| Turn 状態のリアクション | ログ上の記録と通知にする |
| user の解決 | 固定マップ (`U_LOCAL` → `you` など) |
| メッセージ取得 | 自前のメッセージログから解決する |

1 つのログを共有するのは、bot の投稿もログに積むことで「bot の投稿へのリアクションによる起動」や
「bot の投稿へのスレッド返信」が実チャットと同じに動くため。bot の投稿は `isSelf: true` で
記録するが、`ChatEvent` としては還流させない (自己エコー経路を持たない)。`start()` 前に post
された分はバッファし、start 時に順に流す。

core のプログラマブル API は `post(text, options?)` / `react(ts, emoji)` / `log()` / `bySeq(n)` と
変化通知の EventEmitter。TUI は描画に、e2e テストは「返信が来るまで待つ」のに使う。

mrkdwn 変換と mention 記法は差し替えない。「実際に投稿される整形済みテキスト」がそのまま
見えることを優先する。

**ID 形式**: メッセージの ts はログ連番の文字列表現 (`"1"`, `"2"`, …) で、画面表示の `[N]` と
同一。Session のキーは `local:3` のようになり、ログペインと会話ペインを直接突合できる。

## 3. TUI

画面は ink (React ベースの TUI) で上下 2 ペイン (上: log、下: chat) に分け、最下行を入力欄にする。
構造化ログと会話が同じ stdout に混ざると読めないための分離。

```
┌ logging ─────────────────────────────┐
│ INFO  [session] session start sess…  │
│ DEBUG [pi] agent_start sessionKey=…  │
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

- log ペイン: local 用に生成した logger の NDJSON を受け取り、`LEVEL [tag] head key=val ...` に
  整形して表示する。level・tag・fields を色分けし、Agent 子プロセス由来のログは tag を
  `[pi]` に付け替えて Runner 自身のログと区別する。長い行は端末幅で折り返す。
- chat ペイン: メッセージに `[N]` を付ける。スレッド返信は `[N]↳M`、メッセージ更新 (進捗通知の
  上書き) は `[N]↺`、mention は本文先頭に `@bot` を復元する。`files` はパスの列挙のみで
  アップロードはしない。bot 由来の行は色を変える。
- 入力欄: Enter で確定した行をロジック層に渡す。`@bot` の前方一致のときだけ Tab で補完し、
  有効なメタコマンドは入力中に色が付く。
- フォーカス: Tab / Shift-Tab で input → log → chat を巡回し、Escape で input に戻る。各ペインは
  末尾追従が既定で、フォーカス中のペインをスクロールバックできる。マウスホイールはフォーカスに
  関係なくカーソル下のペインをスクロールする。

描画のロジック (行のパース・状態・整形) と画面 (React コンポーネント) は別モジュールに分け、
ロジック側を ink 無しで単体テストできるようにする。実 TTY では ink が stdin の唯一の消費者に
なり、非 TTY (テスト・パイプ) では readline が行確定を担う。どちらの経路でも確定行は共通の
直列化キューを通し、複数行が順に処理されること・終了時に処理中のキューを待つことを保つ。

## 4. TUI の文法

### 入力 → ChatEvent

| 入力 | 意味 |
|---|---|
| `text` | チャンネル直下投稿 (`mentionsBot: false`) |
| `@bot text` | mention 付き投稿 (`mentionsBot: true`、prefix は除去) |
| `>N text` | メッセージ N の Thread への返信 |
| `>N @bot text` | Thread 返信 + mention |
| `>ts:X text` | 生 ts `X` の Thread への返信 (無検証) |

`N` は表示に付く連番で、ts そのもの。ログに実在しない `N` は typo 保護のためエラーにする。
`ts:X` は実在しない ts も許す — Runner が観測していない過去メッセージへの Thread 返信は
実チャットでふつうに起きるため。`/new` などのコマンドは通常のメッセージ本文としてそのまま流れ、
Runner 側で解釈される ([session-model.md](session-model.md))。

### メタコマンド (`!` prefix、ChatEvent にならない)

| コマンド | 意味 |
|---|---|
| `!react <N\|ts:X> <emoji>` | リアクションを注入する |
| `!thread <N\|ts:X>` (alias `!t`) | Thread に入る (以降の通常投稿がそこへ) |
| `!leave` | Thread から出てチャンネル直下に戻る |
| `!channel <id>` | 投稿先チャンネルを切り替える |
| `!channels` | 設定ファイルの Channel 一覧を表示する (現在の投稿先に `(current)`) |
| `!dm on\|off` | `conversation.isDm` を切り替える (DM の Gate 確認用) |
| `!user <id> [--bot]` | 発言者を切り替える。`--bot` で `isBot: true` (`allowBots` 確認用) |
| `!quit` (alias `!exit`) | 終了 (Ctrl-D も同じ) |
| `!help` | メタコマンド一覧を表示する |

`isSelf` は常に false。bot の投稿をイベントとして還流させないため、自己エコー経路が存在しない。

## 5. State のローカル設定

Control State は `system.state.control.backend` で選ぶ ([config.md](config.md))。

- `memory`: プロセス内。再起動で消える。1 回きりの挙動確認向け。
- `sqlite`: ローカルファイル 1 つ。Session の再開・affinity・Channel の有効状態が再起動をまたいで
  残るため、Control State に依存する挙動をローカルで確認できる。起動時にディレクトリを作る。
- `firestore`: エミュレータ (`FIRESTORE_EMULATOR_HOST`) を立てればローカルでも動く。backend 契約は
  3 実装で共通のテストスイートが保証する ([state.md](state.md))。

Agent State は `system.state.agent` の保存先ディレクトリを設定すると、Session の Workdir が
Turn の境界で退避・復元される。未設定なら退避せず、プロセスが終わると消える。

## 6. 実装対応

| 設計上の名前 | 現在のソース |
|---|---|
| `local` サブコマンド | `runLocal` (`src/server.ts`) |
| 実 LLM e2e スイート | `test/e2e/` (`startLiveRunner` / `StaticConfigSource`) |
| srt sandbox e2e スイート | `test/e2e-sandbox/` (`startSandboxRunner`)、pi スタブは `test/fixtures/probe-pi.mjs`、Docker の `e2e` ステージ (`Dockerfile`) |
| in-memory chat の契約 | `LocalChat` (`src/chat/local/types.ts`) |
| in-memory chat の実装 | `createLocalChat` (`src/chat/local/local-chat.ts`) |
| ChatPlatform への束ね | `createLocalPlatform` (`src/chat/local/platform.ts`) |
| TUI のロジック層 | `src/chat/local/repl-logic.ts` |
| TUI の画面 | `src/chat/local/repl.tsx` (`App` / `startRepl`) |
| Control State backend の選択 | `buildControlState` (`src/server.ts`) |
| 設定ファイルの既定パス | `DEFAULT_CONFIG_PATH` (`src/server.ts`) |
| 既定チャンネル ID | `DEFAULT_LOCAL_CHANNEL_ID` (`src/server.ts`) |
