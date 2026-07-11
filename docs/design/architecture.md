# Slack × Google Cloud 最終案 (簡素版)

単一組織・非公開運用の前提で [chat-model.md](chat-model.md) / [session-model.md](session-model.md) の
汎用モデルを削ぎ落とした具体設計。汎用モデルとの差分は §9 にまとめる。

## 0. 前提の固定 (これにより消えるもの)

| 前提 | 消えるもの |
|---|---|
| 1 組織 1 ワークスペース | `workspaces` コレクション、OAuth インストールフロー、teamId による修飾。bot token / signing secret は Secret Manager に 1 組、teamId・botUserId は環境変数 |
| プラットフォームは Slack のみ | `ConversationRef` の platform/scopeId。会話の座標は **`(channelId, threadTs)` の 2 つだけ** |
| メッセージを Firestore にミラーしない | entries サブコレクション (トランスクリプトの Firestore 保存)、observed ログの DB 化。会話履歴は起動時に Slack API から取り、トランスクリプトは GCS のセッションファイルに書く (pi 方式) |
| アプリケーションで完結させる | Cloud Tasks、ingress/runner のサービス分離。1 サービス + CPU always-allocated + Firestore lease で代替 (§1) |

```typescript
interface Conv { channelId: string; threadTs?: string }  // これが会話参照のすべて
// セッション ID = スレッド root の ts。キー導出・ハッシュ・逆引きが全部消える
```

## 1. 全体構成 — 単一サービス、Cloud Tasks なし

```
Slack Events API
   │ HTTP push
   ▼
app (Cloud Run, 1 サービス)
   min-instances=0, max-instances=N (負荷でスケールアウト), concurrency=M, CPU always-allocated
   timeout 60min

   /slack/events (受信):
     署名検証 → 起動判定 (§6) を通れば inbox に event_id で create() → 即 200 (3 秒 ACK)
     ── レスポンス後 (always-allocated なので CPU 継続) ──
     そのスレッドの lease を Firestore txn で取得
       取れた   → セッションを drain (ターン実行, Vertex AI Gemini)
       取れない → 降りる (処理中の別インスタンス/リクエストが inbox から拾う)

Firestore : channels/{ch} + channels/{ch}/sessions/{threadTs} (+inbox)
GCS       : /data に FUSE マウント (transcript / workspace / artifacts / docs)
Secret Manager : Slack bot token / signing secret
```

**サービスは 1 つ**。ingress/runner の分離も Cloud Tasks も廃止した。理由:

- **なぜ Cloud Tasks が不要か**: それが担っていたのは (a) 3 秒 ACK と長い実行の分離、
  (b) 起動の冪等化、(c) リトライ。(a) は「event ハンドラは inbox に積んで即 200、実行は
  always-allocated のレスポンス後に回す」で吸収。(b) は inbox の event_id `create()` で吸収。
  (c) は Slack 自身のイベント再送 + inbox 耐久キューで吸収。**受け渡しの中継が消えたので、
  そこで取りこぼす箇所自体が無くなる**。
- **なぜ 1 サービスでスケールアウトできるか**: 負荷が上がると Slack がイベントを立て続けに送り、
  concurrency を超えた分を Cloud Run が**自動でインスタンス増設**する。増えた台がそれぞれ別スレッドの
  lease を取って並行実行する。低負荷なら 1 台が concurrency 内で捌き、暇なら 0 台。
  スケールのトリガは Slack のイベント流入そのもので、専用のキューは要らない。

チャンネル特化イメージが要るなら、この app とは別に runner サービスを立て、app はそこへ
処理を委譲する形に後から拡張できる (初期は 1 サービスに同居)。

### 入口 (Trigger) を差し替え可能にする

Slack からイベントを受け取る経路は 2 つあり、**デプロイ環境で使い分けたい**:

- **Events API (HTTP push)** — Cloud Run にデプロイした本番。公開 URL に署名付き POST が届く。
- **Socket Mode (WebSocket)** — ローカルでの動作確認や、共有環境にデプロイするまでのお試し。
  公開 URL が要らず、`app.start()` 後は WebSocket で受け取る。

