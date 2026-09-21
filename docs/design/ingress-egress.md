# Ingress / Egress

チャットアプリケーション固有の API とデータ構造は Ingress と Egress に閉じ込める
([architecture.md](architecture.md) §2)。Gate から Session までの層は `ChatEvent` と
Thread Key しか見ない。

## 1. ChatEvent

Ingress が正規化して後段へ渡す唯一のデータ構造。プラットフォーム固有のフィールドは増やさず、
必要なら `raw` / `metadata` に逃がす。

```typescript
type ChatEvent = InboundMessage | ReactionEvent | MessageEdited | SystemEvent;

/** 会話 (返信先) の参照 */
interface ConversationRef {
  channelId: string;
  threadTs?: string;
  /** DM。Channel Config の予約名 dm の対象になる (config.md) */
  isDm?: boolean;
}

interface Sender {
  id: string;
  /** bot による投稿 (自分自身を含む) */
  isBot: boolean;
  /** 自分自身 (この bot) の投稿。Ingress が常に除外する */
  isSelf: boolean;
  /** 表示名。解決できたときだけ入る。無ければ id を使う */
  displayName?: string;
}

interface InboundMessage {
  kind: "message";
  id: string;                        // プラットフォームのメッセージ ID
  conversation: ConversationRef;
  sender: Sender;
  text: string;                      // bot 自身への mention は除去済み
  mentionsBot: boolean;              // 除去前の判定結果
  reply?: ReplyContext;              // 返信元の平坦化 (messageId / excerpt / author / isReplyToSelf)
  attachments: Attachment[];
  editedFrom?: string;
  timestamp: Date;
  raw?: unknown;                     // エスケープハッチ。永続化しない
  metadata: Record<string, unknown>; // 永続化してよい固有シグナル (eventId など)
}

interface ReactionEvent {
  kind: "reaction";
  emoji: string;                     // 正規化名 ("eyes", "+1")
  targetMessageId: string;
  targetIsOwnMessage: boolean;
  conversation: ConversationRef;
  sender: Sender;
  added: boolean;                    // true=付与 / false=除去
  timestamp: Date;
  raw?: unknown;
}
```

`MessageEdited` / `SystemEvent` は型として定義するが、現在は後段へ渡さず無視する。
`Attachment` も型のみで、受信時の取得と Workdir への配置は未実装。

## 2. Slack の正規化

transport (`HttpIngress` / `SocketIngress`) と codec は分かれており、両 transport が同じ codec を
共有する ([architecture.md](architecture.md) §5)。codec の規則は以下。

| Slack raw event | 正規化 |
|---|---|
| `app_mention` | `InboundMessage`。`mentionsBot: true` (Slack が確定済みの種別) |
| `message` (subtype なし) | `InboundMessage`。本文中の `<@bot>` の有無で `mentionsBot` を決める |
| `message` (`subtype: bot_message`) | `InboundMessage`。webhook 系アラートの入口。`username` があれば `displayName` に入れる |
| `message` (その他の subtype) | drop (`message_changed` / `message_deleted` / `thread_broadcast` 等) |
| `reaction_added` / `reaction_removed` | `ReactionEvent`。`added` で区別する |
| その他 | drop |

- mention 展開: 本文中の `<@U...>` を除去する。自分宛なら `mentionsBot` を立てて完全に消し、
  他ユーザー宛は `@U...` の形に残す。LLM が「その ID に連絡しろ」と誤読する事故を避けるため、
  bot 自身への mention は本文に残さない。
- `isBot` は `bot_id` の有無または送信者が bot 自身であること、`isSelf` は送信者が bot 自身で
  あること。`isSelf` は設定に関わらず Ingress が常に除外する (エコーの無限ループ防止)。
  他 bot の投稿はここでは弾かず、Gate の `allowBots` に委ねる。
- `isDm` は `channel_type === "im"`。`channel_type` が欠ける payload では channelId の
  `D` prefix で判定する。
- 会話の座標は `(channelId, threadTs)` の 2 つだけ。Thread に属さないメッセージは `threadTs` を
  持たない。
- dedupe 用のイベント ID は envelope の `event_id` を取り、`metadata.eventId` に入れて Inbox の
  重複排除に使う ([state.md](state.md))。

## 3. 二重配送の吸収

Slack では bot 宛の mention が `app_mention` と `message` の 2 イベントで届く。`event_id` は
別々なので Inbox の dedupe では吸収できない。Ingress はメッセージ ID (`channelId:ts`) の
集合を持ち、同じメッセージの 2 通目を drop する。集合は一定件数を超えたらクリアする
(長時間動き続けても無制限に増やさないため。再送はイベント ID で Inbox 側が弾く)。

この重複吸収は Slack の配送仕様に由来するので Slack の codec 側に置き、他のチャット実装には
持ち込まない。

