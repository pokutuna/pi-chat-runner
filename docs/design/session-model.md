# Session Model

チャット上のメッセージを Agent の会話と実行に対応づけるモデル。
Channel / Thread / Session / Turn の定義、Session の境界の決め方、返信先の解決、
Session を操作するコマンドを扱う。

Session をどう選び、どう排他的に起動するかは [message-dispatch.md](message-dispatch.md)、
Transcript と Workdir の保存場所は [state.md](state.md) を参照。

## 1. Channel / Thread / Session / Turn

| 概念 | 定義 | 寿命 |
|---|---|---|
| Channel | メッセージが流れてくる経路。Agent の設定単位 | 恒久 (チャット側の存在) |
| Thread | Channel 内でのメッセージの流れ。Slack ではチャンネル直下の列と返信スレッド | 恒久 (チャット側の存在) |
| Session | Agent の会話の単位。Transcript と Workdir を持つ | 1 つ以上の Turn |
| Turn | Agent に入力を渡してから応答完了の通知を受けるまでの実行上の区切り | 1 回の prompt/steer 〜 agent_end |

Channel と Thread はチャットアプリケーション側の構造、Session と Turn は Runner 側の構造で、
両者は 1:1 で対応しない。Thread と Session の対応は Dispatcher が決める
([message-dispatch.md](message-dispatch.md))。

- 1 つの Session に複数の Thread のメッセージが含まれうる (channel mode、affinity 合流)
- 1 つの Thread から複数の Session が生まれうる (`/new`、Session の終了条件)

Channel は設定の単位でもある。DM は実 channelId ごとに Session を持つが、設定は予約名 `dm`
の Channel Config を全 DM 共通で参照する ([config.md](config.md))。

## 2. session.mode と reply.mode

「どこまでを一続きの会話として扱うか」と「どこへ返すか」は独立した 2 軸として設定する。

| session \ reply | thread | flat |
|---|---|---|
| thread | 既定。通常のチャンネル向け | 文脈が切れるのに返信だけ散る。設定できるが警告する |
| channel | 文脈はチャンネルで 1 本、返信は話題ごとのスレッド | DM 等、スレッドを使わない場 |

- `session.mode`: Session を新規に作るときの単位
  - `thread` — Thread ごとに Session を作る (既定)
  - `channel` — Channel 全体を 1 つの Session にする
- `reply.mode`: チャンネル直下のトリガーへの返信先
  - `thread` — トリガーメッセージを root にした新しいスレッドへ返す (既定)
  - `flat` — チャンネル直下へ返す

DM (予約名 `dm`) の既定は `session: channel` + `reply: flat`。追加設定なしで
「1 つの続いた会話」になり、Transcript の prefix が再利用されて implicit prompt cache も効く。

### 2.1 sessionKey

Session の同一性は sessionKey で表す。mode から決定的に導出し、時刻は含めない。

| session.mode | sessionKey |
|---|---|
| `thread` | `${channelId}:${threadTs ?? messageId}` |
| `channel` | `${channelId}` |

Workdir、Transcript、Inbox、lease はすべて sessionKey を単位とする。

## 3. Thread Key と返信先の解決

Thread Key は返信先を指すキーで、Session の区切りとは独立に**メッセージごと**に発行する。

```
threadKey = `${channelId}:${threadTs ?? messageId}`
```

sessionKey と同じ形をとるが意味は別で、`session.mode: channel` では 1 つの Session の中に
複数の Thread Key が併存する。Runner は Thread Key ごとの送信先を Egress に登録し、Agent は
入力に添えられた Thread Key から返信先を選んで reply tool を呼ぶ
([ingress-egress.md](ingress-egress.md))。

送信先の解決規則 (mode によらず固定):

| トリガーの位置 | reply.mode | 送信先 |
|---|---|---|
| スレッド内 | 不問 | そのスレッド (`threadTs`) |
| チャンネル直下 | `thread` | そのメッセージを root にした新しいスレッド (`threadTs = messageId`) |
| チャンネル直下 | `flat` | チャンネル直下 |

スレッド内で話しかけられたら `reply.mode` に関わらずそのスレッドへ返す。`reply.mode` が効くのは
チャンネル直下トリガーの返信先だけ。

