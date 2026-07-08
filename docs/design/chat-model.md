# チャットモデリング設計 (to-be)

hermes-agent ([../research/hermes-chat-modeling.md](../research/hermes-chat-modeling.md)) と pi ([../research/pi-session-model.md](../research/pi-session-model.md)) の as-is を踏まえた、
チャットツール横断エージェントの「会話の抽象化」設計。擬似コードは TypeScript (動作は保証しない)。

前提: Cloud Run (min-instances=0) で動かすため、**アダプタはプロセス内に常駐接続を持たない**。
Slack は Events API (HTTP push)、Discord は Interactions Endpoint or 小さな常駐 relay、メールは webhook/polling。
hermes の relay 構成 ([../research/hermes-session-model.md](../research/hermes-session-model.md) §4.1: 「常駐接続と耐久バッファを外出しし、本体はゼロスケール」) と同じ結論に、
Cloud Run では最初から寄せる。

---

## 1. 設計原則

hermes / pi から抽出した原則。以降のモデルはすべてここから導かれる。

1. **正規化イベントは薄く、固有機能は `raw` エスケープハッチに逃がす** (hermes MessageEvent + raw_message)。
   共通モデルにプラットフォーム固有フィールドを増やさない。
2. **スレッド概念は 1 スロットに潰す** (Slack thread_ts / Discord thread / メール In-Reply-To → `threadId`)。
3. **リプライは「ID + 引用抜粋 + 著者 + 自分宛か」に平坦化**し、構造はプロンプト注入時に角括弧注記へ畳む。
4. **プラットフォーム差は capability の値に還元する** (hermes relay の CapabilityDescriptor)。
   ゲートウェイ本体に per-platform 分岐を書かない。
5. **ストリーム出力は transport であって context ではない** (hermes stream_events.py の不変条件)。
   表示に流したものと永続履歴を混同しない。プレゼン判断 (絵文字・省略・沈黙) はアダプタ側。
6. **エラーとキャンセルはメッセージに正規化する** (pi の stopReason)。例外パスを増やさない。
7. **継承ではなく合成**。hermes の 5,600 行 god base class を避け、デバウンサ・チャンカー・
   ストリームレンダラを独立オブジェクトにする。
8. **受信リアクションを最初から一級市民にする**。hermes には無く「避けるべき点」に挙がっていた。
   Slack ではリアクションがトリガ・承認 UI・ACK のすべてに使われる。
9. **確定出力は地の文でなく `reply` tool 一本で出す** (salmon [[slack-agent-bridge-design]])。
   出力経路を 1 本に絞り、二重投稿・宛先曖昧さを構造的に消す。宛先はホストが握り、
   pi に任意 channel への自由 post をさせない。詳細は §5.2。

---

## 2. アドレッシングとコアモデル

### 2.1 会話の参照 (ConversationRef)

複数 Slack ワークスペースに参加する要件があるため、hermes の `platform:chat_id[:thread]` に
**scope (ワークスペース/ギルド) を必ず含める**。hermes は `guild_id`→`scope_id` の
dual-write 移行を強いられた ([../research/hermes-chat-modeling.md](../research/hermes-chat-modeling.md) §6 避けるべき点)。最初から中立語彙にする。

```typescript
type PlatformId = "slack" | "discord" | "email" | (string & {});

/** 会話 (返信先) の完全修飾参照。文字列形式と 1:1 で相互変換できる */
interface ConversationRef {
  platform: PlatformId;
  scopeId: string;    // Slack: team_id / Discord: guild_id / email: mailbox address
  channelId: string;  // Slack: channel / Discord: channel / email: スレッド root の Message-ID
  threadId?: string;  // Slack: thread_ts / Discord: thread id / email: なし (channelId が担う)
}

/** 正規文字列形式: "slack:T024BE7LD:C12345:1720000000.123456"
 *  配送先指定・セッションキー・Firestore ドキュメント ID の材料をすべてこれで統一する */
const formatConversation = (c: ConversationRef): string =>
  [c.platform, c.scopeId, c.channelId, c.threadId].filter(Boolean).join(":");
const parseConversation = (s: string): ConversationRef => { /* 逆変換 */ };
```

### 2.2 ユーザー参照

