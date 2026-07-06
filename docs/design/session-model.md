# セッションモデリング設計 (to-be)

hermes-agent ([../research/hermes-session-model.md](../research/hermes-session-model.md)) と pi ([../research/pi-session-model.md](../research/pi-session-model.md)) の as-is を踏まえた、
チャット駆動エージェントのセッション設計。実行基盤は Cloud Run (min-instances=0) + Firestore + GCS を想定。

---

## 1. コア判断: 3 つの分離

as-is 調査から得た最重要の構造を最初に固定する。

1. **sessionKey (会話レーン) と sessionId (トランスクリプト実体) の分離** (hermes)。
   キーは会話の位置から決定的に導出され不変。実体はリセット・compaction で回転し
   `parentSessionId` でチェーンする。ルーティングは常にチェーン先端へ自己修復。
2. **保存された履歴と LLM に見せるコンテキストの分離** (pi)。履歴は append-only エントリ列。
   コンテキストは毎ターン、エントリ列 (+compaction エントリ) から導出する。破壊的更新なし。
3. **プロセスと状態の分離** (pi orchestrator の割り切り)。「プロセスは使い捨て、状態はストア」。
   Cloud Run のインスタンスはいつ消えてもよく、どのインスタンスに当たっても続きが動く。
   hermes の agent cache は「キャッシュミスでも同じ結果」の純最適化だった — この性質だけ持ち帰る。

```typescript
/** 会話レーン。決定的・不変。Firestore doc id はこのハッシュ */
type SessionKey = string;
// `agent:${profile}:${platform}:${scopeId}:${channelId}[:${threadId}]`

interface SessionDoc {
  key: SessionKey;
  sessionId: string;              // 現行トランスクリプト世代 "20260703_140000_ab12cd34"
  parentSessionId?: string;       // compaction 分割 / /new のチェーン
  status: "idle" | "running" | "resume_pending" | "suspended";
  conversation: ConversationRef;  // 返信先の正
  channelConfigId: string;        // チャンネル特化設定 ([architecture.md](architecture.md) §4)
  lease?: SessionLease;           // 実行ロック (§4)
  resume?: { markedAt: Timestamp; reason: string };  // 中断からの再開情報 (§6)
  lastActivityAt: Timestamp;
  modelOverride?: { model: string };   // api key は絶対に永続化しない (hermes の規律)
}
```

## 2. トランスクリプト: append-only エントリ列

pi の SessionEntry を Firestore サブコレクションに移植する。ツリー (branch) は初期実装では
不要と判断し **線形 + compaction エントリ**に簡略化する。branch が必要になったら
`parentEntryId` を足せば pi と同型になる (エントリ ID は最初から持たせておく)。

```typescript
type SessionEntry =
  | { type: "message"; message: AgentMessage }        // user/assistant/toolResult (pi の Message 型)
  | { type: "chat_ref"; direction: "in" | "out";      // チャット側メッセージとの対応付け
      platformMessageId: string; entryRef?: string }  //   Slack ts ↔ エントリの相互参照
  | { type: "compaction"; summary: string; firstKeptEntryId: string; tokensBefore: number }
  | { type: "config_change"; model?: string; prompt?: string }
  | { type: "mirror"; source: string; text: string }  // 他セッション/cron からの代理配送 (§8)
  | { type: "observed"; message: string }             // 起動しなかった周辺発言の観測ログ (§5)
  | { type: "artifact"; name: string; gcsUri: string; note: string }  // 成果物の台帳 (§7)
  | { type: "outcome"; summary: string; links: string[] };            // セッション終了時の要旨 (§8)

interface EntryDoc extends /* SessionEntry */ {
  id: string;          // 単調増加 ID (ts+乱数)。耐久カーソルとして機能 (pi get_entries since)
  sessionId: string;
  createdAt: Timestamp;
}
```

要点:

- **エラー・中断も message エントリに正規化** (`stopReason: "error" | "aborted"`)。
- **`chat_ref` で Slack メッセージ ⇔ エントリを双方向対応**させる。リアクションによる再開
  (「bot の発言 X に 👍 が付いた」→ どのセッションのどの時点か) の逆引きに必要。
  hermes の rich_sent_store が事後対処で作っていたものを最初から一級にする。
