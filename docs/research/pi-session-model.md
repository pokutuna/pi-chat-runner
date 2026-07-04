# pi (earendil-works/pi) セッションモデル調査

pi (Mario Zechner 作の coding agent, リポジトリ: /Users/pokutuna/ghq/github.com/earendil-works/pi) における
「セッションのモデリング・永続化・再開・外部からの操作」の as-is 実装調査。
file:line は同リポジトリからの相対パス。ドキュメントは `packages/*/docs/` 配下に存在する
(リポジトリルートの docs/ は空。session-format.md, rpc.md, compaction.md, sdk.md, sessions.md が特に充実)。

---

## 1. アーキテクチャ全体像

パッケージは 5 つ。依存は一方向のレイヤ構造になっている。

```
┌─────────────────────────────────────────────────────────────┐
│ orchestrator (実験的)                                        │
│  複数の pi RPC プロセスを spawn/管理する常駐デーモン          │
│  UNIX socket JSONL IPC + Radius (クラウド presence) 連携     │
└───────────────┬─────────────────────────────────────────────┘
                │ child_process.spawn("pi --mode rpc") / stdin・stdout JSONL
┌───────────────▼─────────────────────────────────────────────┐
│ coding-agent (@earendil-works/pi-coding-agent)               │
│  AgentSession: セッション永続化(JSONL tree)・compaction・     │
│  拡張機構・ツール群。modes: interactive(TUI)/print/rpc        │
└───────┬──────────────────────────────┬──────────────────────┘
        │                              │
┌───────▼───────────────┐   ┌──────────▼──────────────────────┐
│ agent                 │   │ tui (@earendil-works/pi-tui)     │
│  Agent: ステートフルな │   │  端末 UI フレームワーク           │
│  ループ + steer/       │   │  (差分レンダリング; セッション    │
│  followUp キュー       │   │   モデルとは独立)                │
└───────┬───────────────┘   └─────────────────────────────────┘
        │
┌───────▼───────────────────────────────────────────────────┐
│ ai (@earendil-works/pi-ai)                                 │
│  Message/Model/Usage 型、プロバイダ抽象、streamSimple       │
└────────────────────────────────────────────────────────────┘
```

責務の分離が明確:

- **ai**: LLM 呼び出しの型とストリーミング (`Message`, `AssistantMessageEvent`, `Model`)。
- **agent**: 純粋なエージェントループ。永続化を知らない。`AgentMessage` を拡張可能にする抽象だけ持つ。
- **coding-agent**: 永続化 (SessionManager)・compaction・拡張・RPC/TUI モード。`AgentSession` が中核ファサード。
- **orchestrator**: pi プロセス群のスーパーバイザ。「1 セッション = 1 子プロセス」を外部 (CLI/リモート) から操作可能にする。

---

## 2. エージェントループとメッセージモデル

### 2.1 ai パッケージのコア型

`packages/ai/src/types.ts` に LLM レベルの型がある。

```typescript
// packages/ai/src/types.ts:377-408
interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}
interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: Api; provider: ProviderId; model: string;
  usage: Usage;                     // input/output/cacheRead/cacheWrite/cost (types.ts:352)
  stopReason: StopReason;           // "stop"|"length"|"toolUse"|"error"|"aborted" (types.ts:375)
  errorMessage?: string;
  timestamp: number;
}
interface ToolResultMessage<TDetails = any> {
  role: "toolResult";
  toolCallId: string; toolName: string;
  content: (TextContent | ImageContent)[];
  details?: TDetails;               // UI/ログ用の構造化メタデータ (LLM には送らない)
  isError: boolean; timestamp: number;
}
type Message = UserMessage | AssistantMessage | ToolResultMessage;
```

ポイント:
- エラーや中断も `AssistantMessage` の `stopReason: "error" | "aborted"` として **メッセージに正規化**される。ストリーム関数は例外を投げない契約 (packages/agent/src/types.ts:20-26)。
- ストリーミングの delta は `AssistantMessageEvent` (types.ts:453-465)。`text_delta` / `thinking_delta` / `toolcall_delta` などの各イベントが「delta + その時点の partial メッセージ全体」を両方持つ。

