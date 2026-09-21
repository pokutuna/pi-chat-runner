# Message Dispatch

Dispatcher は Inbox に届いたメッセージを処理する Session を決め、その Session を排他的に
起動または再開する。この一連の処理を Message Dispatch と呼ぶ。

Channel / Thread / Session / Turn の定義は [session-model.md](session-model.md)、
Inbox・lease・Session 実行状況の保存は [state.md](state.md)、
Workdir の準備と Agent プロセスの起動は [runtime.md](runtime.md) を参照。

## 1. 全体の流れ

```
message / reaction
  │
  ├─ Channel 有効状態の確認 ────────── disabled なら drop
  ├─ コマンド判定 ──────────────────── /new /enable /disable ([session-model.md](session-model.md))
  ├─ 実行中 Session への配送 ────────── あれば enqueue → steer して終了 (Gate を省略)
  ├─ Gate 評価 ─────────────────────── trigger しなければ drop (enqueue もしない)
  ├─ affinity 合流先の解決 ─────────── 合流先が生きていれば enqueue → steer して終了
  ├─ Inbox へ enqueue (dedupe) 
  └─ debounce または即 dispatch
       └─ lease 取得 → Session の起動 / 再開
```

Session の選択は sessionKey の導出 ([session-model.md](session-model.md)) → Thread → Session
対応の解決 → affinity 合流の解決、の順で行う。

reaction による起動も同じ順序をとる。Gate を通過したときにだけ対象メッセージ本文を取得して
message と同じ形に変換し、以降の経路 (steer / affinity / enqueue / dispatch) に合流する
([ingress-egress.md](ingress-egress.md))。

## 2. 実行中 Session への配送と Gate

実行中 (起動中を含む) の Session があるメッセージは、既定で Gate を省略して届ける。
すでに始まっている会話への追加入力を、起動条件で再び篩にかけないため。

`trigger.whileRunning` で切り替える ([config.md](config.md))。

| 値 | 動作 |
|---|---|
| `passthrough` (既定) | 実行中 Session への message は Gate を評価せず enqueue → steer |
| `evaluate` | 実行中でもメッセージごとに Gate を評価する |

Channel 有効状態の確認はどちらの場合も Gate より前に行う。無効中は steer も Gate 評価も
行わずに捨てるので、classifier gate の LLM 呼び出しが走ることはない。

Gate を通過しなかったメッセージは Inbox に積まない。永続キューに全メッセージを溜め込まないため。

## 3. Session の選択

### 3.1 Thread → Session の対応

sessionKey は Thread から決定的に導出する ([session-model.md](session-model.md)) が、affinity で
合流した Thread はそれとは別の Session に属する。Dispatcher は Control State の Thread → Session
対応を先に引き、あればその Session を、なければ導出した sessionKey を使う。

### 3.2 affinity

affinity はメッセージを既存の Session に合流させる仕組みで、別々の Thread に届いた一連の
メッセージを同じ会話として処理するためにある。連鎖するアラートが典型で、合流しないと 1 つの
障害に対して独立した Session が N 本立ち、互いを知らないまま同じ調査を重複実行する。

```yaml
session:
  mode: thread
  affinity:
    scope: channel    # session (既定 = 合流しない) | channel
    windowSec: 600    # Session 終了後もこの秒数は合流できる。既定 0
```

| scope / mode | 挙動 |
|---|---|
| channel / channel | Channel 全体が常に 1 Session。合流は自明 (同じ sessionKey) |
| channel / thread | Thread ごとに Session を作るが、Channel 内に直近の Session があればそこへ合流 |
| session / thread | 合流しない (既定) |

合流先の解決 (`scope: channel` のとき):

1. 対象は Gate を通過した**チャンネル直下**の投稿のみ。スレッド内の発言はそのスレッドの
   Session に属する意図が明確なので合流対象にしない