```typescript
interface UserRef {
  platform: PlatformId;
  scopeId: string;
  userId: string;        // Slack: U..., メール: アドレス
  altUserId?: string;    // 同一人物の別 ID (hermes user_id_alt: 電話番号↔UUID 問題)
  displayName?: string;
  isBot: boolean;        // 他 bot 発言のループ防止に必須
}
```

### 2.3 受信イベント (ChatEvent)

メッセージだけでなく、リアクション・編集・メンバー変化まで含む直和型にする。
セッション起動・承認 UI・ACK をリアクションで組むための土台。

```typescript
type ChatEvent =
  | InboundMessage
  | ReactionEvent
  | MessageEdited
  | SystemEvent;      // channel_joined など。当面はログのみ

interface InboundMessage {
  kind: "message";
  id: string;                      // プラットフォームのメッセージ ID (Slack: ts)
  conversation: ConversationRef;
  sender: UserRef;
  text: string;                    // メンションは "@表示名" に展開済み。bot 自身へのメンションは
                                   // 除去済み (hermes: LLM が「その ID に連絡しろ」と誤読する事故対策)
  mentionsBot: boolean;            // 除去前の判定結果は boolean で残す
  reply?: ReplyContext;
  attachments: Attachment[];
  editedFrom?: string;             // 編集イベント由来なら元 ID
  timestamp: Date;
  raw?: unknown;                   // エスケープハッチ。永続化・ワイヤ転送しない
  metadata: Record<string, unknown>; // 永続化してよい platform 固有シグナル
}

/** hermes と同じ平坦化 5 フィールド */
interface ReplyContext {
  messageId: string;
  excerpt: string;        // 引用元本文 (500 字程度で切る)
  authorId?: string;
  authorName?: string;
  isReplyToSelf: boolean; // bot 自身の発言への返信か
}

interface ReactionEvent {
  kind: "reaction";
  emoji: string;                 // 正規化名 ("eyes", "+1")
  targetMessageId: string;
  targetIsOwnMessage: boolean;   // bot の発言に付いたか (承認 UI / 再開トリガ判定に使う)
  conversation: ConversationRef;
  sender: UserRef;
  added: boolean;                // true=付与 / false=除去
  timestamp: Date;
}
```

### 2.4 添付ファイル

hermes 方式: **受信時に bytes を取得してストレージへ退避し、プロンプトには
「パス + 扱い方の指示」の一行注記だけ入れる** ([../research/hermes-chat-modeling.md](../research/hermes-chat-modeling.md) §1.1, §4)。Cloud Run では
ローカルディスクの代わりに GCS に置き、エージェントのワークスペースへ hydrate する。

```typescript
interface Attachment {
  kind: "image" | "audio" | "video" | "document" | "text";
  name: string;
  mimeType: string;
  sizeBytes: number;
  storageUri: string;   // gs://bucket/inbound/<hash> — 受信時に ingress が転送しておく
  /** プロンプトに入れる注記: [image 'foo.png' saved at: workspace/inbound/foo.png] */
  contextNote(localPath: string): string;
}
```

小さいテキスト添付 (~100KB) は Slack アダプタが本文へインライン展開してよい (hermes Slack と同じ)。

---

## 3. プラットフォームアダプタ

### 3.1 Capability Descriptor

hermes relay の descriptor ([../research/hermes-chat-modeling.md](../research/hermes-chat-modeling.md) §2.4) をそのまま採用する。ゲートウェイ本体はこの値だけを見る。

```typescript
interface ChatCapabilities {
  maxMessageLength: number;
  lengthUnit: "chars" | "utf16";   // Telegram/一部 API は UTF-16 code unit 制限
  supportsEdit: boolean;           // send→edit ストリーミングの可否
  supportsThreads: boolean;
  supportsReactions: boolean;
  supportsFileUpload: boolean;
  markdownDialect: "mrkdwn" | "gfm" | "plain";
  editIntervalMs: number;          // レート制限を踏まえた編集間隔の推奨値 (Slack: ~1000)
}
```

### 3.2 Ingress / Egress の分離

Cloud Run では受信 (webhook 検証・正規化) と送信 (API クライアント) のライフサイクルが違う。
hermes の「connect/disconnect を持つ常駐アダプタ」ではなく、ステートレスな 2 インタフェースに分割する。

なお **transport (どう届くか) と codec (どう解釈するか) は別の層**:

- **Ingress (Trigger)** — HTTP push (Events API) / WebSocket (Socket Mode) という
  「イベントの届き方 + ACK の仕方」。環境で差し替える ([architecture.md](architecture.md) §1)
- **IngressAdapter (下記)** — 届いた生ペイロードを `ChatEvent` に正規化する
  プラットフォーム方言の変換器。Ingress の実装が内部で使う

つまり `HttpIngress` と `SocketIngress` は同じ `SlackIngressAdapter` を共有し、
違うのは受信経路と ACK だけ。プラットフォーム追加は IngressAdapter を、
受信経路追加は Ingress を書く。

```typescript
/** 受信: HTTP リクエスト → ChatEvent[]。完全にステートレス */
interface IngressAdapter {
  platform: PlatformId;
  /** 署名検証 (Slack: signing secret)。scope ごとに秘密が違う点に注意 */
  verify(req: HttpRequest, secrets: ScopeSecrets): Promise<boolean>;
  /** 1 リクエスト → 0..n イベント。URL 検証チャレンジ等は即応答として返す */
  parse(req: HttpRequest): Promise<{ events: ChatEvent[]; immediateResponse?: HttpResponse }>;
  /** 再配送 dedupe 用のイベント ID (Slack: event_id。リトライで同じ値が来る) */
  dedupeKey(event: ChatEvent): string;
}

/** 送信: ConversationRef を宛先に取る操作群。トークンは scope ごとに解決 */
interface EgressAdapter {
  platform: PlatformId;
  capabilities: ChatCapabilities;
  send(conv: ConversationRef, content: OutboundContent): Promise<SendResult>;
  edit(conv: ConversationRef, messageId: string, content: OutboundContent): Promise<SendResult>;
  react(conv: ConversationRef, messageId: string, emoji: string, on: boolean): Promise<void>;
  uploadFile(conv: ConversationRef, file: FileRef, comment?: string): Promise<SendResult>;
  /** 履歴バックフィル。エージェントのツールとしても公開する (§5.2 の起動時文脈にも使う) */
  fetchHistory(conv: ConversationRef, opts: { limit: number; before?: string }): Promise<InboundMessage[]>;
  /** 共通中間表現 (GFM Markdown) → 方言変換。Slack は mrkdwn + 必要なら Block Kit */
  renderMarkdown(md: string): OutboundContent;
}

interface OutboundContent {
  text: string;                       // 方言変換済み
  replyTo?: string;                   // Slack: thread_ts (スレッドに入れる)
  broadcastToChannel?: boolean;       // Slack: reply_broadcast
}
```

### 3.3 送信結果とエラー分類

hermes の閉じた語彙 ([../research/hermes-chat-modeling.md](../research/hermes-chat-modeling.md) §1.5) を採用。dead-target 検出と自動リトライの判断材料。

```typescript
interface SendResult {
  ok: boolean;
  messageId?: string;
  continuationIds?: string[];  // 長文分割時の 2 通目以降
  errorKind?: "too_long" | "bad_format" | "forbidden" | "not_found"
            | "thread_not_found"   // hermes の教訓: chat ごと消えたのとスレッドだけ消えたのを区別
            | "rate_limited" | "transient" | "unknown";
  retryAfterMs?: number;
}
```

### 3.4 合成コンポーネント

基底クラスに集約せず、独立オブジェクトとして runner に注入する。

```typescript
/** 長文分割。コードフェンス境界を保存し、lengthUnit に応じた長さ関数を注入 (hermes truncate_message) */
interface MessageChunker { split(text: string, caps: ChatCapabilities): string[]; }

/** 連投の束ね。「最後の発言から debounce 秒」or「最初の発言から hardCap 秒」の早い方でフラッシュ。
 *  送信者が変わったらマージしない (hermes _can_merge_text_debounce_events) */
interface InboundDebouncer {
  add(event: InboundMessage): void;
  onFlush(cb: (merged: InboundMessage[]) => void): void;
}
```

---

## 4. エージェントへの入力テキスト化

構造 (送信者・リプライ・添付・時刻) は**すべて角括弧注記として user テキストに畳み込む**。
hermes のテンプレートが実戦で磨かれているのでほぼそのまま使う ([../research/hermes-chat-modeling.md](../research/hermes-chat-modeling.md) §4)。