### 2.2 agent パッケージ: AgentMessage と AgentState

```typescript
// packages/agent/src/types.ts:305-314
interface CustomAgentMessages {}   // アプリ側が declaration merging で拡張
type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];
```

LLM メッセージ + アプリ独自メッセージ (通知・bash 実行結果など) の合成型。LLM 呼び出し前に
`convertToLlm: (messages: AgentMessage[]) => Message[]` (types.ts:169) で LLM が理解できる形に変換/除外する。
coding-agent はこれを使って `bashExecution` ロールを `UserMessage` に変換したり `custom` ロールを注入したりする。

```typescript
// packages/agent/src/types.ts:322-347 (抜粋)
interface AgentState {
  systemPrompt: string;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;    // "off"|"minimal"|"low"|"medium"|"high"|"xhigh" (types.ts:289)
  tools: AgentTool<any>[];
  messages: AgentMessage[];        // 会話トランスクリプト
  readonly isStreaming: boolean;
  readonly streamingMessage?: AgentMessage;   // ストリーム中の部分メッセージ
  readonly pendingToolCalls: ReadonlySet<string>;
  readonly errorMessage?: string;
}
```

ツールは `AgentTool` (types.ts:371-394)。`execute(toolCallId, params, signal, onUpdate)` の
`onUpdate` コールバックで部分結果をストリームできる (→ `tool_execution_update` イベント)。

### 2.3 Agent クラスと steering/followUp キュー

`packages/agent/src/agent.ts:166` の `Agent` クラスがループのステートフルなラッパ。

- `prompt(input)` (agent.ts:325): 新規実行。実行中なら throw。
- `steer(message)` (agent.ts:264) / `followUp(message)` (agent.ts:269): 実行中に注入するキュー。
  `PendingMessageQueue` (agent.ts:118-152) は `QueueMode = "all" | "one-at-a-time"` で drain 粒度を制御。
- `continue()` (agent.ts:338): トランスクリプト末尾から継続。末尾が assistant ならキューを消化して再開。
- `abort()` (agent.ts:300): AbortController で中断。
- `subscribe(listener)` (agent.ts:231): `AgentEvent` の購読。listener は **await される** (イベント処理がバックプレッシャになる)。

### 2.4 低レベルループ (agent-loop.ts)

`runAgentLoop` (packages/agent/src/agent-loop.ts:95) / `runAgentLoopContinue` (:120) → 共通の `runLoop` (:155-269)。

```
外側ループ (follow-up 用):
  内側ループ while (hasMoreToolCalls || pendingMessages):
    turn_start
    pendingMessages を context に注入 (:182-190)
    streamAssistantResponse()      # LLM 1 回呼び出し
    toolCalls があれば executeToolCalls()  # sequential/parallel
    turn_end
    prepareNextTurn?() で context/model を差し替え可能 (:226-239)
    shouldStopAfterTurn?() で graceful stop (:241-251)
    pendingMessages = getSteeringMessages()   # ← steering 注入点 (:253)
  followUpMessages = getFollowUpMessages()    # 停止直前に確認 (:257)
  あれば継続、なければ agent_end
```

**steering の実装ポイント**: 割り込みは「現在の assistant ターンのツール実行完了後、次の LLM 呼び出し前」
に user メッセージとして context に追加される方式。実行中のツールをキャンセルしない
(ドキュメント: packages/coding-agent/docs/rpc.md の steer 節も同じ説明)。

### 2.5 AgentEvent

```typescript
// packages/agent/src/types.ts:413-428
type AgentEvent =
  | { type: "agent_start" } | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" } | { type: "turn_end"; message; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message } 
  | { type: "message_update"; message; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message }
  | { type: "tool_execution_start"; toolCallId; toolName; args }
  | { type: "tool_execution_update"; toolCallId; toolName; args; partialResult }
  | { type: "tool_execution_end"; toolCallId; toolName; result; isError };
```

---

## 3. セッションの永続化と再開 (coding-agent)

### 3.1 ファイル形式: JSONL + id/parentId のツリー

ドキュメント: packages/coding-agent/docs/session-format.md。実装: packages/coding-agent/src/core/session-manager.ts。