- **エントリ ID が耐久カーソル**。「最後に処理したエントリ ID」さえあれば、プロセス再起動を
  またいで差分同期できる (pi の since カーソル)。
- コンテキスト導出 `buildContext(entries): Message[]` は compaction エントリがあれば
  summary + firstKeptEntryId 以降だけを返す。**中断された tool_call の尻尾はここで除去**
  (hermes: SIGKILL 直後の未応答 tool_call が resume 時の無限再実行を起こす)。

## 3. セッションの単位: 何をレーンにするか

### 選択肢と評価

| 方式 | 長所 | 短所 |
|---|---|---|
| (a) メッセージ単位 | 実装最少 | 文脈ゼロ、連投で多重起動 |
| (b) チャンネル単位 + リセットポリシー (hermes 既定) | 常に文脈が続く | 無関係な話題が混ざる、長大化、並行 1 本 |
| (c) チャンネル × 時間窓 | 実装容易 | 窓境界で文脈が不自然に切れる |
| (d) **スレッド単位 (トリガーメッセージがスレッド根)** | Slack の UX と 1:1、境界が可視、並行自由 | スレッド文化がない場では使えない |
| (e) ユーザー単位 (hermes グループ既定) | プライバシー | 同じチャンネルで人ごとに文脈が違い Slack では不自然 |

### 推奨: (d) スレッド・ルーテッド + (b) をフォールバック

- **トリガーとなったメッセージのスレッドに bot が返信し、そのスレッド = 1 セッション**とする。
  `sessionKey` に threadId が入るので自然に成立する。Slack ボット (bolt AI assistant 等) の
  コミュニティ標準もこの形。境界 (どこまでが 1 セッションか) が人間にも見える。
- スレッド内の発言は**全参加者共有・送信者プレフィクス付き** (hermes のスレッド既定と同じ)。
- ユーザーがスレッドを使わず連投した場合: 同一チャンネルの**直近 T 分以内は既存スレッド
  セッションへ吸収する**か聞き分ける (§6 の再開判定)。チャンネル直下運用しかしない場では
  (b) チャンネルレーン + idle リセット (hermes: idle 24h / 毎日 4 時) に設定で切り替える。
- 時間枠はキーに入れない。**時間はリセットポリシーとして updated_at に対して評価する** (hermes)。

### セッション単位と返信先の分離 (session.mode / reply.mode)

上の (d)/(b) の切り替えを設定に落とすとき、**「セッション (文脈) の単位」と「返信の宛先」を
独立した 2 軸にする**。[chat-model.md](chat-model.md) §5.3 の「1 セッション内に複数の
thread_key が併存し、ホストが宛先解決する」というモデルがこの分離の土台で、
「文脈はチャンネルで 1 本、返事は話題ごとにスレッド」が成立する。

| session \ reply | thread (スレッドに返す) | flat (チャンネル直下に返す) |
|---|---|---|
| **thread** (スレッド = 1 会話) | 既定。通常チャンネル向け | 非推奨 (文脈が切れるのに返事だけ散らばる) |
| **channel** (チャンネル = 1 会話) | 文脈共有 + 話題ごとにスレッド返信 | DM・スレッド文化がない場 (連投で会話) |

- **sessionKey はポリシー導出**: thread モード = `channelId:threadTs ?? メッセージts` (現行)、
  channel モード = `channelId`。workdir・保存棚・lease・inbox はすべて sessionKey 由来。
- **reply 用 thread_key はメッセージごとに発行**し、宛先 (トリガーメッセージの位置) を
  ホストの宛先表に登録する。sessionKey と thread_key は別物 — sessionKey が同じでも
  メッセージごとに返信先スレッドは異なりうる。
- 境界規則 (mode によらず固定):
  1. **スレッド内で話しかけられたら、reply.mode に関わらずそのスレッドに返す**。
     reply.mode が効くのはチャンネル直下トリガーの返信先だけ。
  2. session=thread + reply=flat は許可するが warn (意味が薄い)。
- **channel モードは idle リセットとセット**: 前回活動から N 分超えたら transcript を
  世代交代して新規開始 (時間はキーに入れない、の帰結)。transcript の際限ない肥大も防ぐ。
