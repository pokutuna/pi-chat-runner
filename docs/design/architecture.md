# Architecture

[design.md](../design.md) の Core Components と Pipeline を、実装の配置まで落とした文書。
各ステージの内部は [ingress-egress.md](ingress-egress.md) / [message-dispatch.md](message-dispatch.md) /
[state.md](state.md) / [runtime.md](runtime.md) / [config.md](config.md) を参照する。

## 1. Core Components

Runner はメッセージの受信から応答までを束ねるアプリケーション全体であり、以下を組み合わせる。

| Component | 役割 | 参照 |
|---|---|---|
| Runner | パイプラインの組み立てと起動。System Config から実装を選び、各ステージを配線する | 本ファイル §3, §4 |
| Session | Agent との会話の単位。1 つ以上の Turn から成り、Transcript と Workdir を持つ | [session-model.md](session-model.md) |
| Runtime | Workdir・環境変数・Skill を整え、Agent を子プロセスとして起動する実行環境 | [runtime.md](runtime.md) |
| Agent | Runtime 上で動くコーディングエージェント。`reply` tool で応答する | [runtime.md](runtime.md) |
| Control State | Runner がメッセージの配送と Session の実行を制御するためのデータ | [state.md](state.md) |
| Agent State | Agent がファイルシステムとして読み書きするデータ (Transcript / Workdir / Shared) | [state.md](state.md) |

Runner は Control State を参照して対応する Session を作成または再開し、必要に応じて Agent State を
復元して Runtime を通して Agent を起動する。Agent State と Control State をプロセス外に置くため、
Runner の実行インスタンスが入れ替わっても Session を再開できる。

## 2. Pipeline

Runner は 1 つのメッセージを次の順に通す。各ステージは隣のインタフェースだけを知り、
その背後の実装を知らない。

```
Chat (Slack / local)
    │  raw event
    ▼
Ingress      受信と正規化 → ChatEvent                        src/ingress/
    │  ChatEvent
    ▼
Gate         Agent の処理対象にするか判定                      src/gate/
    │  ChatEvent (通過分のみ)
    ▼
Inbox        Control State 上の耐久キュー。重複受信を吸収      state.md
    │  InboxItem
    ▼
Dispatcher   Session を決め、lease を取り、Session を起動/再開  message-dispatch.md
    │  Turn の入力
    ▼
Agent        Runtime 上で処理し reply(thread_key, text, files?) を呼ぶ
    │  reply payload
    ▼
Egress       Thread Key から送信先を解決し、チャット用に整形して送る  src/egress/
    │
    ▼
Chat
```

- Ingress と Egress の外にはチャットアプリケーション固有の API とデータ構造を出さない。
  Gate 以降は `ChatEvent` と Thread Key しか見ない。
- Gate は Ingress と Inbox の間にある独立したステージで、Channel Config の条件木を評価する
  ([config.md](config.md))。実行中の Session へのメッセージは Gate を常に通すのが既定で、
  Channel Config で毎回評価に変えられる ([message-dispatch.md](message-dispatch.md))。
- Inbox は Gate を通ったメッセージだけを保持する。Agent の起動や処理が失敗してもメッセージは
  残り、次の Turn で再度配送される。
- Dispatcher から下は「どのチャットから来たか」を知らない。応答の宛先は Thread Key で表現され、
  実体 (channel / thread) の解決は Egress が持つ。

## 3. 起動時の実装選択

差し替え可能な部分は System Config で起動時に 1 つ選ぶ。複数実装の同時使用や実行中の切り替えは
行わない ([config.md](config.md))。

| 選択肢 | System Config | 実装 |
|---|---|---|
| チャット接続 | `system.chat.slack.mode: socket` | Socket Mode (WebSocket)。ローカル・お試し |
| | `system.chat.slack.mode: events` | Events API (HTTP push)。Cloud Run 等にデプロイする場合 |
| | `local` サブコマンド | in-memory chat + TUI ([local-dev.md](local-dev.md)) |
| Control State | `system.state.control.backend: memory` | プロセス内。単発の確認用 |
| | `sqlite` | ローカルファイル。手元での永続確認 |
| | `firestore` | 複数インスタンスでの排他を含む運用構成 |
| Agent State | `system.state.agent.workdirDir` / `sharedDir` | 未設定なら退避なし。設定するとそのディレクトリへ保存・復元 |
| Runtime | `system.runtime` (uid/gid/home/permissionMode/allowAddons) | Agent 隔離の強度 ([runtime.md](runtime.md)) |

Slack と Google Cloud (Cloud Run / Firestore / Cloud Storage) を第一の想定動作環境として同梱するが、
パイプラインはそれらを前提にしない。どの組み合わせでも Gate 以降の挙動は同じになる。

## 4. モジュール配置

```
src/
  runner.ts        Runner (composition root)。パイプラインの配線
  server.ts        CLI エントリ。System Config を読み、実装を選んで Runner を起動
  chat/            チャット実装の束 (ingress + poster + reactor + userResolver + 整形)
    slack.ts       Slack 実装
    local/         in-memory chat と TUI (local-dev.md)
  ingress/         Ingress: 受信・正規化・重複吸収・user 解決 (ingress-egress.md)
    slack/         Slack の transport (HttpIngress / SocketIngress) と codec
  gate/            Gate: 条件木の評価と個別 gate (mention / keyword / classifier / reaction / sender)
  dispatch/        Dispatcher: Session 選択・debounce・steering・lease・コマンド
  session/         Session: Turn の駆動と境界処理
  runtime/         Runtime: Agent の準備と子プロセス起動 (runtime.md)
  egress/          Egress: Thread Key の宛先解決、整形、chunk、reaction、進捗通知
  state/
    control/       Control State とその backend (memory / sqlite / firestore)
    agent/         Agent State (Workdir / Shared の保存・復元)
  config/          System / Channel / Agent Config のスキーマと解決 (config.md)
  classifier/      classifier gate 用の LLM client
```