- 保存先: `~/.pi/agent/sessions/--<cwd を - 置換>--/<timestamp>_<uuid>.jsonl`
  (getDefaultSessionDirPath, session-manager.ts:439-444)。
- 1 行目が `SessionHeader` (`{type:"session", version:3, id, timestamp, cwd, parentSession?}`, session-manager.ts:32)。
- 以降の各行は `SessionEntry`。**全エントリが `id` (8 桁 hex) + `parentId` を持つツリー構造** (session-manager.ts:46-51)。
  ファイルは append-only で、branch はファイル内の parentId 付け替えで表現される (新ファイルを作らない)。

```typescript
// packages/coding-agent/src/core/session-manager.ts:140-151
type SessionEntry =
  | SessionMessageEntry          // {type:"message", message: AgentMessage} (:53)
  | ThinkingLevelChangeEntry     // 思考レベル変更 (:58)
  | ModelChangeEntry             // モデル切替 (:63)
  | CompactionEntry              // {summary, firstKeptEntryId, tokensBefore} (:69)
  | BranchSummaryEntry           // ブランチ離脱時の要約 {summary, fromId} (:80)
  | CustomEntry                  // 拡張の状態 (LLM context に入らない) (:100)
  | LabelEntry                   // ブックマーク (:107)
  | SessionInfoEntry             // 表示名 (:114)
  | CustomMessageEntry;          // 拡張注入メッセージ (context に入る) (:131)
```

セッションバージョンは 3 (session-manager.ts:30)。v1 (線形) → v2 (ツリー) → v3 (ロール改名) をロード時に自動マイグレーション (:815-817)。

### 3.2 branch / fork / clone

- **ファイル内 branch**: `branch(entryId)` で leaf を過去エントリへ移動し、次の追記がそこから分岐する。
  `/tree` ナビゲーション時は捨てるブランチの LLM 要約を `BranchSummaryEntry` として分岐点に残せる
  (docs/compaction.md「Branch Summarization」、branchWithSummary)。
- **ファイル間 fork**: `SessionManager.forkFrom(sourcePath, targetCwd)` (session-manager.ts:1448) や RPC の
  `fork`/`clone` コマンド。新ファイルの header に `parentSession` として元ファイルパスを記録。
- RPC 実装では clone = 「現在の leaf を position "at" で fork」(modes/rpc/rpc-mode.ts:592-602)。

### 3.3 保存タイミング

保存は **イベント駆動で即時 append**。`AgentSession` がコンストラクタで agent を購読し
(core/agent-session.ts:353)、`message_end` イベントで永続化する:

```typescript
// core/agent-session.ts:518-535 (要旨)
if (event.type === "message_end") {
  if (event.message.role === "custom") sessionManager.appendCustomMessageEntry(...);
  else if (role が user|assistant|toolResult) sessionManager.appendMessage(event.message);
}
```

`_appendEntry` (session-manager.ts:941-946) が in-memory ツリー更新 + `_persist`。
`_persist` (session-manager.ts:912-939) には工夫があり、**最初の assistant メッセージが到着するまで
ファイルを書かない** (flushed フラグ)。プロンプト送信だけで中断されたゴミセッションファイルを作らないための遅延フラッシュ。
到着時に全エントリを一括書き出し、それ以降は `appendFileSync` で 1 行ずつ追記。

モデル変更・思考レベル変更・compaction・セッション名変更などもすべてエントリ追記
(agent-session.ts:1456, 1552, 1731, 2685 など)。

### 3.4 再開 (resume) とコンテキスト復元

CLI (packages/coding-agent/src/main.ts:300-350):

- `pi -c` → `SessionManager.continueRecent(cwd)` (main.ts:338-339, 実装 session-manager.ts:1426): 同一 cwd の最新セッションを開く。
- `pi -r` → `SessionManager.list()/listAll()` でセレクタ表示 → `SessionManager.open(path)` (main.ts:321-336)。
- `pi --session <path|id>` → id 完全一致で open、なければその id で新規作成 (main.ts:342-349)。
- 別プロジェクトのセッションは fork を促す (main.ts:305-313)。