2. Channel の直近 Session が生きていれば (debounce 待機 / 起動中 / 実行中 / linger 中)、
   窓に関わらずその sessionKey を配送先にする
3. 終了済みなら、終了時刻から `windowSec` 以内のときだけ配送先にする。終了時刻が記録されて
   いない場合は最終活動時刻で保守的に判定する
4. どれにも当たらなければ、自分のメッセージを根にした新しい Session を作る

境界規則:

- **mention は合流をバイパスしない**。mention がバイパスするのは debounce の遅延だけで、
  どの Session に届くかは変えない
- **`/new` は合流しない**。明示的に新規で始める逃げ道になる ([session-model.md](session-model.md))
- **判定は時間窓だけで行う**。合流するかを classifier に委ねない — 誤爆時の説明可能性を
  判定規則の決定性で担保する
- **返信先は変わらない**。Thread Key はメッセージごとに発行されるので、合流したメッセージへの
  返信は元のスレッドに返る ([session-model.md](session-model.md))

合流が起きたとき、そのメッセージの Thread → 合流先 sessionKey の対応を Control State に記録する。
以降そのスレッド内の発言は §3.1 の解決で合流先 Session へ届き、Runner の実行インスタンスが
入れ替わっても対応は保たれる。

Channel の直近 Session は Control State に 1 件だけ持ち、O(1) で引く。Session の発生
(debounce 待機の開始・起動) と steer 配送、Turn の完了で更新する。走査ではなくこれを正とする
ことで、候補が複数あるときどれに合流するかも構造で決まる (= 最後に活動した Session)。

Inbox の dedupe は (sessionKey, item id) 単位なので、再配送が `windowSec` の境界を跨いで別の
合流先に解決されると重複処理が起きうる。チャットの再送間隔に対して窓の移動は稀なので許容し、
合流の結果をログに残すにとどめる。

## 4. debounce

debounce は Agent への配送を短時間待って近接したメッセージをまとめ、連投のたびに Agent を
起動せず 1 つの Turn で処理するための遅延である。`session.affinity.debounceSec` で設定する。

- Gate 通過 → Inbox への enqueue は即時に行い、**dispatch だけ**を Session ごとのタイマーで遅らせる
- 後続メッセージが来るたび「最後のメッセージ + `debounceSec`」までスライドする
- hard cap は「最初に滞留したメッセージ + `debounceSec` × 3」。スライドはこれを超えない
- `mentionsBot` のメッセージは明示的な呼び出しなので debounce をバイパスして即 dispatch する。
  同じ Session に保留タイマーがあればキャンセルする — 滞留分は Inbox にあるので初回 prompt の
  drain がまとめて配達する
- タイマー発火時に Channel 有効状態を再確認する。待機中に `/disable` されたら起動しない
- タイマー発火時に既に Session が起動していれば何もしない。滞留分は既存の drain が拾う

item は dispatch 前から Inbox に積まれているので、タイマーが失われても (プロセス死) 入力は
失われない。拾い直しは既存の Inbox 経路に乗る。

debounce は起動可否ではなく「確定した入力をどの Session・どの Turn に束ねるか」を決めるので、
`trigger` ではなく `session.affinity` に置く。`scope` に関わらず全構成で有効。

## 5. steering

steering は Turn を処理中の Agent に追加のメッセージを渡すことで、停止や返答を待たずに
進行中の処理へ入力を足すためにある。Session の状態によって扱いが変わる。

| Session の状態 | 扱い |
|---|---|
| starting (起動準備中) | enqueue のみ。初回 prompt の drain が拾う |
| running (Turn 実行中) | enqueue → steer で即時配達 |
| lingering (Turn 終了後の待機中) | enqueue のみ。linger の再確認が prompt で新しい Turn として拾う |

lingering で steer を使わないのは、steer の意味が「次の LLM 呼び出しの直前に注入」だからである。
agent_end 済みでアイドルな Agent へ steer を送ってもキューに積まれるだけで Turn は始まらない。