- **サイズでも世代交代できる** (`maxTranscriptKb`): 長さの上限自体は pi の自動 compaction が
  守るが、再開初手の compaction コスト (全履歴を入力に食う要約 1 回 + 初ターンの遅延) を
  避けたい場合に、kick 時の transcript ファイルサイズで先回りして切る。バイト数はトークンの
  粗い代理だが、しきい値用途には十分。トークン基準 (usage 累計の永続化) は必要になったら。
  `idleResetMinutes` / `maxTranscriptKb` はいずれも channel モード専用のフィールドであり、
  thread モードで設定されていても世代交代は起きない — kick 時に warn ログを出して無視する。
- DM は予約名 `dm` の既定を `session: channel` + `reply: flat` とし、
  追加設定なしで「1 つの続いた会話」になる。implicit prompt cache の効率面でも、
  メッセージ単位セッションより transcript prefix の再利用が効く。
- 設定の置き場所は ChannelDoc ([config.md](config.md) §2)。ライブラリ利用者向けには
  sessionKey 導出関数の注入口を設けてもよいが、まず enum の 2 軸で足りるかを見る。

### 会話の流れの把握

起動時に渡す文脈は 3 層:

1. **セッション履歴** — エントリ列から導出 (§2)
2. **バックフィル** — トリガ前の周辺発言。観測ログ (`observed` エントリ) があればそれを、
   なければ `fetchHistory` で直近 N 件を取得して「[Channel context] ...」注記で 1 回だけ注入
3. **オンデマンド取得ツール** — `fetch_channel_history` / `fetch_thread` をエージェントの
   ツールとして与え、必要なら自分で遡らせる

「全部渡す」と「ツールで取らせる」の二択ではなく、**直近だけ渡し、それ以前はツール**が
トークンと網羅性のバランス点。

## 4. 実行ロックと steering (実行中の追加指示)

Cloud Run はインスタンス親和性がないため、hermes の `_running_agents` dict (プロセス内ロック)
は成立しない。**ロックとキューを最初から Firestore に置く** ([../research/hermes-session-model.md](../research/hermes-session-model.md) 避けるべき点 1 そのもの)。

```typescript
interface SessionLease {
  owner: string;        // Runner インスタンス ID + リクエスト ID
  epoch: number;        // 世代番号。古い保持者の書き込みを拒否 (hermes NS-570 の教訓)
  heartbeatAt: Timestamp;
  expiresAt: Timestamp; // heartbeat 更新。期限切れ = 保持者死亡とみなす
}

interface InboxItem {   // sessions/{key}/inbox サブコレクション
  id: string;
  event: ChatEvent;
  mode: "steer" | "followUp";  // 既定 steer
  createdAt: Timestamp;
}
```

フロー:

1. 受信側はイベントを常に **inbox に追記**する (起動判断を通過したもののみ)。
2. lease が生きていれば何もしない (実行中の Runner が拾う)。死んでいれば Runner を起動する。
   **起動の手段は差し替え可能**: Cloud Tasks で別サービスを叩く / Pub/Sub / **同一サービスの
   レスポンス後に実行 (CPU always-allocated)** のいずれでもよい。本設計のロック・キューは
   起動手段に依存しない。Slack 単一組織向けの具体形は [architecture.md](architecture.md) §1・§6
   (Cloud Tasks を使わない単一サービス案) を参照。
3. Runner は起動時に lease をトランザクションで取得 (取れなければ即 return)。
   inbox を drain してターンを回す。
4. **実行中の追加指示 (イベント駆動の push 配達 + pi 内部キュー)**: Runner は
   **新規イベントの受信を起点に**その場で inbox を drain し、あれば pi の 2 段キューに
   RPC で即時配達する (一定間隔のポーリングではない)。注入タイミング (steer = 次の LLM
   呼び出し前、followUp = ターン完了後) は pi 側が管理するため、ホストにターン境界の検出は
   不要。realtime リスナ (onSnapshot) は既定では使わない — 配達の起点は「イベントが来た
   こと」自体であり、Firestore の onSnapshot に依存しない。実装の分解 (配達/注入/削除) は
   [session-runtime.md](session-runtime.md) §4。
   - `steer` — 現在のツール実行は殺さず、**次の LLM 呼び出し前**に user メッセージとして注入
   - `followUp` — 現ターン完了後に新ターンとして処理
   割り込み (abort) は明示コマンド (`/stop`) のみ。hermes の知見:
   サブエージェント駆動中・compaction 中は steer をキューに自動降格して作業を守る。