コンテキスト復元は `buildSessionContext()` (session-manager.ts:325-433):

1. leaf から parentId を辿って root までのパスを収集 (:356-363)。
2. パス上の `model_change` / `thinking_level_change` / assistant メッセージから **現在のモデルと思考レベルを復元** (:365-380)。
3. パス上に `CompactionEntry` があれば、「summary メッセージ → firstKeptEntryId 以降の kept メッセージ → compaction 以降のメッセージ」の順で LLM 送信メッセージ列を構築 (:401-424)。
4. `branch_summary` / `custom_message` エントリも対応するメッセージ型に変換して混ぜる (:389-399)。

つまり **セッションファイルが唯一の真実で、LLM コンテキストは毎回ツリーから導出される**。

### 3.5 compaction / トークン溢れ対策

ドキュメント: packages/coding-agent/docs/compaction.md。実装: core/compaction/compaction.ts + agent-session.ts。

- **トリガー** (`_checkCompaction`, agent-session.ts:1811-1900):
  - threshold: `contextTokens > contextWindow - reserveTokens` (デフォルト reserve 16384、settings で変更可)。
    agent_end 後およびプロンプト送信前にチェック。
  - overflow: LLM がコンテキスト溢れエラーを返した場合。エラー assistant メッセージを agent state から除去し
    (セッションファイルには履歴として残す)、compaction 後に **1 回だけ自動リトライ** (`_overflowRecoveryAttempted`, :1848-1868)。
  - manual: `/compact [instructions]` または RPC `compact`。
- **手順** (docs/compaction.md): 新しい方から `keepRecentTokens` (デフォルト 20k) 分を残す cut point を探し
  (tool result では切らない、ターン境界優先、巨大ターンは split turn として 2 段要約)、古い部分を構造化フォーマット
  (Goal/Progress/Key Decisions/Next Steps + read-files/modified-files) で LLM 要約。
- **結果は `CompactionEntry` として append** (`appendCompaction`, agent-session.ts:1731, 2012)。破壊的でない:
  全履歴はファイルに残り、`buildSessionContext` が summary + kept 以降だけを LLM に見せる。
  ファイル操作履歴 (readFiles/modifiedFiles) は compaction をまたいで累積。
- 拡張が `session_before_compact` イベントで要約をカスタム実装/キャンセルできる。
- イベント: `compaction_start` / `compaction_end` (reason: "manual"|"threshold"|"overflow", willRetry フラグ付き) (agent-session.ts:138-148)。

### 3.6 AgentSession と AgentSessionRuntime

- `AgentSession` (core/agent-session.ts:266): Agent + SessionManager + SettingsManager + 拡張ランナー + モデルレジストリの
  ファサード。`prompt/steer/followUp/abort/compact/setModel/...` を提供。
  `prompt()` はストリーミング中なら `streamingBehavior: "steer" | "followUp"` の指定を要求する (:1043-1056)。
- `AgentSessionRuntime` (core/agent-session-runtime.ts:75): セッション切替 (`newSession`/`switchSession`/`fork`) のたびに
  cwd 束縛サービスごと作り直すホスト。RPC/TUI モードはこれを介してセッションを差し替え、`rebindSession` でイベント購読を張り直す。
- SDK: `createAgentSession()` (core/sdk.ts:166) で Node.js アプリに直接埋め込める
  (docs/sdk.md。サブプロセス不要のインプロセス利用)。

---

## 4. orchestrator パッケージ

**位置づけ**: 実験的 (README に "Experimental" 明記)。「ローカルマシン上で複数の pi RPC プロセス (= セッション) を
spawn・管理し、UNIX ソケット経由で外部から RPC を仲介する常駐デーモン」。さらに Radius というクラウドサービスに
presence を登録する。オーケストレーションの対象は **マルチエージェント協調ではなくプロセスライフサイクル**である
(現状 spawn/list/status/stop/rpc のみで、エージェント間のメッセージルーティング等はない)。

### 4.1 構成

- `serve.ts:9-77`: エントリポイント。`~/.pi/orchestrator/orchestrator.sock` (config.ts:67-69) に IPC サーバを立て、
  `supervisor.recoverAfterRestart()` → Radius 有効なら presence 開始。SIGINT/SIGTERM で全インスタンス停止。