```typescript
interface PromptRenderer {
  renderTurnInput(msgs: InboundMessage[], ctx: RenderContext): string;
}

interface RenderContext {
  isSharedMultiUser: boolean;   // 共有セッション (チャンネル/スレッド) なら送信者プレフィクス付与
  backfill?: InboundMessage[];  // 起動していなかった間の観測メッセージ (§5.2)
  workspaceDir: string;         // 添付の localPath 解決用
}
```

適用順のテンプレート:

1. 共有セッションのみ `[{displayName}] {text}` (DM では付けない)
2. バックフィルがあれば先頭に観測ログを置き `\n\n[New message]\n` で区切る
3. 添付は `[image 'x.png' saved at: {path}]` / `[The user sent a file ... process it yourself]`
4. リプライは `[Replying to: "{excerpt}"]` / 自分宛なら `[Replying to your previous message: "..."]`。
   **引用が履歴に既在でも常に注入する** — 重複排除ではなく「どの発言への返信か」の曖昧性解消
5. タイムスタンプは LLM に渡すレンダリング時にのみ `[Tue 2026-07-03 14:00 JST]` を 1 個付け、
   永続化する本文には含めない (hermes message_timestamps の分離)
6. トリガーメッセージ ID の注記 `[Triggering message id: ...]` は**システムプロンプトでなく user 側**に
   置く (ターン毎に変わる値をシステムプロンプトに入れるとプロンプトキャッシュが壊れる)

永続化は「クリーンな本文 + 構造化フィールド」、レンダリングは「注記畳み込み」と二層に分ける。
pi の `buildSessionContext` と同じく **LLM コンテキストは毎回導出する** (→ [session-model.md](session-model.md) §2)。

---

## 5. エージェント出力の受け取りと送信

### 5.1 型付きストリームイベント

pi の AgentEvent + hermes の stream_events を統合した語彙。**ツール進捗は delta でなく累積値**
(pi docs: 編集ベース UI は「その時点の全文で置換」が圧倒的に楽)。

```typescript
type AgentStreamEvent =
  | { type: "text_delta"; delta: string; partial: string }   // delta と累積の両持ち (pi 方式)
  | { type: "segment_end"; final: boolean }                  // tool 境界の中間 stop は final=false
  | { type: "commentary"; text: string }                     // ツール前の「まず〜を見ます」
  | { type: "tool_start"; toolCallId: string; toolName: string; argsPreview: string }
  | { type: "tool_progress"; toolCallId: string; cumulative: string }
  | { type: "tool_end"; toolCallId: string; ok: boolean; durationMs: number }
  | { type: "notice"; kind: "compaction" | "retry" | "resume" | "error"; text: string };
```

### 5.2 出力は `reply` tool (地の文でなくツール経由・複数回可)

**原則 9: ユーザーに届ける出力は、地の文でなく `reply` tool で出す**
(salmon [[slack-agent-bridge-design]] の実機検証済み判断)。

```typescript
/** エージェントの出力ツール。「どのスレッドに何を返すか」を thread_key で指定して呼ぶ。
 *  1 ターンの中で 何度でも・任意のタイミングで 呼べる (ストリーミングの一段ではなく、
 *  「言いたいことがまとまった単位」で明示的に呼ぶ)。thread_key はホストに不透明 (§5.3)。
 *  files は任意の添付。workdir 相対パスで渡し、ホストが workdir 基準で解決する。
 *  workdir 外へ出るパス (../ エスケープ・絶対パス) はホストが除外する (trust boundary) */
reply(thread_key: string, text: string, files?: string[]): void
```

**reply は「停止時に 1 回」ではなく、逐次の出力手段**である。これが本設計の要点:

- **1 セッションに複数タスクが来たら逐次に返す**。例: 「1 つ目を調査 → `reply` → 2 つ目を調査
  → `reply`」。時間ウィンドウでエージェントを使い回す運用では、独立した事象が同じセッションに
  次々流れ込むので、**別々の事象は別々の reply として (必要なら別 thread_key に) 返す**。
- **地の文の最終 assistant テキストは Slack に流さない**。伝えたいことはすべて `reply` で出す。
  `agent_end` (prompt 1 回分の完全終了) は **idle 検知 (状態管理) に使うだけ**で、
  ここで地の文を投稿しない。「最終テキストを 1 回投稿」という hermes 由来の挙動は廃止。