Session には fallback の Thread Key として sessionKey 自体も登録する。送信先は
`session.mode: channel` かつ `reply.mode: flat` ならチャンネル直下、それ以外はその Session の
root スレッド。Runner 自身が出す通知 (異常終了など) と、Agent が Thread Key を取り違えた場合の
逃げ道に使う。

## 4. プロンプトへの描画

Agent への入力は、メッセージ 1 件ごとにヘッダと本文を持つ。

```
from: <displayName> (<userId>)
time: <ISO 8601>
thread_key: <threadKey>
---
<本文>
```

- `from` は表示名を解決できれば `name (ID)`、できなければ ID のみ。ID を常に併記するのは、
  Agent が返信中で mention を組み立てられるようにするため
- `time` は タイムゾーン付き ISO 8601
- `thread_key` はそのメッセージの返信先キー (§3)
- 1 つの Turn に複数のメッセージが載る場合は、この単位を空行 2 つで連結する

System Prompt には fallback Thread Key と「返信するメッセージの thread_key を使う」指示を含める
([runtime.md](runtime.md))。

## 5. コマンド

チャット本文で Session と Channel を操作する。本文を trim した結果で判定する純粋な解析で、
Gate を通過したメッセージにだけ意味を持たせる (mention gate の Channel では `@bot /new` の形になる)。
bot が送ったメッセージはコマンドにしない — bot に Session を切らせないため。

| コマンド | 形 | 意味 |
|---|---|---|
| `/new` | 完全一致、または `/new <テキスト>` | Transcript を切り替えて新しい Session を始める |
| `/enable` | 完全一致のみ | この Channel での起動を有効にする |
| `/disable` | 完全一致のみ | この Channel での起動を無効にする |

`/enable` `/disable` に後続テキストを許さないのは誤爆防止。

### 5.1 `/new`

`/new` は Control State の Session 実行状況に `rotateRequestedAt` マーカーを書くだけで、
その場では Transcript を切らない。マーカーは次の Session 起動時、Workdir の復元後に消費され、
そこで Transcript が切り替わる。即座に切らないのは、Workdir の退避先にまだ旧 Transcript が
残っており、次の復元で巻き戻ってしまうため ([state.md](state.md))。

新しい Transcript から始まる会話は新しい Session である。sessionKey は変わらないので、
Workdir と Channel の Shared は引き継がれ、切れるのは Transcript だけになる。

- マーカーの書き込みは短時間の lease を取って行う。取れない (= 実行中) なら拒否を通知する。
  同一プロセス上で実行中の Session が見えている場合も同様に拒否する — steer 経路と交錯させない
- `/new` 単体なら受理を通知するだけで Agent は起動しない。`/new <テキスト>` なら残りテキストを
  新しい Session の最初の入力として起動する
- `/new` は affinity で既存 Session に合流しない ([message-dispatch.md](message-dispatch.md))。
  誤合流からの逃げ道になる
- Channel が `/disable` されている間は `/new` も無効 (復帰経路ではないため)

### 5.2 `/enable` `/disable`

Channel 単位で Runner を止める運用スイッチで、Control State の Channel 有効状態を書き換える
([state.md](state.md))。効果は Channel 全体に及び、スレッド内で打っても同じ。既定は有効。

- 状態の書き込みだけで Session と競合しないため、実行中でも即座に反映する。実行中の Turn は
  完走し、以降の入力が届かなくなるだけ
- 無効中は Gate 評価も steer も行わずメッセージを捨てる。`/enable` `/disable` だけは素通しし、
  Gate (mention 等) を経て処理する — 無効中の復帰経路になる
- 冪等。既に同じ状態でも同じ受理通知を返す

## 6. Session の終了条件

Session が終わるのは、次の Session 起動時に Transcript を切り替えると判断したときである。

| 条件 | 設定 | 有効な mode |
|---|---|---|
| 明示 | `/new` | thread / channel |
| idle 超過 | `session.idleResetMinutes` | channel のみ |
| Transcript サイズ超過 | `session.maxTranscriptKb` | channel のみ |