5. ターン完了後に inbox を再確認 → 空なら **短い linger (例 60–120 秒)** だけ待ち、
   linger 満了直前にもう一度 drain して追撃発言を拾う (コンテキストがメモリに
   温かいまま連続ターンを処理でき、再起動コストを省ける)。linger 満了で lease 解放 → return
   → インスタンスは scale-to-zero 対象になる。

「実行中ターン 0 / inbox 空 / バックグラウンド作業なし」の 3 条件 AND で終了を判定するのは
hermes の is_idle 純関数の移植。バックグラウンド作業 (サブエージェント等) は
**リクエストの寿命に閉じ込める** — Cloud Run はリクエスト外の CPU がスロットリングされるため。

### なぜ realtime リスナ (onSnapshot) を既定にしないか

inbox には 2 つの役割がある: **(a) 追加メッセージを失わない耐久キュー** と
**(b) 実行中 Runner への「新着あり」通知**。(a) は Firestore が正しい用途だが、(b) を
onSnapshot で満たすと Firestore を「realtime メッセージング基盤」として使うことになり、
実行経路が realtime listener の課金・上限・接続維持に縛られる。

onSnapshot を要さない理由: **steer の意味論は「次の LLM 呼び出しの直前に注入」**であり、
実行中のツールは殺さない。つまり注入の最小粒度は**ターン境界**で、そこより早く気づいても
使い道がない。実装はイベント受信そのものを配達の起点にする (push) ため、onSnapshot が
提供するリアルタイム性は steer にはそもそもオーバースペックになる。

取りこぼしも起きない: inbox は耐久キューとして残り続け、enqueue 済みの item は ack される
まで消えない。
- 実行中の Runner → 次のイベント受信時の即時 drain (steer)、または agent_end / linger の drain で拾う
- Runner が拾う前に死んだ → lease 失効 → 次の起動時の inbox drain で拾う
- そもそも Runner がいない → イベント受信 (EventSource) が実行を駆動し、起動直後の drain で拾う
どのパスでも realtime 通知なしで届く。これは「プロセスは使い捨て、状態はストア、
どのインスタンスでも復元できる」という本設計の原則 (§1) にむしろ忠実。

**例外 (onSnapshot をオプトインする余地)**: 1 つのツールが数分回り続ける長時間ターンで、
その最中の軌道修正を即反映したいチャンネル。実装 (イベント駆動の push) はすでに
「気づいたら即配達」であり onSnapshot の主な利点を代替できているが、Runner プロセスが
イベントを受け取っていない間 (他インスタンスが処理中等) の即時性が必要になれば
onSnapshot を足せる。ただし耐久キューの土台は変えず、通知を「速める」最適化として
重ねるだけにする (土台は差し替えない)。

## 5. 起動判定と間引き

配送前 2 段 + 配送後 1 段の**三段ゲート**にする。hermes は「mention ゲート + observed 記録 +
NO_REPLY」の 3 点構成で、軽量 LLM 分類器を持たない ([../research/hermes-session-model.md](../research/hermes-session-model.md) §5)。本設計では要件
(自然文で書ける自動起動条件) のため中段に分類器を足す。

```
Layer 0: ハードフィルタ (コード)     … bot 発言・自己エコー・subtype・allowlist・dedupe・レート制限
Layer 1: 決定的トリガ (コード)       … bot メンション / DM / 特定リアクション / スラッシュコマンド
                                        → 無条件で起動
Layer 2: 分類器 (軽量 LLM)           … チャンネル設定の自然文条件 + 直近文脈で判定 → 起動/観測のみ
Layer 3: エージェント自身の沈黙      … 起動したが返答不要と判断したら reply を呼ばない ([chat-model.md](chat-model.md) §5.7)
```

### Gate は差し替え・合成できる部品にする

固定の 3 段でなく、**個々の Gate を実装として差し替え、複数を and/or で合成**できるようにする。
「LLM で判定 / キーワードマッチ / 素通し」はそれぞれ 1 つの Gate 実装で、チャンネルごとに
必要なものを並べる。Layer 0-3 は「よく使う既定プリセット」であって唯一の構成ではない。