- ただし**停止するときは何らか返してほしい**。沈黙 (§5.7) を選んだ場合を除き、ターンを
  終える前に「調べた結果・できなかった理由」を `reply` で残すのを既定の振る舞いとする。
  → これは「停止時 1 回だけ reply」モデルではない。途中で何度返していてもよいし、
  停止時にまとめて返してもよい。**回数と粒度はエージェントが内容に応じて決める**。

### 5.3 thread_key: ホストに不透明なキー / 1 セッション内に複数併存する

- エージェントは入力で見た `thread`(= Slack の thread_ts)をそのまま thread_key に使ってもよいし、
  **別の話題には自作の slug を使ってもよい**。ホストは **キーが一致すれば同じスレッド**として
  扱うだけで、ts ↔ key の変換ロジックを持たない。
- **1 セッション内に複数の thread_key が同時に生きうる**。時間ウィンドウで使い回す/複数タスクが
  来る運用では、1 つの入力ストリーム (セッション) から内容に応じて出力を複数スレッドに分ける。
  我々の初期案「threadTs = セッション ID 固定 (入出力 1:1)」より出力側の表現力が高い。
- ホストは session ごとに `Map<thread_key, thread_ts>` を持ち、**初見の key なら channel 直下に
  新スレッドの親を立て、既知の key なら追記**する。分岐はこの 2 つだけ (salmon の安定性優先)。
  この Map は SessionDoc 配下 (フィールド or `outputs` サブコレクション) に永続化し、
  再開時に thread_key→thread_ts を復元する ([session-model.md](session-model.md) §7 / [architecture.md](architecture.md) §2)。
- 宛先の実体 (channel / ts) は**ホストが握る**。pi は thread_key を言うだけで、任意 channel への
  自由 post はできない (安全方針: [chat-model.md](chat-model.md) 原則 + read-only で育てる段階と噛み合う)。

### 5.4 進捗表示は任意 (出力とは別レーン)

§5.1 の `AgentStreamEvent` による send→edit ストリーミング (進捗メッセージ・ツール表示) は
**残してよいが、`reply` の出力とは別レーン**として扱う:

- 👀/✅ リアクション ACK、tool 実行中のステータス編集などは「実行中であることの可視化」。
  **編集ベースなので冪等** (同じメッセージを update するだけ)。二重投稿を生まない。
- 初期段階 (安定性最優先) では**進捗表示を省き、`reply` だけ**でも成立する。
  進捗表示は「長時間ターンの体感改善」のオプションとして後から足す位置づけ。
- 進捗メッセージと reply は Slack 上で別メッセージ。進捗は edit で畳み、返答は reply で残す。

### 5.5 二重投稿対策への影響 (層 3 の縮退)

出力を `reply` tool 経由 (地の文を流さない) にしたことで、[architecture.md](architecture.md) §6 の 3 層防御は軽くなる:

1. 受信 dedupe (inbox doc ID = event_id) — **維持**
2. セッション排他 (Firestore lease + epoch) — **維持**
3. 送信冪等化 — **縮退**。地の文の最終テキストを流さないので「進捗編集と最終投稿がずれて
   二重に見える」類の重複が起きない。`reply` の各呼び出しは transcript に tool 呼び出しとして
   残る ([session-model.md](session-model.md) §2) ので、再開時は導出コンテキストにそれが含まれ、**エージェントが同じ reply を
   再度呼ばない限り重複しない**。進捗メッセージを使う場合のみ、それは edit 冪等 (`currentTurnMsgTs`)。
   → `currentTurnMsgTs` 紐付けは「進捗メッセージを使う場合のみ」必要で、reply だけなら不要。

### 5.6 pi Extension の結線 (execute は Slack を叩かない)

`reply` を pi の Extension として実装するとき、**宛先制御をホストに集約するため
`execute` 内で Slack を叩かない** (salmon の採用案 B):

```
pi 子プロセス内:  reply(thread_key, text) tool  ← 1 ターン中に何度でも呼ばれる
                   └ execute: 引数を result に詰めて返すだけ (Slack を叩かない・throw も安全)
                        │ RPC event: tool_execution_end { toolName:"reply", result:{thread_key,text} }
                        ▼ (呼ばれるたびに 1 イベント)
ホスト (Runner):   RpcClient.onEvent で tool_execution_end を購読
                   └ result から {thread_key, text} を取り出し
                   └ Map<thread_key, thread_ts> で宛先解決 → chat.postMessage (初見なら新スレッド)
```