判定は Session 起動時、Workdir の復元後に 1 回だけ行い、優先順位は 明示 → idle → サイズ。
1 回の起動で切り替えは最大 1 回。

- idle は前回活動時刻からの経過で判定する。時刻を sessionKey に入れず、リセットポリシーとして
  評価するため、窓の境界で Session の同一性が揺れない
- サイズは Transcript ファイルのバイト数で判定する。長さの上限自体は Agent 側の自動 compaction が
  守るので、これは「再開の初手で全履歴の要約が走る」コストを先回りして避けるための設定
- `thread` mode で `idleResetMinutes` / `maxTranscriptKb` が設定されていても切り替えは起きない。
  Session 起動時に警告ログを出して無視する

## 7. Turn

Turn は Agent への prompt または steer の送信で始まり、`willRetry` でない agent_end で終わる。
`willRetry: true` の agent_end は Agent 側の自動リトライの途中経過なので終端とみなさず、
成否判定も境界処理も次の agent_end に委ねる。

1 つの Turn には複数の入力メッセージが載りうる (debounce による束ね、実行中の steer、
linger 中に届いた分)。逆に 1 つの Session は複数の Turn を持つ。

### 7.1 Turn の成否

agent_end に含まれる最終 assistant メッセージの `stopReason` で判定する。`stop` のみを成功と
みなす whitelist で、それ以外 (`length` / `toolUse` / `error` / `aborted`) は失敗とする。
assistant メッセージが 1 件も無い Turn (沈黙のまま正常終了) は成功。

whitelist にするのは、LLM 呼び出しの失敗を Agent が `stopReason: "error"` の assistant
メッセージとして「正常に完走」させるため。blacklist だと失敗が成功に紛れる。

### 7.2 リアクション

リアクションは Turn 単位のフィードバックで、その Turn を起こした各メッセージに付ける。

| 時点 | 状態 |
|---|---|
| prompt / steer 送信 | 受理 |
| agent_end (`stopReason: stop`) | 成功 |
| agent_end (それ以外) / 異常終了 | 失敗 |

Turn に複数のメッセージが合流していれば全件に付く。Session の終了そのものにはリアクションを
付けない。リアクション対象の記録は Turn 単位の寿命で、Inbox の dedupe キー (Session 累積) とは
軸も寿命も別なので、1 つの器に相乗りさせない。

## 8. 実装対応

| 設計上の名前 | 現在の実装 |
|---|---|
| session.mode / reply.mode の解決 | `resolveSessionPolicy` (`src/session/policy.ts`) |
| sessionKey の導出 | `sessionKeyOf` (`src/session/policy.ts`) |
| Thread Key の導出 | `replyThreadKeyOf` (`src/session/policy.ts`) |
| 送信先の解決と登録 | `registerReplyDestination` (`src/session/reply-destination.ts`) |
| fallback Thread Key の登録 | `ActiveSession.start` (`src/session/active-session.ts`) |
| プロンプトへの描画 | `renderEvent` / `renderItems` (`src/session/policy.ts`) |
| System Prompt の組み立て | `buildSystemPrompt` (`src/runtime/prompt.ts`) |
| コマンドの解析 | `parseCommand` (`src/session/commands.ts`) |
| `/new` の処理 | `SessionRunner.handleNewCommand` (`src/session/runner.ts`) |
| `/enable` `/disable` の処理 | `SessionRunner.handleToggleCommand` (`src/session/runner.ts`) |
| Session の終了条件の判定 | `prepareWorkdir` / `isIdleExpired` (`src/runtime/prepare.ts`, `src/session/policy.ts`) |
| Transcript の切り替え | `rotateTranscript` (`src/runtime/prepare.ts`) |
| mode 不整合の警告 | `warnPolicyMismatches` (`src/runtime/prepare.ts`) |
| Turn の成否判定 | `turnStatusFromAgentEnd` (`src/runtime/pi-events.ts`) |
| リアクション | `ActiveSession.#beginTurnMessage` / `#reactMessages` (`src/session/active-session.ts`) |
| Session 実行状況 (SessionRecord) | `SessionRecord` (`src/state/control/interfaces.ts`) |
| Channel 有効状態 | `ChannelStateStore` (`src/state/control/interfaces.ts`) |