配達の起点は「イベントを受け取ったこと」そのもので、Inbox の変更通知を購読しない。steer の
注入粒度は Turn 境界なので、それより早く気づいても使い道がない。取りこぼしも起きない:

- 実行中の Session がいる → 次のイベント受信時の即時 drain、agent_end / linger の drain で拾う
- 拾う前にプロセスが死んだ → lease 失効 → 次の起動時の drain で拾う
- そもそも Session がいない → イベント受信が起動を駆動し、起動直後の drain で拾う

drain は非破壊で未 ack の item を全件返すため、prompt / steer 済みの item id をプロセス内で
覚えて除外する。

## 6. lease

lease は Session の実行を排他制御し、同じ Session を複数の Agent が同時に実行しないようにする。
実行インスタンスに親和性がない前提なので、プロセス内ロックではなく Control State に置く
([state.md](state.md))。

- Session の起動前に acquire する。取れなければ別のプロセスが保持中なので、enqueue だけ済ませて
  戻る — 保持者側の drain (steer / agent_end / linger) が拾う
- TTL は既定 60s。`leaseTtlMs / 3` の間隔で renew する
- fencing token を持ち、acquire (失効した lease の奪取を含む) のたびに単調増加する。renew と
  release は token と owner が現行と一致するときだけ成功する。ゾンビ保持者の書き込みは通らない
- **renew に失敗したら排他を失っている**。flush せずに Agent プロセスを止める。書き戻すと
  新しい保持者の作業を上書きしてしまう
- `/new` のマーカー書き込みも短時間 (10s) の lease を取って行う。取れなければ拒否を通知する
  ([session-model.md](session-model.md))

## 7. Session の起動と Turn 境界

### 7.1 起動

1. lease を acquire する (取れなければ enqueue のみで終了)
2. Workdir と Shared を準備し、Transcript の切り替えを判定する ([runtime.md](runtime.md),
   [session-model.md](session-model.md))
3. Agent プロセスを起動し、fallback Thread Key を Egress に登録する
   ([session-model.md](session-model.md))
4. Inbox を drain し、未処理の item を束ねて初回 prompt を送る。トリガーになったメッセージ自身も
   enqueue 済みなので drain 経由で届く。Channel Config の `context` は初回のみ先頭に注入する
5. Session 実行状況を Control State に記録する

同じ sessionKey は常に同じ Workdir と Transcript を使う。再開に専用のフローはなく、Transcript が
残っていれば Agent がそれを読んで会話を継続する。

起動の途中で失敗した場合は、タイマーとプロセスを片付け、lease を解放して Session の終了を記録する。
item は ack されないので、同じ Session への次のイベント (または再送) で拾い直される。

### 7.2 Turn 境界の順序

agent_end を受け取ったら、次の順序で処理する。

1. Workdir を退避先へ flush
2. Channel の Shared を flush
3. Inbox の ack
4. Turn の成否をリアクションで返す ([session-model.md](session-model.md))
5. Inbox に未処理があれば同じプロセスで次の Turn を開始する。無ければ linger

**flush → ack の順序が正**で、逆にするとプロセスが死んだとき入力が消える。ack の対象は
flush 前に取ったスナップショットで、flush の待ち時間中に steer で追加された item を
「そのターンの flush 前」として ack しない。

### 7.3 linger

linger は Turn の終了後も Agent プロセスと lease を短時間 (既定 3s) 維持する。続けて届く
メッセージへの応答を速め、Agent の再起動と Workdir の復元を減らすためにある。

- linger 満了の直前にもう一度 Inbox を確認し、未処理があれば prompt で新しい Turn を始める
- 無ければ Session 実行状況に終了を記録し、Agent プロセスを停止して lease を解放する。
  Channel の直近 Session に終了時刻を書き、以降は affinity の `windowSec` の起点になる