## 4. user の解決

Gate の sender 条件は表示名での一致を扱い ([config.md](config.md))、Agent への入力にも
表示名が要る。Ingress は Gate 評価の前に `ChatEvent` を enrich する。

- `sender.id` を表示名に解決し、`sender.displayName` に入れる。解決できなければ元のまま残す。
- 本文中に残った `@U123` を `@name (U123)` に展開する。名前だけに置き換えると Agent が
  mention 記法を組み立てられなくなるため、ID を併記する。
- `ReactionEvent` は本文を持たないので sender だけ解決する。

解決は Slack の `users.info` を呼ぶ実装が担い、失敗時は `null` を返して元の値を保つ。
`@U123` の ID 形式はプラットフォーム依存なので、解決の実装側が持つ。

## 5. Egress: Thread Key から送信先へ

Agent は `reply(thread_key, text, files?)` だけで応答する。Thread Key は Agent にとって不透明な
文字列で、実際の送信先 (channel / thread) は Runner が握る ([session-model.md](session-model.md))。

```typescript
interface EgressDestination {
  channelId: string;
  threadTs?: string;   // 省略時はチャンネル直下へ投稿する
}

/** Thread Key → 送信先の登録と解決 */
register(threadKey: string, destination: EgressDestination): void;
```

- 登録は入力メッセージを Agent へ渡す時点で行う。Thread 内のトリガーは返信設定に関わらず
  その Thread へ返す。返信設定 (`reply.mode`) が効くのはチャンネル直下のトリガーだけで、
  `thread` ならトリガーメッセージ自身を親とする新しい Thread を起こし、`flat` ならチャンネル
  直下へ返す。
- 未知の Thread Key への `reply` は warn ログを出して drop する。Agent の引数間違いで
  Runner を落とさない。
- 出力は `reply` の 1 経路に統一し、Agent の地の文は送信しない。沈黙は「`reply` を呼ばない」で
  表現でき、専用のマーカーを持たない。出力経路が 1 本なので、二重投稿と宛先の曖昧さが
  構造的に発生しない ([architecture.md](architecture.md) §7)。
- `reply` は 1 つの Turn の中で何度でも呼べる。別々の事象は別々の `reply` として、必要なら
  別の Thread Key へ返す。

## 6. 整形と分割

`reply` のテキストは送信前に次の順で処理する。

1. **mrkdwn 変換**: GFM Markdown を Slack の mrkdwn に変換する。code span / fenced code block は
   プレースホルダに退避して中身を一切変換・エスケープしない。Slack エンティティ
   (`<@U...>` / `<#C...>` / `<!here>` 等) も同様に退避し、そのまま届ける。残りをエスケープした後、
   行単位 (見出し・リスト) とインライン (bold / italic / strike / link) を変換して復元する。
2. **chunk 分割**: 上限文字数を超えるテキストを、段落 (`\n\n`) → 行 (`\n`) → 文字数ハード分割の
   順にフォールバックしながら貪欲にパッキングする。code fence をまたぐ場合はその場で閉じ、
   次のチャンクの先頭で同じ info string で開き直す。空文字・空白のみは 0 チャンクになる。
3. **送信**: チャンクを順に投稿する。`files` は最後のチャンクにだけ添付する。

`files` は Agent が Workdir 相対パスで指定し、Runner が Workdir を基準に解決する。Workdir の外へ
出るパス (`../` エスケープ・絶対パス・境界外を指すシンボリックリンク) は送信前に除外し、warn を
残す。これは Agent 隔離の一部で、境界の規則は [runtime.md](runtime.md) が持つ。

## 7. Turn の状態をメッセージへ返す

Turn の進行はリアクションで表す。Runner はプラットフォーム非依存の状態だけを発し、絵文字への
写像はチャット実装が持つ。

```typescript
type ReactionState = "kick" | "ok" | "error";

interface TurnReactor {
  react(channelId: string, messageId: string, state: ReactionState): Promise<void>;
}
```

| 状態 | 意味 | Slack での表現 |
|---|---|---|
| `kick` | その Turn の処理を開始した | `eyes` |
| `ok` | Turn が完走した | `white_check_mark` |
| `error` | Turn が異常終了した | `x` |

- 粒度は Turn であり Session ではない。`kick` はその Turn を起こしたメッセージに付け、
  `ok` / `error` はその Turn を構成した全メッセージに付ける。
- 成否は Turn 終端の停止理由から判定する。想定内の停止理由なら `ok`、それ以外は `error`。
- 同じリアクションの再付与は冪等な成功として扱い、握りつぶす。

## 8. 進捗通知

長い Turn の間、実行中であることと直前に何をしていたかを 1 通のメッセージの更新で示す。
Agent の推論を増やさず、Transcript にも痕跡を残さないため、Runner が Agent の tool 実行
イベントを観測するだけで組み立てる。