- `storage.ts:35-70`: `~/.pi/orchestrator/instances.json` / `machine.json` への同期的 JSON 永続化。
  `InstanceRecord` (types.ts:15-25) は `{id, status, cwd, sessionId?, sessionFile?, radiusPiId?, label?}`。
  **注意**: 永続化されるのはインスタンスのメタデータのみ。会話本体は各子プロセスのセッション JSONL が持つ。
- `supervisor.ts:63` `OrchestratorSupervisor`:
  - `spawnInstance({cwd, label})` (:270-298): UUID 発行 → `createRpcProcessInstance` で子プロセス起動 →
    `get_state` RPC で sessionId/sessionFile を取得して record に同期 (`syncInstanceRecord`, :140-155) →
    Radius に Pi 登録 → status "online"。
  - `handleRpc(instanceId, command)` (:321-333): 子プロセスへ RPC 転送。`new_session/switch_session/fork/clone/
    set_session_name/prompt` の後だけ `get_state` を再取得してメタデータを追従 (SESSION_METADATA_COMMANDS, :41-48)。
  - `openRpcStream(instanceId, onEvent, onUiRequest)` (:197-233): 購読ハンドルを返す。複数購読者
    (subscribers Set) に子プロセスの全イベントをファンアウト (:102-106)。
  - `recoverAfterRestart()` (:244-255): **再起動後、online/starting だったレコードを "stopped" に落とすだけ**。
    子プロセスの再接続・セッション自動再開はしない (再開するには新規 spawn + `switch_session` を送る必要がある。
    これは実装からの推測ではなく、コード上に再 attach 経路が存在しないという事実)。
  - 子プロセス異常終了時は status "error" にして Radius 登録を解除 (:115-134)。
- `rpc-process.ts:25` `RpcProcessInstance`: 子プロセスラッパ。
  - spawn コマンド (:50-61): Bun バイナリなら同 dir の `pi --mode rpc`、Node なら
    `@earendil-works/pi-coding-agent/rpc-entry` を直接実行。
  - `send(command)` (:143-159): `id` が無ければ `orchestrator_<n>_<uuid>` を採番して stdin に JSONL 書き込み、
    `pendingRequests` Map で `type:"response"` の同 id 行と突き合わせて Promise 解決 (:101-115)。
  - `type:"extension_ui_request"` は uiRequestHandler へ、それ以外の行は**すべてイベントとして** eventListeners へ
    (:117-127)。つまりレスポンス相関は id、イベントは型で振り分けるだけの素朴な多重化。

### 4.2 IPC プロトコル (ipc/protocol.ts)

リクエスト (ipc/protocol.ts:10-52):

| type | 内容 |
|------|------|
| `spawn` | `{cwd, label?}` → InstanceSummary |
| `list` / `status` / `stop` | インスタンス管理 |
| `rpc` | `{instanceId, command: RpcCommand}` 単発 RPC (1 接続 1 リクエスト) |
| `rpc_stream` | 接続を双方向ストリームに**アップグレード** |

`rpc_stream` はソケットの data リスナを付け替えて (ipc/server.ts:68-136)、以降その接続上で
クライアント→ `RpcCommand | RpcExtensionUIResponse`、サーバ→ `RpcResponse | AgentSessionEvent |
RpcExtensionUIRequest` を JSONL で流し続ける。リクエストは Promise チェーンで直列化 (:96-132)。
切断時に `rpcStream.close()` で購読解除 (:134)。

CLI (`cli.ts:19-23`): `orchestrator serve | list | spawn | status | stop | rpc <id> <json> | rpc-stream <id>`。
`rpc-stream` は stdin/stdout をソケットに橋渡しするので、シェルから実行中セッションに steer を送れる。

### 4.3 外部からの steering の経路

実行中セッションへのメッセージ注入は、orchestrator 自体には固有ロジックがなく、**coding-agent の RPC
コマンドをそのまま転送**することで実現される:

```
外部クライアント
  → orchestrator.sock に {"type":"rpc","instanceId":X,"command":{"type":"steer","message":"..."}}
  → supervisor.handleRpc → RpcProcessInstance.send → 子プロセス stdin
  → rpc-mode.ts:414 session.steer() → AgentSession._queueSteer (agent-session.ts:1249)
  → Agent.steer() → agent-loop の次ターン開始前に注入 (agent-loop.ts:253)
```

### 4.4 Radius 連携 (radius.ts)

- `https://radius.pi.dev/` (radius.ts:7) への presence 登録。machine (orchestrator ホスト) と
  pi (インスタンス) をそれぞれ `machines/register` / `pis/register` に POST し、heartbeat を打ち続ける
  (:194-215, :308-405)。404 が 3 回続くと再登録、その他エラーは指数バックオフ。
- 登録 payload に `transport: "local-rpc"`, `capabilities: {rpc:true, relay:false, iroh:false}`,
  `sessionId` を含む (:202-211)。
- 認証は `~/.pi/agent/auth.json` の radius OAuth credential か `PI_RADIUS_API_KEY` (:130-142)。
- **推測**: relay/iroh といった capability フラグや presence 情報から、Radius は「どのマシンでどのセッションが
  動いているか」を集約し、将来的にリモートから relay 経由でセッションを操作するための布石と見られる。
  現行コードには Radius からコマンドを受信する経路はなく、一方向の presence 報告のみ (これは事実)。

---

## 5. RPC モード / ヘッドレス実行

### 5.1 起動

- `pi --mode rpc` (main.ts:101, 808) または専用エントリ `rpc-entry.ts`
  (packages/coding-agent/src/rpc-entry.ts:12 が `main(["--mode","rpc", ...])` を呼ぶだけ)。
- セッション永続化は TUI と同一 (`--no-session` で無効化、`--session-dir` で変更可)。
  **TUI と RPC は同じセッションファイルを共有できる**ため、TUI で始めたセッションを RPC で resume する運用が可能。

### 5.2 プロトコル (modes/rpc/rpc-mode.ts, docs/rpc.md)

stdin: JSONL コマンド、stdout: JSONL のレスポンス + イベント。フレーミングは LF 区切りの厳密 JSONL
(U+2028/2029 を改行扱いする Node readline は不可、docs/rpc.md:29-37)。

コマンド一覧 (`handleCommand`, rpc-mode.ts:382-691):

| カテゴリ | コマンド |
|---------|---------|
| プロンプト | `prompt` (streamingBehavior: steer/followUp), `steer`, `follow_up`, `abort`, `new_session` |
| 状態 | `get_state`, `get_messages`, `get_session_stats`, `get_last_assistant_text` |
| モデル | `set_model`, `cycle_model`, `get_available_models`, `set_thinking_level`, `cycle_thinking_level` |
| キュー | `set_steering_mode`, `set_follow_up_mode` |
| compaction | `compact`, `set_auto_compaction` |
| リトライ | `set_auto_retry`, `abort_retry` |
| bash | `bash`, `abort_bash` (出力は次 prompt 時に context 注入) |
| セッション | `switch_session`, `fork`, `clone`, `get_fork_messages`, `get_entries`, `get_tree`, `set_session_name`, `export_html` |
| その他 | `get_commands` (拡張コマンド/プロンプトテンプレート/スキル一覧) |

設計上の注目点:

- **`prompt` の応答セマンティクス** (rpc-mode.ts:390-412): preflight (モデル検証・キュー受理) が成功した時点で
  `success:true` を返し、実行結果はイベントストリームで別途流す。受理後の失敗は同じ id で二重応答しない。
- **`get_entries` の cursor** (rpc-mode.ts:609-620, docs/rpc.md): エントリ id が安定しているため
  `{"type":"get_entries","since":"<last-id>"}` で**クライアント再起動をまたぐ差分取得**ができる。
  `leafId` も返すのでブランチ移動の検出も 1 往復。`get_messages` と違い compaction 前の履歴や捨てブランチも含む。
- **extension UI サブプロトコル** (rpc-mode.ts:78-310): 拡張が `ctx.ui.confirm()` 等を呼ぶと
  `extension_ui_request` が stdout に出て、クライアントが `extension_ui_response` (id 相関) を返すまでブロック。
  timeout 付きならエージェント側でデフォルト値に自動解決。ツール実行許可ダイアログのような
  human-in-the-loop をヘッドレスでも成立させる仕組み。