両者は「受け取り方」だけが違い、その後 (dedupe → 起動判定 → inbox → drain) は同一。
入口を `Ingress` で抽象化し、後段を共通化する:

```typescript
/** Slack からの生イベントを正規化 ChatEvent ([chat-model.md](chat-model.md)) にして後段へ渡す入口。
 *  実装差は「どう受け取るか / どう ACK するか」だけ */
interface Ingress {
  /** 受信を開始。onEvent は dedupe・起動判定・inbox 積みの共通パイプライン */
  start(onEvent: (e: ChatEvent, ack: Ack) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}

interface Ack { (): Promise<void>; }  // Events API では 200 応答、Socket では ack コールバック

class HttpIngress implements Ingress {}    // Events API。/slack/events で受ける (本番)
class SocketIngress implements Ingress {}  // Socket Mode。WebSocket (ローカル/お試し)
```

- **3 秒 ACK の意味が経路で違う**: Events API では「即 200 を返す」、Socket Mode では
  「`ack()` を呼ぶ」。`Ack` で吸収し、後段は「積んだら ack()」とだけ書けばよい。
- 実行モデル (レスポンス後に always-allocated で drain) は Cloud Run + Events API 前提。
  Socket Mode はローカル/常駐前提なので、**その場で drain してよい** (scale-to-zero の制約が無い)。
  この差は Ingress 実装が吸収し、セッション層 ([session-model.md](session-model.md)) は触らない。
- 選択は環境変数などで切り替え (`SLACK_MODE=events|socket`)。**起動判定 (Gate [session-model.md](session-model.md) §5) と
  セッション処理は共通**なので、入口を差し替えても挙動は同じ。

### event と session の分離 (この設計の主語)

**event (Slack リクエスト) は「きっかけ係」、session (threadTs) が「処理の担い手」**。
event ハンドラは中身の返信を作らない — 「この event を inbox に積むべきか、今誰かが
処理中か」を判断するだけ。実際の処理は event から切り離され、**セッション (スレッド) を
主語にした inbox drain ループ**が担う。

| 主語 | やること |
|---|---|
| event | dedupe → 起動判定 → inbox に積む → 200。lease 生存なら積むだけで降りる。対象外なら積まず 200 だけ |
| session | inbox を drain してターンを回す。lease で 1 スレッド 1 実行に排他 |

この分離が無いと event 単位処理になり、連投が多重起動・文脈分断を起こす。分離により
「連投を 1 セッションにまとめる / 実行中の追加指示 (steering) / スケールアウトしても同じ
スレッドは 1 台」が全部成立する (pi-chat の `ConversationRuntime` と同型)。

## 2. Firestore スキーマ (チャンネル軸)

```
channels/{channelId}                          … チャンネル設定。ドキュメントが無ければ既定動作
channels/{channelId}/sessions/{threadTs}      … セッション情報 (メタデータのみ)
channels/{channelId}/sessions/{threadTs}/inbox/{eventId}   … steering キュー (実行中のみ・処理後削除)
```