**状態**: tool 実行の開始イベントだけを購読し、直近のツール名・そのツール用の絵文字・引数の
プレビュー (60 文字まで)・Session 累計の呼び出し回数を保持する。完了イベントは追わない
(次のツールが呼ばれるまで直近のスナップショットを保つ)。`reply` ツールはこの状態を一切
更新しない — 最終回答を作っている段階であり、引数には返信本文がそのまま入るため。
組み込みツールは主要な引数キー 1 つの値だけを取り出し (`bash`→`command`、`read`/`write`/`edit`/`ls`
→`path`、`grep`/`find`→`pattern`)、それ以外は汎用の JSON プレビューにフォールバックする。

**送信**: Session 単位の間隔タイマーが発火するたびに
`{emoji} \`{tool}\` \`{argsPreview}\` ... (step {count})` を組み立てる。ツールがまだ一度も
呼ばれていなければ `:thinking_face: ... (step 0)`。前回送信したテキストと同一なら送信をスキップ
する (状況が進んでいないのに更新し続けない)。初回は新規投稿し、以降は同じメッセージを更新する。
間隔は System Config で設定し、`0` で機能ごと無効になる。

**reply による閉鎖**: `reply` が配送されるとき、同じ進捗キーの進捗メッセージが残っていて送信先も
同じなら、最初のチャンクでそれを上書きする (「実行中...」が完了後も残らないようにする)。
`files` を伴うチャンクと 2 つ目以降のチャンクは常に新規投稿する。上書きに成功したら Runner は
進捗タイマーを即座に止める。上書きできなかった場合 (進捗メッセージが無い・送信先が違う・
更新に失敗) は通常どおり新規投稿し、`reply` が届かないことはない。

**競合の防止**: 進捗タイマーの tick と `reply` の配送は別々の非同期経路から同じ進捗キーへ
到達するため、Egress は進捗キーごとの FIFO キューで両者を直列化する。それだけでは
「`reply` 配送の直後にキューへ積まれた stale な tick」を防げないので、`reply` の配送は
送信先の解決より前にそのキーの進捗レーンを閉じ、閉鎖中の tick は何もせず捨てる。
新しい Turn の開始時に同じキュー経由でレーンを開き直すことで、閉鎖前から残っていた前 Turn の
遅延 tick は閉鎖中として破棄され、開き直した後に積まれた新 Turn の tick だけが通る。
Session の終了時は記憶している messageId と閉鎖フラグの両方を捨てる。

**進捗キー**: 進捗メッセージは Session ごとに 1 つで、`reply` の宛先分岐 (§5) とは独立させる。
新しい Turn を起こしたときだけ、その Turn の先頭メッセージの Thread Key へ進捗キーを差し替える。
実行中の Session への追加入力では差し替えない — 後から合流したメッセージの宛先が最初の Thread と
違っても、進捗メッセージは「その Turn を起こしたメッセージの Thread」に留める。取り残された
進捗メッセージは、次にその Thread へ `reply` が届いたときに通常どおり回収される。

## 9. 実装対応

| 設計上の名前 | 現在のソース |
|---|---|
| ChatEvent / ConversationRef / Sender | `src/ingress/chat-event.ts` |
| Slack の codec | `SlackIngressAdapter` (`src/ingress/slack/adapter.ts`) |
| 二重配送の吸収 / isSelf 除外 | `startBridge` の `seenMessages` (`src/bridge.ts`) |
| user の解決 | `enrichEvent` (`src/ingress/user-resolver.ts`), `SlackUserResolver` (`src/ingress/slack/user-resolver.ts`) |
| Thread Key → 送信先の解決 | `EgressRouter` (`src/egress/router.ts`) |
| 送信先の登録 | `registerReplyDestination` (`src/session/reply-destination.ts`) |
| 送信の実体 | `BridgeOptions.poster` (`ChatPoster`、`src/bridge.ts` 内の Slack 実装) |
| mrkdwn 変換 | `toMrkdwn` (`src/egress/mrkdwn.ts`) |
| chunk 分割 | `chunkMessage` (`src/egress/chunker.ts`) |
| `files` の境界チェック | `ActiveSession.#resolveReplyFiles` (`src/session/active-session.ts`) |
| Turn 状態のリアクション | `TurnReactor` (`src/egress/turn-reactor.ts`), `SlackTurnReactor` (`src/egress/slack/turn-reactor.ts`) |
| 進捗通知の状態とタイマー | `ProgressNotice` (`src/session/progress.ts`) |
| 進捗通知の送信・閉鎖 | `EgressRouter.notifyProgress` / `clearProgress` / `reopenProgress` (`src/egress/router.ts`) |