### 5.3 外部アプリ (チャットボット等) からの利用形態

3 段階の選択肢がある:

1. **インプロセス (Node.js/TS)**: `createAgentSession()` + `AgentSession` を直接使う (docs/rpc.md:5 が推奨)。
2. **サブプロセス**: `pi --mode rpc` を spawn して JSONL。型付きクライアント `RpcClient`
   (modes/rpc/rpc-client.ts, modes/index.ts:7 で export) が提供される。
3. **デーモン経由**: orchestrator を常駐させ、ソケット越しに複数セッションを spawn/操作
   (プロセスの生存がクライアントから独立する)。

---

## 6. イベントストリーム

### 6.1 イベントの流れ

```
pi-ai streamSimple ──AssistantMessageEvent──▶ agent-loop
agent-loop ──AgentEvent──▶ Agent.processEvents (state 更新, agent.ts:509-556)
  ──▶ AgentSession._handleAgentEvent (agent-session.ts:490-559)
        ├─ 拡張へ emit (_emitExtensionEvent, :614-685)
        ├─ AgentSessionEvent として購読者へ (_emit)
        └─ message_end で SessionManager へ永続化
rpc-mode: session.subscribe(event => stdout に JSONL) (rpc-mode.ts:354-356)
orchestrator: 子プロセス stdout → RpcProcessInstance.onEvent → subscribers へファンアウト
  → rpc_stream ソケットへ JSONL (ipc/server.ts:79-87)
```

`AgentSessionEvent` (agent-session.ts:126-150) は `AgentEvent` に `queue_update` /
`compaction_start/end` / `auto_retry_start/end` / `session_info_changed` / `thinking_level_changed` を追加し、
`agent_end` に `willRetry` を付与した型。

### 6.2 部分出力の粒度

2 レイヤの streaming がある:

- **テキスト/思考/ツール引数**: `message_update` イベントの `assistantMessageEvent` に
  `text_delta` / `thinking_delta` / `toolcall_delta` などが入る (docs/rpc.md:871-911)。
  delta と partial (その時点のメッセージ全体) の両方を持つので、クライアントは追記でも置換でも実装できる。
- **ツール実行の途中経過**: `tool_execution_update` の `partialResult` は **delta ではなく累積値**
  (docs/rpc.md:956: "contains the accumulated output so far ... allowing clients to simply replace their display")。
  bash の出力などが該当。`toolCallId` で相関。

購読方法: インプロセスなら `session.subscribe()` / `agent.subscribe()` (await されるので遅い listener は
ループ全体を遅くする点に注意)、プロセス外なら stdout JSONL、orchestrator 経由なら `rpc_stream`。
RPC モードは stdout のバックプレッシャを agent 購読で待つ (`waitForRawStdoutBackpressure`, rpc-mode.ts:357-359)。

---

## 7. 設計の学び / 転用できそうなポイント

Slack ボットのバックエンドとしてエージェントセッションを永続化・再開・steering する場合に真似したい点:

1. **append-only JSONL ツリー + 導出コンテキスト**
   「保存された履歴 (全エントリ)」と「LLM に見せるコンテキスト (leaf→root パスから導出)」を分離するのが最重要の学び。
   compaction・branch・モデル切替をすべて「エントリの追記」で表現でき、破壊的更新が一切ない。
   Slack スレッド 1 本 = セッション 1 ファイル (or 1 レコード列) とし、`buildSessionContext` 相当を毎回導出すればよい。

2. **メッセージ以外もエントリにする**
   model_change / thinking_level_change / session_info / custom (アプリ状態) までツリーに入れることで、
   resume 時に「どのモデル・設定で動いていたか」まで完全復元できる (session-manager.ts:365-380)。

3. **steer / followUp の 2 段キュー**
   実行中の追加発言を「次の LLM 呼び出し前に割り込む steer」と「完了後に処理する followUp」に分けるのは
   Slack のような非同期チャットと相性が良い。割り込みはツール実行を殺さず、ターン境界でのみ注入する
   (agent-loop.ts:253) ので実装が単純で安全。`queue_update` イベントで「キュー済み」を UI に見せられるのも良い。