```typescript
// channels/{channelId}
// 振る舞いのテキストと trigger だけを持つ (初期版)。能力 (skill/CLI) はイメージに焼き、
// チャンネルごとの選択はしない ([config.md](config.md) §2-3)。doc が無いチャンネルは既定動作 (mention 起動)。
// 人が書くのはリポジトリ内 YAML で、bridge が起動時/イベント時に直接読む ([config.md](config.md) §6)
// 実体は zod スキーマ (src/config/channel-doc.ts) を単一ソースとし、以下は概形のみ。
// Gate の合成木 (config.md §7)。配列は OR、{ and } / { or } で明示的にネストできる。
type WhenNode =
  | { kind: "mention" | "passthrough" }
  | { kind: "keyword"; pattern: string }
  | { kind: "classifier"; criteria: string; model?: string }
  | { kind: "reaction"; emoji: string[] }
  | { and: WhenNode[] }
  | { or: WhenNode[] };

interface ChannelDoc {
  systemPrompt?: string;          // app 共通プロンプトへの追記分
  context?: string[];             // 短い参照テキスト。初回ターンに注入 ([config.md](config.md) §4)
  trigger?: {
    when: WhenNode[];
    debounceSec?: number;          // 連投バーストを 1 kick にまとめる (実装済み)
    // cooldownSec?: number;       // 実装保留中。スキーマからも外してある (session-model.md 「実装案」参照)
  };
  model?: string;                  // pi の shorthand "provider/model-id[:thinking]"。省略時は pi 既定
  tools?: string[];                // pi --tools の allowlist
  excludeTools?: string[];         // pi --exclude-tools の denylist
  skills?: string[];               // チャンネル別に追加する skill のパス (pi --skill、additive。[config.md](config.md) §2)
  extensions?: string[];           // チャンネル別に追加する extension (.ts/.js) のパス (pi --extension、additive)
  session?: { mode?: "thread" | "channel"; idleResetMinutes?: number; maxTranscriptKb?: number };
  reply?: { mode?: "thread" | "flat" };
  // 将来拡張: image (チャンネル特化イメージ = 別サービス化とセット) / mcpServers — [config.md](config.md) §2
}

// channels/{channelId}/sessions/{threadTs}
interface SessionDoc {
  status: "running" | "idle" | "resume_pending" | "done";
  generation: number;             // /new で +1。transcript ファイル名に対応
  lease?: { owner: string; epoch: number; expiresAt: Timestamp };
  resume?: { markedAt: Timestamp; reason: string };
  lastActivityAt: Timestamp;
  outcome?: { summary: string };  // 終了時の 1-3 行要旨。channelIndex を兼ねる
  artifacts?: { name: string; note: string }[];  // 台帳のみ (実体は GCS)
  currentTurnMsgTs?: string;      // 現ターンの Slack メッセージ ts (二重投稿防止, §6 層 3)
  sentMessageTs?: string[];       // bot が投稿した ts (リアクション逆引き用、直近数件)
}
```

要点:

- **セッションの一覧・逆引きが構造で解決する**。「このチャンネルの過去セッション」=
  サブコレクションを lastActivityAt で並べるだけ。「このスレッドのセッション」= doc ID 直引き。
  汎用版にあった sessionKey ハッシュ・chat_ref エントリ・channelIndex コレクションは全部不要
- **dedupe コレクションも不要**。inbox のドキュメント ID を Slack の event_id にし、
  `create()` (存在時失敗) で書けば Slack リトライの重複は自動排除される。
  起動対象外イベントの二重処理は無害 (分類器が二重に走るだけ) なので許容
- **Firestore に書くのは「状態・判断・台帳」だけ**。会話本文・ツール出力は書かない。
  書き込み量はセッションあたり数十 doc 未満に収まる

## 3. トランスクリプトは GCS のセッションファイル (pi 方式)

```
/data (gs://<bucket> を FUSE マウント)
  channels/<channelId>/<threadTs>/
    session-g<generation>.jsonl      … append-only エントリ列 ([session-model.md](session-model.md) §2 の型をそのまま使用)
    workspace/                       … 作業ファイル (再開に必要なものだけ)
    artifacts/                       … 成果物 (残すと宣言されたもの)
  docs/                              … ドキュメントセット (読み取り専用)

skill はここではなくイメージに同梱する ([config.md](config.md) §0・§3)。頻繁に書き換える運用が
生じたら /data/skills/ を復元パスとして足す (§9)
```

- ターン開始: transcript を読み、leaf まで再生してコンテキストを導出
  (compaction エントリ・dangling tool call 除去は [session-model.md](session-model.md) §2 のまま)