- linger 中も Session はレジストリに残るので、届いたメッセージは §5 の lingering として扱う

### 7.4 異常終了

**異常終了では flush しない。**Workdir と Shared は書き戻さず、その Turn で prompt 済みだった
item は ack して捨てる。

| 経路 | 契機 |
|---|---|
| プロセスの予期しない終了 | 実行中のまま Agent プロセスが exit した |
| コマンド失敗 | Agent が prompt/steer を受理できないと応答した (認証エラー等)。agent_end が来ないので能動的に畳む |
| Turn タイムアウト | prompt/steer から `turnTimeoutMs` (既定 600s) を超えて agent_end が来ない。Agent プロセスを kill する |
| lease 喪失 | renew に失敗した (§6) |

item を捨てるのは、残すと次のイベントの drain が巻き込んで同じ Workdir と Transcript で再び
失敗する毒ループになりうるため。同じ入力は再び失敗する可能性が高く、retry の価値が薄い。
異常終了は Thread Key に紐づく通知と失敗リアクションでユーザーに伝わるので、必要ならば
言い直せばよい。

lease 喪失だけは通知を出さない (排他を失っている以上、新しい保持者の応答と競合する)。

## 8. Inbox の dedupe

Inbox は Gate を通ったメッセージの耐久キューで、enqueue が dedupe を兼ねる。

- item の id は `metadata.eventId ?? event.id`。チャット側の再送は同じ event id で届くので
  これで冪等に吸収できる
- enqueue は積めたら true、同じ id を既に見ていれば false を返す。**ack 後も「見た」記憶は残る**
  ので、ack 済みの item が再送されても再処理しない
- drain は未 ack の item を enqueue 順に全件返す。削除しないので同じ item が再度返りうる。
  プロセス内の prompt 済み id と突き合わせて除外する (§5)
- Gate を通らないメッセージは enqueue しない (§2)

これにより、`at-least-once` な再配送と「lease 失効 → 別インスタンスが同じ Inbox を再 drain」の
両方を吸収する。

## 9. 実装対応

| 設計上の名前 | 現在の実装 |
|---|---|
| Dispatcher | `SessionRunner` (`src/session/runner.ts`) |
| Session (実行中の実体) | `ActiveSession` (`src/session/active-session.ts`) |
| Gate 評価 | `SessionRunner.handle` / `handleReaction` 内の `evaluateWhen` (`src/session/runner.ts`, `src/gate/gate.ts`) |
| `trigger.whileRunning` | 未設定。現在は passthrough の順序のみ実装 (`SessionRunner.trySteerExisting` が Gate より前) |
| Thread → Session 対応 | `SessionRunner` の `threadAlias` (プロセス内。Control State への永続化は未実装) |
| affinity 合流先の解決 | `SessionRunner.resolveAffinityTarget` (`src/session/runner.ts`) |
| Channel の直近 Session | `ChannelStateDoc.affinity` / `putSessionPointer` (`src/store/state/interfaces.ts`) |
| debounce | `SessionRunner.scheduleDebouncedKick` / `computeKickDelayMs` (`src/session/runner.ts`, `src/session/policy.ts`) |
| steering | `SessionRunner.trySteerExisting` / `ActiveSession.steerPending` |
| lease | `LeaseStore` (`src/store/state/interfaces.ts`)、`ActiveSession.#startRenewTimer` |
| Session の起動 (dispatch) | `SessionRunner.acquireLeaseAndKick` → `ActiveSession.start` |
| Turn 境界 (flush → ack → reaction → linger) | `ActiveSession.#onAgentEnd` |
| 異常終了 | `ActiveSession.#abnormalShutdown` / `proc.on("exit")` |
| Turn タイムアウト | `ActiveSession.#resetTurnTimeout` / `#timeoutSession` |
| Inbox と dedupe | `InboxStore` / `inboxItemId` (`src/store/state/`) |