```typescript
interface GateContext {
  event: ChatEvent;          // 判定対象の発言 ([chat-model.md](chat-model.md))
  recent: ChatEvent[];       // 直近 K 件 (分類器・デバウンスに使う)
  channel: ChannelConfig;    // criteria 等はここから
}

interface TriggerDecision { trigger: boolean; reason: string; urgency?: "low" | "high"; }

/** 起動判定の 1 単位。純粋関数に近い。副作用 (observed 記録等) は呼び出し側が持つ */
interface Gate {
  readonly name: string;
  decide(ctx: GateContext): Promise<TriggerDecision> | TriggerDecision;
}

// 実装例 (どれも同じ interface):
//   MentionGate      … bot メンション / DM / 特定リアクション → 決定的に trigger
//   KeywordGate      … 正規表現・語句マッチ (安価。分類器の前段プリフィルタにも)
//   ClassifierGate   … criteria + recent を Gemini Flash-Lite に渡し JSON 判定 (下記)
//   PassthroughGate  … 常に trigger=true (mention なしで全部拾う実験・DM 専用チャンネル用)
//   CooldownGate     … 直近起動からの経過で抑止 (合成の抑制子として挟む)
```

**合成**: Gate を配列で渡し、結合子で畳む。`any` (or) / `all` (and) を基本とし、
ハードフィルタ (Layer 0) だけは常に前段の `all` として固定する (安全側)。

```typescript
type GateCombinator = "any" | "all";

interface TriggerPolicy {
  gates: Gate[];            // 評価する Gate 群 (順序は短絡評価の順)
  combinator: GateCombinator; // any=どれか true で起動 / all=全て true で起動
  cooldownSec: number;      // 同一レーンの連続起動抑止 (CooldownGate に落としてもよい)
  debounceSec: number;      // 連投をまとめて 1 回で判定
}

// 既定プリセット (現行の 3 段ゲート):
//   { gates: [MentionGate, ClassifierGate], combinator: "any" }
//   → メンションされたら即起動、されなくても criteria に合えば起動 (Layer 1 or Layer 2)
// キーワードで安く絞ってから LLM に渡したい場合:
//   { gates: [KeywordGate, ClassifierGate], combinator: "all" }  (and: 語句 かつ 分類器)
```

- **どこで差し替えるか**: `ChannelConfig.trigger` が gates の種別と結合子・パラメータ (criteria,
  threshold 等) を宣言し、ホストが対応する Gate 実装を組み立てる。既定はパラメータ調整 (config)、
  足りなければ Gate 実装を足して差し替える 2 段構え。
- Layer 3 (エージェント自身の沈黙 = reply を呼ばない [chat-model.md](chat-model.md) §5.7) は Gate ではなく実行後の判断なので
  この合成には含めない。配送前が Gate 合成、配送後が「reply を呼ばない自由」という役割分担。

`ClassifierGate` の中身 (Layer 2 の実体):

```typescript
// criteria は自然文。例: "インフラのアラートや障害報告と思われる発言。
//   雑談や既に対応中と明言されたものは除く"
// Gemini Flash-Lite に「criteria + 直近 K 件 + 対象発言」を渡し JSON を返させる。
// 温度 0、structured output。1 判定 ≈ 数百トークン。
```

コストと精度の工夫:

- **デバウンスしてバッチ判定** — 発言ごとでなく「静止した連投のかたまり」に対して 1 回
- **否定結果も observed エントリとして記録** — 後でメンションされた時のバックフィルになる
  (hermes の observed=1 と同じ。判定に使った文脈が無駄にならない)
- **シャドーモード** — 分類器の判定をログするだけで起動しない期間を設け、自然文条件を
  チューニングしてから有効化する
- 埋め込み類似度による事前フィルタや正規表現プリフィルタは、分類器がまだ高頻度で呼ばれる
  場合の追加最適化として後付けできる (Layer 1.5)
- **人間によるリアクション起動** — 任意の発言に 🤖 等を付けたら Layer 1 扱いで起動。
  「分類器が拾い損ねた」の救済路として安価で強い

## 6. 再開 (resume) の設計