- ターン中: エントリはメモリに蓄積
- **ターン終了時に transcript 全体を 1 オブジェクトとして書き戻す** (§5 の FUSE 特性に合わせた
  「1 ターン 1 フラッシュ」)。inbox アイテムの削除はフラッシュ成功後 — クラッシュしたターンは
  inbox に残った入力から冪等に再実行される (at-least-once + 再生で回復)
- Slack のスレッド自体が人間可読のトランスクリプトを兼ねるので、Firestore に二重化する
  動機がそもそも無い。機械可読の正は GCS、人間可読の正は Slack

## 4. GCS FUSE の採否: 採用する (制約込みで)

Cloud Run のボリュームマウント (Cloud Storage FUSE) を runner に設定し、GCS SDK の
hydrate/dehydrate コードを消す。判断材料:

**向いている (今回の使い方)**
- transcript / artifacts / docs は「少数の・まとまったサイズの・読み書き頻度が低い」ファイル。
  FUSE の苦手 (小ファイル大量・メタデータ操作) に当たらない
- **Firestore lease で 1 セッション 1 ライター**が保証されるため (スレッドごとに書く場所が
  分かれ、同じ threadTs を 2 台が同時に書かない)、FUSE の並行書き込み問題を踏まない。
  concurrency>1 でスケールアウトしても、書き込みの排他は lease が担保する
- マウントは設定のみ (`--add-volume` / YAML)。コード量がゼロになる

**注意点 (設計で回避する)**
- 書き込みは close 時にオブジェクト全体をアップロードする。追記のつもりでも全書き換えに
  なるため、**transcript はターン単位で全体書き戻し** (§3) とし、行単位 append はしない
- rename の原子性がない。テンポラリ→rename のパターンは使わず、単一オブジェクトの
  上書きで済む構造にする
- git clone / npm install / ビルドのような**大量小ファイル操作はローカル (tmpfs) で行う**。
  リポジトリはイメージ焼き込み or tarball 展開 ([session-model.md](session-model.md) §7) のままとし、FUSE 上には置かない。
  `workspace/` に置くのは「再開時に必要な少数の作業ファイル」だけ (レポート下書き、
  調査メモ、中間データ等)。全作業ディレクトリの同期はしない

つまり「**tmpfs = 作業場、/data = 保存棚**」。棚に置くものをエージェントに選ばせる
(`save_to_workspace` / `publish_file` ツール) ことで、作業中ファイルと成果物の区別 (§5) も
同じ仕組みに乗る。

## 5. ファイルの二分

| 種別 | 置き場所 | 生存期間 |
|---|---|---|
| 作業中 (スクラッチ) | tmpfs (`/tmp/work`) | ターン内。消えてよい |
| 再開に必要な作業ファイル | `/data/.../workspace/` | セッション中。lifecycle rule で 30 日後削除 |
| 成果物 | `/data/.../artifacts/` + SessionDoc.artifacts 台帳 | 恒久。必要なら `files.upload` で Slack にも投稿 |

「全てチャットに投稿」はしない。Slack に出すのは最終回答と、エージェントが `publish_file`
で明示したものだけ。それ以外は artifacts に残り、後続セッションは台帳 (SessionDoc) と
`/data` の読み取りで参照できる — クロスセッション参照 ([session-model.md](session-model.md) §8) も FUSE マウントの
読み取りで完結する。

## 6. 起動と steering (単一サービス版)