`design.md` のコンポーネント名はレイヤの名前であり、1 モジュール 1 コンポーネントを意味しない。
1 つのコンポーネントが複数モジュールに分かれるのは構わないが、別コンポーネントの責務が
混ざるのは避ける。例えば Runtime は Control State を読み書きせず、Ingress は Session を知らない。

## 5. Ingress の抽象

Ingress は「イベントがどう届くか」と「どう ACK するか」だけを抽象化する。

```typescript
type Ack = () => Promise<void>;

interface Ingress {
  /** 受信を開始する。onEvent は Gate → Inbox → Dispatcher の共通パイプライン */
  start(onEvent: (e: ChatEvent, ack: Ack) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}
```

- ACK の意味は経路ごとに違う。Events API では 200 レスポンスを返すこと、Socket Mode では
  `ack()` コールバックを呼ぶこと。`Ack` がその差を吸収するので、後段は「積む前に ack する」
  とだけ書けばよい。
- transport (`HttpIngress` / `SocketIngress`) と codec (raw payload → `ChatEvent` の正規化) は
  別の層で、両 transport が同じ codec を共有する。チャットアプリケーションを増やすときは codec を、
  受信経路を増やすときは transport を書く ([ingress-egress.md](ingress-egress.md))。
- ack 後の残処理 (Gate 評価、Inbox への積み込み、Session の起動) は同じプロセスで継続してよい。
  ack と処理完了を分離しているので、処理が長引いてもチャット側のタイムアウトには影響しない。

## 6. event と session の分離

event は「きっかけ」であり、処理の主体は Session である。event を受けたハンドラは応答を作らない。

| 主語 | 行うこと |
|---|---|
| event | ack → 正規化 → Gate 判定 → 通れば Inbox に積む。lease が生きていれば積むだけで降りる |
| Session | Inbox を drain して Turn を回す。lease で 1 Session 1 実行に排他する |

この分離が無いと event 単位の処理になり、連投が多重起動と文脈の分断を起こす。分離することで
「連投を 1 つの Session にまとめる (affinity / debounce)」「実行中の追加入力 (steering)」
「インスタンスが増えても同じ Session は 1 つだけ実行される (lease)」が同じ仕組みで成立する
([message-dispatch.md](message-dispatch.md))。

長時間経過後の Thread への追加メッセージも同じ経路を通る。Session が Control State に残って
いて lease が無いだけなので、専用の再開フローを持たない。

## 7. 単一サービスでスケールアウトする

Runner は 1 つのサービスとして動かし、受信と実行を分離するキューや中継サービスを置かない。

- 負荷が上がるとチャットからのイベント流入が増え、実行環境が自動でインスタンスを増やす。
  増えたインスタンスはそれぞれ別の Session の lease を取って並行に実行する。負荷が無ければ
  インスタンスはゼロまで落ちる。
- 同じ Session を 2 つのインスタンスが同時に実行しないことは lease が保証する。lease を
  取れなかったインスタンスは実行に入らず、積んだ入力は lease を持つ側が次の Turn 境界で拾う。
- 3 秒 ACK と長い実行の分離、起動の冪等化、リトライは、それぞれ `Ack` 抽象・Inbox の
  イベント ID による dedupe・Inbox の耐久性が担う。中継が無いので、そこで取りこぼす箇所自体が無い。
- Agent State の書き戻しも 1 Session 1 ライターになるため、Session ごとにディレクトリが
  分かれていれば並行実行が衝突しない ([state.md](state.md))。

二重投稿の防止はこの構造から 2 つの仕組みに集約される。

1. 受信の dedupe: Inbox のキーをイベント ID にし、既存なら積まない ([state.md](state.md))
2. Session の排他: lease。同じ Session の Turn を 2 つのインスタンスが同時に走らせない

Agent の確定出力が `reply` tool の 1 経路しかなく、地の文を送信しないため、送信側の冪等化は
別途必要にならない。進捗通知は同じメッセージを更新するので、それ自体が冪等である
([ingress-egress.md](ingress-egress.md))。

## 8. 実装対応

| 設計上の名前 | 現在のソース |
|---|---|
| Runner (composition root) | `startBridge` / `BridgeOptions` (`src/bridge.ts`) |
| CLI エントリ | `src/server.ts` (`main` / `runLocal` / `runDump`) |
| Ingress interface / Ack | `src/ingress/ingress.ts` |
| HttpIngress / SocketIngress | `src/ingress/slack/{http-ingress,socket-ingress}.ts` |
| Ingress の codec | `SlackIngressAdapter` (`src/ingress/slack/adapter.ts`) |
| Gate | `src/gate/gate.ts`, `src/gate/gates/*.ts` (評価の呼び出しは `SessionRunner.handle`) |
| Dispatcher | `SessionRunner` (`src/session/runner.ts`) |
| Session | `ActiveSession` (`src/session/active-session.ts`) |
| Runtime | `src/session/{spawn,runtime,rpc,pi-events,prompt,session-file}.ts` |
| Egress | `src/egress/` (`EgressRouter`, `chunker.ts`, `mrkdwn.ts`, `turn-reactor.ts`) |
| Control State | `ControlState` (`src/state/control/interfaces.ts`) と `src/state/control/backends/` |
| Agent State | `WorkdirStore` / `SharedStore` (`src/state/agent/`) |
| System Config の読み込み | `src/config/{connector-config,store-config,agent-config}.ts` |
| Channel Config | `ChannelDoc` (`src/config/channel-doc.ts`) |