- `execute` は pi 子プロセス内で動くため WebClient も `Map` もプロセスをまたげない。
  だから **execute は投げっぱなし ({ok:true} を返すだけ)**、実 post はホストが RPC イベントで拾う。
- **reply は 1 ターン中に複数回呼ばれる**。ホストはイベントを受けるたびに 1 通 post する
  (逐次返信・話題ごとの thread_key 振り分けはここで実現される)。
- ツール定義には **`promptSnippet` を必ず与える** (無いとシステムプロンプトの Available tools 節に
  載らず、LLM が存在を知らず呼ばない)。`parameters` は pi の TypeBox スキーマ。
- これで thread_key の対応表も WebClient もホストに集約でき、pi は宛先の実体を知らないまま。

### 5.7 沈黙する権利

`reply` を一度も呼ばずにターンを終えれば沈黙。自動起動 (メンションなし) では
システムプロンプトで「返答不要なら reply を呼ぶな」と教える。配送前ゲート (トリガ判定 [session-model.md](session-model.md) §5) と
「reply を呼ばない自由」の二段で群れチャットの誤爆を最小化する。地の文を Slack に流さない以上、
沈黙が既定なので専用の `NO_REPLY` マーカーは不要。

---

## 6. 全体データフロー

単一サービス構成 ([architecture.md](architecture.md) §1)。event 処理と session 処理は同一プロセス内の別フェーズ。

```
Slack ──(Events API HTTP / Socket Mode WS)──▶ Ingress (Trigger)
  verify → parse (IngressAdapter) → ChatEvent
  → Gate 合成で起動判定 (mention / keyword / 分類器, [session-model.md](session-model.md) §5)
  → 対象なら Firestore: session inbox に event_id で create() → ACK
  ── ここまで event フェーズ。以降は session フェーズ (レスポンス後に継続) ──

Session (同一インスタンス, lease を取れた場合のみ):
  lease 取得 (Firestore txn + epoch) → transcript ロード (GCS)
  → inbox drain → PromptRenderer → pi ターン実行 (RPC, Vertex Gemini)
  → pi が reply(thread_key, text) を呼ぶたび:
      tool_execution_end をホストが購読 → Map<thread_key, thread_ts> で宛先解決
      → EgressAdapter.send → Slack (1 ターン中に複数回, §5.2-5.6)
  → (任意) AgentStreamEvent → 進捗 Sink → EgressAdapter.edit (別レーン, §5.4)
  → ターン境界で inbox 再ポーリング (steering, [session-model.md](session-model.md) §4)
  → transcript/成果物を GCS に書き切り → outcome を SessionDoc に → lease 解放
```

セッション側の設計 (キー・lease・steering・再開) は [session-model.md](session-model.md)、
Google Cloud 上の具体構成は [architecture.md](architecture.md)。

---

## 7. as-is からの主な差分 (判断の記録)

| 論点 | hermes / pi | 本設計 | 理由 |
|---|---|---|---|
| 受信リアクション | モデルなし (送信 ACK のみ) | ChatEvent の一級市民 | Slack ではトリガ・承認・再開に使う |
| scope (workspace) | guild_id→scope_id 移行中 | 最初から必須フィールド | 複数ワークスペース要件 |
| アダプタ構造 | 5,600 行基底クラスへの継承 | Ingress/Egress 分離 + 合成 | Cloud Run のステートレス性、テスト容易性 |
| 常駐接続 | Socket Mode / discord.py 常駐 | Ingress で差し替え: 本番 Events API (HTTP push)、ローカル/お試しは Socket Mode | 本番は scale-to-zero と両立させ、開発は公開 URL なしで回す |
| 最終出力 | 地の文 (最終 assistant テキスト) を投稿 | `reply(thread_key, text)` tool 経由のみ。複数回可・宛先分割可 | 出力経路 1 系統で二重投稿と宛先曖昧さを構造的に排除 (salmon 実証) |
| ツール進捗 | preview 文字列 | 累積値 (置換描画) | 編集ベース UI との相性 (pi の明記された理由) |
| エラー表現 | SendResult + 例外混在 | stopReason 正規化 (pi) + SendResult.errorKind (hermes) | 両者の良い所を採る |