```
受信 (/slack/events, いずれかのインスタンスが受ける):
 1. 署名検証 → bot 発言/自己エコー除外
 2. 起動判定: mention → 即対象。classifier チャンネルは debounce 後に Flash-Lite で判定
    (criteria は ChannelDoc)。対象外なら 200 だけ返して終わり (inbox に積まない)
 3. 対象なら inbox に event_id で create() (Slack リトライを冪等排除) → 200 を返す
    ── ここまでで Slack への ACK は完了。event ハンドラの仕事は「積む」まで ──

実行 (レスポンス後、always-allocated で継続):
 4. sessions/{threadTs} の lease を Firestore txn で取得
      取れない → 別インスタンス/リクエストが処理中。何もせず終了 (積んだ入力は相手が拾う)
      取れた   → 自分が処理役。トリガー発言に :eyes:
 5. transcript ロード → inbox drain → ターン実行。lease は heartbeat で延命。
    **出力はエージェントの `reply(thread_key, text)` 呼び出しで行う (1 ターン中に複数回可)** ([chat-model.md](chat-model.md) §5.2)。
    ホストは pi の RPC event `tool_execution_end{toolName:"reply"}` を購読し、呼ばれるたびに
    `Map<thread_key, thread_ts>` で宛先解決 → `chat.postMessage`。複数タスクは thread_key で
    分けて逐次返す ([chat-model.md](chat-model.md) §5.3, §5.6)
 6. 実行中の追加指示: スレッド内の後続発言は同じ inbox に積まれ、
    **次のターン境界で inbox をポーリングして**拾い steer/followUp 注入
    (realtime リスナは使わない。理由と取りこぼしのない根拠は [session-model.md](session-model.md) §4)
 7. 完了: `agent_end` は idle 検知にのみ使う (地の文は Slack に出さない [chat-model.md](chat-model.md) §5.2)。
    transcript 書き戻し → inbox 削除 → outcome を SessionDoc に
    → linger (例 120s, 2-3s 間隔で inbox ポーリング) で追撃を待つ
    → 解放直前にもう一度 inbox 確認 (レース対策) → lease 解放
    → :eyes: を :white_check_mark: に
```

### 二重投稿の防止 (reply 経由の統一で 2 層に縮退)

当初は 3 層で守っていたが、出力を `reply` tool 経由に統一した (地の文を流さない [chat-model.md](chat-model.md) §5.2)
ことで、**送信の冪等化 (旧・層 3) は構造的にほぼ不要になった**。残るのは 2 層:

1. **受信の dedupe**: inbox doc ID = Slack `event_id`、`create()` で重複を弾く (§2)
2. **セッション排他**: Firestore lease + epoch。同じ threadTs を 2 台が同時に走らせない。
   lease を取れなかったインスタンスは実行に入らない (フロー 4)

なぜ送信冪等化が要らなくなるか:

- 確定出力の経路が `reply` 1 本しかなく、**地の文の最終テキストを Slack に流さない**ため、
  「進捗編集と最終投稿がずれて二重に見える」類の重複が原理的に発生しない。
- lease 排他 (層 2) により、同一 threadTs のターンを 2 台が同時に走らせることはない。
  クラッシュ再開時は transcript に「その reply を既に tool 呼び出しした」記録が残る ([session-model.md](session-model.md) §2)
  ので、導出コンテキストにそれが含まれ、**エージェントが同じ reply を再度呼ばない限り重複しない**。
- 残るのは「lease 失効の隙にターン全体が 2 回走り、reply も 2 回呼ばれる」極端ケースのみ。
  これは lease の TTL/heartbeat 設計 ([session-model.md](session-model.md) §4) で抑える範囲で、専用の送信ロックは要らない。

**進捗表示 (send→edit) を足す場合のみ**、そのメッセージは edit 冪等なので `currentTurnMsgTs`
紐付けが有効になる (下記)。進捗を使わず reply 一本なら `currentTurnMsgTs` は不要。

```typescript
// 進捗表示を使う場合のみ (確定出力は reply。これは「実行中」の可視化レーン [chat-model.md](chat-model.md) §5.4)
let msgTs = session.currentTurnMsgTs;
if (!msgTs) {
  msgTs = await slack.postMessage(thread, "…");     // 最初の 1 回だけ post
  await session.update({ currentTurnMsgTs: msgTs }); // 即保存 (post 後クラッシュに備える)
}
await slack.update(msgTs, progressText);              // 進捗は同じ ts を update (冪等)
```

### 再開はパスを持たない

長時間経過後のスレッド内発言も、受信フロー 1〜4 と同一。sessions doc が既存で lease が
無いだけなので、専用の再開フローが存在しない — これが threadTs = セッション ID の最大の配当。