「メッセージ → 起動 → 応答 → 長時間経過 → 追加指示」を成立させる。

### 再開判定 (新規 vs 再開)

判定は決定的な規則で行い、LLM に委ねない (誤爆時の説明可能性のため):

1. **スレッド内の発言** → そのスレッドのセッションを再開 (sessionKey が同じなので自明)
2. **bot の発言へのリプライ/リアクション** → `chat_ref` エントリから当該セッションを逆引きして再開
3. **チャンネル直下の新規メンション** → 新規セッション (新しいスレッドを根にする)。
   ただし直近 T 分以内に同チャンネルで活動したセッションがあれば
   「続きですか?」と聞かずに済むよう、**新規セッションの文脈に前セッションの outcome (§8) を注入**する
4. **`/new`** → 明示的に新 sessionId へ回転 (キーは同じ、parentSessionId でチェーン)

「ルームごとに 1 実行 + 時間窓で再利用」案との比較: スレッド・ルーテッドなら「どの会話の
続きか」が構造で決まるため時間窓ヒューリスティクスが主役でなくなる。時間窓は
(3) の文脈引き継ぎと、チャンネルレーン運用時のリセットポリシーに限定して使う。

### 再開の考慮事項 (チェックリスト)

- **前回文脈の特定**: sessionKey → SessionDoc → 先端 sessionId (チェーン自己修復) → エントリ列導出
- **返信先の特定**: `conversation` フィールドが正。スレッド root が消えた場合は
  `errorKind: "thread_not_found"` を検出してチャンネル直下へフォールバック
- **鮮度窓**: `resume` マークからの自動再開は 1 時間以内に限定 (hermes)。超過したら
  resume を破棄し、次のユーザー入力を通常の再開として扱う
- **設定の復元**: モデル・プロンプト変更を config_change エントリで持ち、導出時に反映 (pi)
- **未完了ツールの掃除**: dangling tool_call の除去 (§2)
- **重複配送**: Slack のリトライ (event_id) と「lease 失効 → 別インスタンスが同じ inbox を
  再 drain」の両方が at-least-once。前者は inbox doc ID = event_id の `create()` で、
  後者は transcript に残る処理済み記録 (reply の tool 呼び出し含む) で冪等化
- **ワークスペースの再構成**: 成果物ディレクトリを GCS から hydrate (§7)
- **再開ループ遮断**: 「自動再開が自分をクラッシュさせる」ループを、Firestore 上の
  起動タイムスタンプのローリングウィンドウで検出して自動再開を止める (hermes restart_loop_guard)。
  単一サービス構成では外部キューのリトライ上限が無いぶん、このガードが唯一の砦になる
- **SIGTERM 対応**: Cloud Run の猶予 (10s) 内に resume マークを書く…のではなく、
  **drain 前 (ターン開始時) に resume 情報を先行永続化し、正常完了で消す** (hermes の先行マーキング)。
  SIGKILL されても再開できる

## 7. 実行環境の隔離と成果物

### 隔離

Cloud Run では「セッションごとに Docker コンテナを立てる」を直接はやらない。代わりに:

- **セッションごとの作業ディレクトリ + Firestore lease** — 1 インスタンスに複数セッションが
  同居しうる (concurrency=M) ため、分離の単位はプロセスでなく **workdir (tmpfs 上の
  セッション別ディレクトリ) + lease による 1 セッション 1 ライター** ([architecture.md](architecture.md) §4)。
  より強い分離が要るなら concurrency=1 に落とす選択肢も残る (コスト増と引き換え)
- **チャンネル特化はコンテナイメージ単位** — channelConfig が指す Runner サービス
  (= イメージ) を分ける。「インフラ調査用イメージ (gcloud, kubectl 入り)」等 ([architecture.md](architecture.md) §4)
- さらに強い隔離が要る場合 (信頼できないコード実行) は、ターン内から Cloud Run Jobs /
  Cloud Build を子サンドボックスとして spawn する段階的強化とする

### 成果物

```
gs://<bucket>/sessions/<sessionId>/
  workspace/    … 作業ディレクトリの dehydrate 先。ターン終了時に同期、再開時に hydrate
  artifacts/    … 明示的に「残す」と宣言されたファイル (レポート等)
  outcome.md    … セッション要旨 (§8)
```