4. **エラーの正規化**
   LLM エラー・中断を `stopReason: "error"|"aborted"` の AssistantMessage として履歴に残す設計。
   例外パスが減り、リトライ (auto_retry) やオーバーフロー回復 (compact して 1 回だけ再試行) が
   通常のイベントフローに乗る。

5. **entry id を耐久カーソルにした差分同期** (`get_entries` + `since` + `leafId`)
   Slack ボットプロセスが再起動しても「最後に投稿したエントリ id」さえ保存していれば取りこぼしなく追従できる。
   イベントストリーム (push) とカーソル同期 (pull) の両方を用意する構えは、配送保証のない Slack Events API と
   組み合わせるうえで特に有効。

6. **preflight-ack + 非同期イベントの応答分離**
   `prompt` はキュー受理時点で ack し、結果はイベントで流す (rpc-mode.ts:390-412)。Slack なら「👀 リアクション
   で ack → ストリーミング更新 → 完了で ✅」に素直に対応する。

7. **プロセス分離とスーパーバイザ (orchestrator パターン)**
   1 セッション = 1 子プロセス + メタデータだけの instances.json + RPC ブリッジ、という構成は
   クラッシュ隔離と cwd 分離に効く。ただし pi の orchestrator は再起動後にセッションへ自動再 attach しない。
   会話本体がセッションファイルにあるので「新プロセスを spawn して `switch_session` する」だけで復旧できる
   ——この「プロセスは使い捨て、状態はファイル」という割り切りこそ転用すべき点。

8. **human-in-the-loop の RPC 化** (extension_ui_request/response)
   ツール実行許可などの対話要求を id 相関 + timeout デフォルト解決のサブプロトコルにしている。
   Slack ならボタン付きメッセージにマップでき、無応答時はタイムアウトで安全側に倒せる。

9. **tool_execution_update は累積値で送る**
   Slack はメッセージ編集ベースの更新になるため、delta より「その時点の全文で置換」が圧倒的に楽。
   pi がツール出力にこの方式を採っているのは同じ理由 (クライアント側の状態管理を消す) と明記されている。

### 注意点 (そのまま真似しない方がよい箇所)

- orchestrator は実験的で、instances.json の同期書き込み・単一ソケット・認可なしなどマルチテナント耐性はない。
- `Agent.subscribe` の listener が await される設計は、遅い購読者 (例: Slack API 呼び出し) がループを
  ブロックする。外部 I/O を挟むならキューを 1 枚挟むべき。
- steering の重複排除がメッセージ本文の文字列一致に依存している箇所がある (_steeringMessages の indexOf,
  agent-session.ts:496-507)。同文面の連投がある Slack では識別子ベースにした方が安全。

---

## 参照ファイル一覧 (主要)

- packages/ai/src/types.ts — Message/Usage/AssistantMessageEvent/Model
- packages/agent/src/types.ts — AgentMessage/AgentState/AgentEvent/AgentLoopConfig
- packages/agent/src/agent.ts — Agent クラス (steer/followUp/subscribe)
- packages/agent/src/agent-loop.ts — runLoop (steering/followUp 注入点)
- packages/coding-agent/src/core/session-manager.ts — JSONL ツリー永続化・buildSessionContext
- packages/coding-agent/src/core/agent-session.ts — AgentSession (永続化フック・compaction・キュー)
- packages/coding-agent/src/core/agent-session-runtime.ts — セッション切替ホスト
- packages/coding-agent/src/modes/rpc/rpc-mode.ts — RPC コマンドディスパッチ
- packages/coding-agent/src/rpc-entry.ts — ヘッドレスエントリ
- packages/coding-agent/src/main.ts:300-350 — resume/continue/session 解決
- packages/orchestrator/src/{serve,supervisor,rpc-process,handler,storage,radius,cli}.ts, ipc/{protocol,server,client}.ts
- docs: packages/coding-agent/docs/{session-format,rpc,compaction,sessions,sdk}.md