## 7. Slack 実装ノート (変更なしの要点のみ)

- 3 秒 ACK (経路で意味が違う。[Ingress](#1-全体構成--単一サービスcloud-tasks-なし) §1) /
  リトライ / mrkdwn 変換 / 出力は `reply` tool 経由 (地の文を流さない [chat-model.md](chat-model.md) §5.2) は [chat-model.md](chat-model.md) §5 のまま。
  進捗表示を足す場合のみ chat.update ≈ 1.2s スロットル / flood 3 ストライク
- 沈黙は「reply を呼ばない」で表現 (専用 NO_REPLY マーカー不要 [chat-model.md](chat-model.md) §5.7)
- リアクションによる再開: `reaction_added` は対象 ts しか持たないため、
  SessionDoc.sentMessageTs との照合 → 外れたら `conversations.replies` で thread_ts を解決

## 8. 実装順序

1. **MVP**: 単一サービス。入口は `Ingress` で抽象化し、まず **Socket Mode でローカル確認**
   → **Events API (`/slack/events`) で Cloud Run デプロイ**。inbox 積み + ACK + レスポンス後に
   lease 取得してターン実行。MentionGate 起動、threadTs セッション、transcript は GCS FUSE。
   **出力は `reply` tool 経由**で結線 ([chat-model.md](chat-model.md) §5.6)。**lease (Firestore txn + epoch) と inbox、
   二重投稿防止の 2 層 (§6) をここで骨格ごと作る** — これが全体の土台。
   この時点では max-instances=1 で動かしてもよい (スケールは後で開放)
2. steering (ターン境界ポーリング) + reply の thread_key 振り分け (`Map<thread_key, thread_ts>`)。
   進捗表示を足すならここで SlackThreadSink (ts 紐付け + 編集)
3. ChannelDoc + Gate 合成 ([session-model.md](session-model.md) §5): KeywordGate/ClassifierGate をシャドーモード → 有効化
4. workspace/artifacts ツールと outcome
5. max-instances を開放してスケールアウト検証 (lease 排他と reply の重複が無いか)
6. 必要になったら: 特化イメージの別サービス化、複数ワークスペース対応 (§9 の拡張パスに従う)

## 9. 汎用モデル ([chat-model.md](chat-model.md)/[session-model.md](session-model.md)) からの差分と復元パス

| 汎用モデル | 本簡素版 | 将来の復元パス |
|---|---|---|
| ConversationRef (platform/scope/channel/thread) | `(channelId, threadTs)` | Firestore パスに `platforms/{p}/scopes/{s}/` を前置するだけで戻る。コード上は Conv 型の拡張 |
| sessionKey ハッシュ + sessions コレクション | doc ID = threadTs | チャンネルレーン運用 ([session-model.md](session-model.md) §3(b)) が必要になったら threadTs の代わりに lane ID を使う |
| entries サブコレクション (Firestore) | transcript JSONL (GCS) | 変わらない方が良い判断。Firestore 化は「エントリ単位のリアルタイム購読」が要るときのみ |
| chat_ref エントリ | sentMessageTs 配列 + API 解決 | 逆引きが増えたら chat_ref を transcript エントリとして復活 |
| dedupe コレクション | inbox doc ID = event_id | そのまま |
| workspaces コレクション | 環境変数 + Secret Manager | マルチテナント化する時に §2 の前に workspaces/ を足す |
| skill を GCS (`/data/skills/`) から読む | イメージ同梱 + ChannelDoc で有効化 ([config.md](config.md)) | デプロイなしで skill を書き換えたくなったら GCS 読み込みを追加 (manifest との併用可) |
| channelIndex | SessionDoc.outcome をサブコレクションから読む | そのまま |

削っても [session-model.md](session-model.md) の 3 分離 (レーン/実体、履歴/導出、プロセス/状態) は保たれている:
レーン = (channelId, threadTs)、実体 = generation 付き transcript、状態 = Firestore + GCS。