- ターン開始: `workspace/` を Cloud Run のローカル (tmpfs) へ hydrate
- ターン終了: 変更を dehydrate。全ファイルではなく `artifact` 宣言 + workspace 差分に限る
- チャットへの送出は選択的: エージェントが `publish_file` ツールで明示したものだけ
  `uploadFile` する。「全部チャットに投稿」はしない
- `artifact` エントリ (§2) が台帳。再開時・他セッションからの参照はこの台帳経由

### 初期状態・環境の与え方

原則は **能力 = イメージ、振る舞い = Config、状態 = GCS** ([config.md](config.md) に
判断基準の全体)。初期版では能力 (skill/CLI) はイメージの固定パスに焼き、channelConfig は
振る舞いのテキストだけを持つ:

```typescript
interface EnvironmentSpec {
  systemPrompt?: string;          // 振る舞いのテキスト (app 共通への追記)
  context?: string[];             // 初回ターンに注入する短い参照テキスト
  docsets?: { gcsPrefix: string; mountAs: string }[];  // 大きな読み取り専用データは GCS から
  // 将来拡張: image (チャンネル特化イメージ) / skills, mcpServers (有効化選択) — [config.md](config.md) §2
}
```

リポジトリはコールドスタートを圧迫するので Config で clone を指定させない —
イメージに焼き込む (更新頻度低) か GCS にミラーした tarball を展開する (数秒) を基本にし、
git fetch は差分のみ ([config.md](config.md) §5)。

## 8. 別セッションの成果物へのアクセス (非 RAG)

検索/RAG 以外のアプローチ:

1. **outcome ノート + 索引注入 (メモリインデックス方式)** — セッション終了時に
   エージェント自身へ「1 行の要旨 + 詳細 outcome.md」を書かせ、チャンネル単位の
   `INDEX.md` (1 セッション 1 行) を新規セッションのシステムプロンプトに常時注入する。
   本文はエージェントが必要時に `read_outcome(sessionId)` ツールで読む。
   Claude Code のメモリディレクトリと同じ「索引は常駐、本文はオンデマンド」二層
2. **チャット自体をストアにする** — outcome をスレッドの最終投稿として Slack に残す。
   他セッションは `fetch_thread` ツールで読める。人間と bot が同じ記録を見る、
   追加インフラ不要、Slack 検索がそのまま効く。スレッド・ルーテッド設計との相性が良い
3. **mirror エントリ (プッシュ型)** — セッション A が別会話 B へ送信・言及したとき、
   B のセッションに `mirror` エントリを追記して文脈を先回りで届ける (hermes mirror)。
   role の教訓: 代理配送を assistant で書くと strict-alternation なプロバイダが壊れる → user 扱い
4. **成果物台帳の横断ブラウズ** — `artifact` エントリを channel/scope で横断する
   `list_artifacts(filter)` ツール。「あのとき作ったレポート」をパス知識なしで辿れる
5. **リンクグラフ** — outcome / mirror に `[[session:xyz]]` 形式の参照を書かせ、
   参照解決ツールで芋づる式に辿る。検索でなく明示リンクによるナビゲーション
6. **共有ハンドブック** — チャンネルごとに 1 つの追記型ドキュメント (runbook) を置き、
   セッションが学んだ恒久知識 (アラート X の定番原因は Y) を追記させる。
   セッション成果物 (インスタンス) と恒久知識 (クラス) を分けて蓄積する

推奨は 1 + 2 の併用を基本線に、必要が生じたら 3, 6 を足す。

## 9. セッション状態機械 (まとめ)

```
                 ┌────────────────────────────────────────────┐
   trigger ──▶ idle ──lease 取得──▶ running ──ターン完了・inbox 空──▶ linger ──満了──▶ idle
                 ▲                    │  ▲                             │
                 │                    │  └── inbox 着信 (steer/followUp)┘
                 │          SIGTERM/クラッシュ (lease 失効)
                 │                    ▼
                 └──鮮度窓超過── resume_pending ──次のイベント受信 or 定期 sweep──▶ running
```

- すべての遷移は Firestore 上のフィールド更新で表現され、インスタンスの生死と独立
- lease epoch により、ゾンビ保持者 (失効後に生き返った旧 Runner) の書き込みは拒否される
