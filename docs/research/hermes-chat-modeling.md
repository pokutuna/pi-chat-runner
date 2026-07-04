# hermes-agent におけるチャット (会話) モデリングの as-is 調査

対象リポジトリ: `NousResearch/hermes-agent` (Python 製エージェント + マルチプラットフォームチャットゲートウェイ)
調査日: 2026-07-03 / 対象コミット: `a9b5598909` (main)

参照は `file:line` 形式。行番号は上記コミット時点のもの。「推測」と明記した箇所以外は実際にコードを読んで確認した事実である。

---

## 全体像

```
[Telegram/Discord/Slack/Signal/WhatsApp/...]        (各プラットフォーム API)
        │ 受信 (SSE / WebSocket / Socket Mode / webhook)
        ▼
┌───────────────────────────────┐
│ PlatformAdapter (BasePlatformAdapter のサブクラス)     │
│  - 生イベントをフィルタ (self-echo, allowlist, mention) │
│  - 添付を bytes で取得 → ローカルキャッシュ (CachedMedia)│
│  - build_source() で SessionSource を構築               │
│  - MessageEvent に正規化                                │
└──────────────┬────────────────┘
               │ handle_message(event)  … base.py:4585
               ▼
┌───────────────────────────────┐
│ BasePlatformAdapter.handle_message                     │
│  - build_session_key() でセッション決定 (session.py:822)│
│  - アクティブセッション中なら: コマンドバイパス /       │
│    photo バーストのマージ / テキストのデバウンス束ね    │
│  - 空きなら background task を起動                      │
└──────────────┬────────────────┘
               │ _message_handler(event)
               ▼
┌───────────────────────────────┐
│ gateway/run.py (GatewayRunner)                          │
│  - 認可チェック → セッション履歴ロード                  │
│  - _prepare_message_text(): 送信者プレフィクス・        │
│    リプライ文脈・添付ノート等をテキスト化 (run.py:9960~)│
│  - AIAgent 実行 (worker thread)                          │
└──────┬────────────────────────┘
       │ 型付き StreamEvent (stream_events.py)
       ▼
GatewayEventDispatcher (stream_dispatch.py:40)
       │  MessageChunk/Stop/Commentary → sink / ToolCallChunk → progress 行
       ▼
GatewayStreamConsumer (stream_consumer.py:83)
       │  send → editMessageText の逐次編集 (or Telegram native draft)
       ▼
PlatformAdapter.send / edit_message / send_image ... → 各プラットフォーム
```

補助系: `DeliveryRouter` (cron 出力等の宛先解決)、`channel_directory` (チャット一覧キャッシュ)、`mirror` (別セッションへの送信履歴ミラー)、`rich_sent_store` (送信済みテキストの reply-to 逆引き)。

---

## 1. メッセージのモデリング

### 1.1 受信メッセージ: `MessageEvent` (gateway/platforms/base.py:1715-1780)

全アダプタが生成する正規化表現。dataclass。

```python
@dataclass
class MessageEvent:
    text: str
    message_type: MessageType = MessageType.TEXT   # TEXT/PHOTO/VIDEO/AUDIO/VOICE/DOCUMENT/STICKER/COMMAND/LOCATION
    source: SessionSource = None                   # どこから来たか (下記)
    raw_message: Any = None                        # プラットフォーム生データ (エスケープハッチ)
    message_id: Optional[str] = None
    platform_update_id: Optional[int] = None       # Telegram update_id 等 (restart 重複防止用)
    media_urls: List[str] = ...                    # ローカルキャッシュ済みファイルパス
    media_types: List[str] = ...                   # 対応する MIME
    # リプライ (引用) 文脈
    reply_to_message_id: Optional[str] = None
    reply_to_text: Optional[str] = None            # 引用元本文 (プロンプト注入用)
    reply_to_author_id: Optional[str] = None
    reply_to_author_name: Optional[str] = None
    reply_to_is_own_message: bool = False          # bot 自身の発言への返信か
    auto_skill: Optional[str | list[str]] = None   # チャンネル紐付けスキル
    channel_prompt: Optional[str] = None           # チャンネル別 ephemeral システムプロンプト
    channel_context: Optional[str] = None          # 履歴バックフィル (未処理の周辺発言)
    internal: bool = False                         # 合成イベント (認可バイパス)
    metadata: Dict[str, Any] = ...                 # 自由形式のプラットフォーム固有シグナル
    timestamp: datetime = ...
```

ポイント:
- **`media_urls` は URL ではなくローカルパス**。アダプタが受信時に bytes をダウンロードし `cache_media_bytes()` (base.py:1628-1691) でキャッシュ、エージェントのサンドボックスから見えるパスに変換して格納する。分類結果は `CachedMedia` (base.py:1594-1605) で、`context_note()` が `[image 'foo.png' saved at: /path]` という一行注記を返す。
- リプライは「ID + 引用テキスト + 著者 + 自分の発言か」の 5 フィールドに平坦化。スレッド構造は `MessageEvent` ではなく `SessionSource.thread_id` が持つ。
- `is_command()` / `get_command()` (base.py:1782-1798) で `/new` 等のスラッシュコマンドを判定。iOS の em-dash 自動変換を `--` に戻す補正まで入っている (base.py:1807)。

### 1.2 送信元: `SessionSource` (gateway/session.py:121-170)

「メッセージがどこから来たか」= 返信ルーティング・プロンプト注入・cron 配送先の 3 用途を兼ねる。

```python
@dataclass
class SessionSource:
    platform: Platform            # enum (telegram/discord/slack/signal/...)
    chat_id: str
    chat_name: Optional[str] = None
    chat_type: str = "dm"         # "dm" | "group" | "channel" | "thread"
    user_id: Optional[str] = None
    user_name: Optional[str] = None
    thread_id: Optional[str] = None    # Slack thread_ts / Discord thread / TG forum topic
    chat_topic: Optional[str] = None
    user_id_alt: Optional[str] = None  # 安定 alt ID (Signal UUID, Feishu union_id)
    chat_id_alt: Optional[str] = None  # Signal group 内部 ID
    is_bot: bool = False
    scope_id: Optional[str] = None     # Discord guild / Slack workspace (プラットフォーム中立)
    guild_id: Optional[str] = None     # @deprecated: scope_id の旧名 (dual-read/write 移行中)
    parent_chat_id: Optional[str] = None  # chat_id がスレッドを指すときの親チャンネル
    message_id: Optional[str] = None      # トリガーメッセージ ID (pin/reply/react 用)
    role_authorized: bool = False
    profile: Optional[str] = None         # マルチプロファイル多重化
    delivered_via_upstream_relay: bool = False  # wire 非公開の信頼フラグ (後述)
```

識別子設計の要点:
- **スレッドは `thread_id` 一本に正規化**。Slack の `thread_ts` (plugins/platforms/slack/adapter.py:3161)、Telegram forum topic、Discord スレッドすべて同じスロットに入る。
- **`scope_id` はサーバー/ワークスペースの汎用判別子**。`guild_id` から改名中で、`__post_init__` (session.py:172-180) と `to_dict`/`from_dict` (session.py:218-249) が両フィールドを相互ミラーする dual-read/dual-write 移行パターン。
- **`user_id_alt`**: 電話番号 ↔ UUID のようにプラットフォームが同一人物へ複数 ID を振る場合の安定 ID。セッションキー生成時に `user_id_alt or user_id` と優先される (session.py:887)。
- **`delivered_via_upstream_relay` は `to_dict`/`from_dict` に意図的に含めない** (session.py:159-170)。リレー経由の認可済みフラグをワイヤ越しに偽造・永続化から復元できないようにするため。

### 1.3 グローバルアドレッシング

2 種類の文字列形式が使われる:

1. **配送ターゲット**: `"<platform>:<chat_id>[:<thread_id>]"` (例 `telegram:123456:99`)。`DeliveryTarget.parse()` (gateway/delivery.py:159-207) が `origin` / `local` / `telegram` (ホームチャンネル) / 明示 ID を解釈する。
2. **セッションキー**: `build_session_key()` (gateway/session.py:822-910) が単一の正規実装 ("single source of truth" と明記)。形式は
   `agent:<profile>:<platform>:<chat_type>:<chat_id>[:<thread_id>][:<participant_id>]`
   - DM: `agent:main:telegram:dm:<chat_id>`
   - グループ: デフォルトで `group_sessions_per_user=True` → 参加者ごとに独立セッション (キー末尾に user_id)
   - スレッド: デフォルトで共有 (`thread_sessions_per_user=False` のとき user_id を付けない、session.py:900-905)。Slack/Discord/TG forum のスレッドは「参加者全員が同じ会話を見る」UX に合わせている。
   - WhatsApp は JID/LID の揺れを `canonical_whatsapp_identifier()` で正規化してからキー化 (session.py:860, 887-892)。

### 1.4 リアクション・メンション・スタンプの扱い

- **受信リアクションは `MessageEvent` にフィールドがない**。少なくとも共通モデルでは扱わない (読んだ範囲での事実。個別アダプタが `metadata`/`raw_message` 経由で扱う可能性は否定できない=推測)。
- **送信側リアクションは処理ライフサイクルの ACK として使う**: `on_processing_start` / `on_processing_complete` フック (base.py:4015-4018) を Signal がオーバーライドし、処理開始で 👀、成功で ✅、失敗で ❌ を付ける (gateway/platforms/signal.py:1645-1672)。リアクション対象の特定には `raw_message` に残した `sender` + `timestamp_ms` を使う (signal.py:1612-1625) — 正規化モデルに入らない情報の受け渡しに `raw_message` を使う実例。
- **メンションはテキストにレンダリングして畳み込む**: Signal はメンション placeholder (￼) を `@番号` に展開し (`_render_mentions`, signal.py:196)、bot 自身へのメンションは LLM が「その番号に連絡しろ」と誤読しないよう除去する (signal.py:633-652)。
- **ステッカー**は `MessageType.STICKER` があり (base.py:1703)、`gateway/sticker_cache.py` も存在する (中身は未読)。

### 1.5 送信結果: `SendResult` (base.py:1854-1885)

```python
@dataclass
class SendResult:
    success: bool
    message_id: Optional[str] = None
    error: Optional[str] = None            # 人間可読
    error_kind: Optional[str] = None       # 機械可読カテゴリ (下記)
    retryable: bool = False                # base 層が自動リトライ
    retry_after: Optional[float] = None    # FloodWait 等サーバ指定の待ち時間
    continuation_message_ids: tuple = ()   # 長文分割時の追加メッセージ ID 群
```

`error_kind` は `too_long / bad_format / forbidden / not_found / rate_limited / transient / unknown` の閉じた語彙 (base.py:1905-1915)。`classify_send_error()` (base.py:1954-2002) が各プラットフォームのエラー文字列をこの語彙に写像し、さらに `is_chat_level_not_found()` (base.py:2005-2022) が「チャットごと消えた」と「スレッド/トピックだけ消えた」を区別する。後者を混同すると生きているチャットを dead 扱いしてしまうため (gateway/dead_targets 連携)。

---

## 2. プラットフォームアダプタ

### 2.1 基底クラス `BasePlatformAdapter` (base.py:2253)

5,600 行あり、**共通ロジックの大半 (デバウンス・リトライ・分割・セッションガード) が基底に集約**されている。

必須 (abstract / チェックリスト上の必須):

| メソッド | 役割 |
|---|---|
| `__init__(config)` | `super().__init__(config, Platform.X)` |
| `connect(is_reconnect=False) -> bool` | 接続・リスナー開始 (base.py:2864) |
| `disconnect()` | 停止 (base.py:2884) |
| `send(chat_id, text, ...) -> SendResult` | テキスト送信 (base.py:2889) |
| `send_typing(chat_id)` | typing indicator (base.py:3165) |
| `send_image(chat_id, url, caption)` | 画像 (base.py:3239) |
| `get_chat_info(chat_id) -> dict` | abstract (base.py:5471) |

任意 (基底にデフォルト実装/スタブあり): `send_document/voice/video/animation/image_file`、`edit_message` (base.py:2945)、`delete_message` (2974)、`create_handoff_thread` (2918)、対話 UI 系 `send_clarify` / `send_exec_approval` / `send_slash_confirm` (3053-3145、ボタンコールバック ID 規約 `cl:<id>:<idx>` 等はアダプタ間で共有)。

能力宣言 (capability surface):
- `MAX_MESSAGE_LENGTH` 属性、`message_len_fn` (base.py:2403、Telegram は UTF-16 code unit 数 `utf16_len` base.py:133-145)
- `supports_draft_streaming()` (2471)、`prefers_fresh_final_streaming()` (2490)、`SUPPORTS_MESSAGE_EDITING`
- `format_message(content)` (5482): Markdown → 各プラットフォーム方言への変換フック
- `enforces_own_access_policy` / `authorization_is_upstream` (2412, 2440): 認可を誰が持つか

受信側の契約: アダプタは `build_source()` (base.py:5432) で `SessionSource` を作り、`handle_message(event)` (base.py:4585) を呼ぶだけ。ゲートウェイ本体は `set_message_handler()` (2768) でコールバックを注入する。

### 2.2 ADDING_A_PLATFORM.md の要約 (gateway/platforms/ADDING_A_PLATFORM.md)

- **プラグイン路線 (推奨)**: `~/.hermes/plugins/` か `plugins/platforms/` に `plugin.yaml` + `adapter.py` を置き、`register(ctx)` で `ctx.register_platform()`。コア変更ゼロ。env 起動 (`env_enablement_fn`)、YAML→env 変換 (`apply_yaml_config_fn`)、cron 配送 (`cron_deliver_env_var` + `standalone_sender_fn`) 等のフックが用意されている。
- **サブクラス化の指針**: LINE の 60 秒 reply token や WhatsApp の 24h window のような時間制約は `_keep_typing` のオーバーライドで対応 (必ず `super()` を呼ぶ)。
- **兄弟アダプタパターン**: 同一プラットフォームに 2 つの transport がある場合 (WhatsApp の Baileys ブリッジ版と Meta Cloud API 版)、振る舞いを mixin (`WhatsAppBehaviorMixin`, gateway/platforms/whatsapp_common.py) に切り出し、`class Adapter(Mixin, BasePlatformAdapter)` の MRO 順で `format_message` を上書きする。
- **ビルトイン路線のチェックリスト (16 項目)**: アダプタ本体 / Platform enum / adapter factory / 認可マップ / SessionSource 拡張 / システムプロンプトヒント (`agent/prompt_builder.py` の `PLATFORM_HINTS` — これがないとエージェントが不適切なフォーマットを使う) / toolset / cron / send_message ツール / channel directory / status 表示 / setup wizard / PII redaction / ドキュメント / テスト。**「1 プラットフォーム追加」が触るべき統合点を全部列挙している**のがこのファイルの価値。

### 2.3 具体例: Signal の受信→正規化→ディスパッチ (gateway/platforms/signal.py)

1. `_sse_listener()` (signal.py:420) が signal-cli の SSE を購読、`_health_monitor` (489) が再接続。
2. `_handle_envelope()` (530-763) が 1 envelope を処理:
   - syncMessage の選別: 自分の送信エコーは `_consume_sent_timestamp` で捨て、"Note to Self" だけ dataMessage に昇格 (538-555)
   - 自己メッセージ・story のフィルタ (571-577)
   - グループ allowlist (`SIGNAL_GROUP_ALLOWED_USERS`、`*` 対応) と require_mention ゲート (598-631)
   - メンション展開 + 自己メンション除去 (610-652)
   - quote → `reply_to_*` 5 フィールド抽出、`_quote_references_own_message` で自分の発言への返信か判定 (654-663)
   - 添付をサイズ上限チェック付きで RPC 取得しキャッシュ (`_fetch_attachment`, 666-687)
   - 中身のない envelope (profile key update 等) を捨てる (689-699)
   - `build_source(chat_id=sender or "group:<id>", user_id_alt=UUID, chat_id_alt=group_id)` (702-710)
   - media MIME から `MessageType` を決定 (712-726)、epoch ms → datetime (728-736)
   - `MessageEvent(...)` を構築し `raw_message` にリアクション用の生情報を残す (741-758)
3. `await self.handle_message(event)` (763) で共通パイプラインへ。

### 2.4 Slack / Discord / Telegram の実体

**`gateway/relay/` ではなく Python プラグインとして実装されている**:
- Slack: `plugins/platforms/slack/adapter.py` (4,564 行)。slack-bolt **Socket Mode**。受信時 `thread_ts` → `source.thread_id` (adapter.py:3161)、スレッド返信なら親メッセージ本文を `conversations.replies` で取り `reply_to_text` に注入 (3186-3203)、`reply_to_message_id = thread_ts if thread_ts != ts else None` (3213)。テキスト系添付 (≤100KB) は本文へ直接インライン展開 (3107-3120)。送信時は `_resolve_thread_ts()` (1630-1666) が metadata の thread_id を reply_to より優先。
- Discord: `plugins/platforms/discord/adapter.py` (7,804 行)。discord.py。voice 対応 (`voice_mixer.py`)、ロールベース DM 認可、channel_skill_bindings (plugin.yaml 記載)。
- Telegram: `plugins/platforms/telegram/adapter.py` (8,324 行)。PTB。MarkdownV2 エスケープ (adapter.py:168-)、Bot API 10.1 Rich Message、DM topic 等。
- WhatsApp (非 Cloud 版) だけが **Node.js ブリッジ (Baileys / WhatsApp Web)** への委譲 (plugins/platforms/whatsapp/plugin.yaml:7)。

**`gateway/relay/` は別物**: ホスト型「Team Gateway コネクタ」用の実験的リレー。
- `RelayAdapter` (relay/adapter.py:46): `Platform.RELAY` として登録される**汎用アダプタ 1 つ**。プラットフォーム別分岐を持たず、handshake で受け取る `CapabilityDescriptor` (relay/descriptor.py:41-118: `max_message_length` / `len_unit` (chars|utf16) / `supports_draft_streaming` / `supports_edit` / `supports_threads` / `markdown_dialect` / `pii_safe` / `contract_version`) を能力面として広告する。
- `RelayTransport` プロトコル (relay/transport.py:42): connect/handshake/inbound handler/`send_outbound`/`get_chat_info`/`send_interrupt`/`go_idle`。実装は `WebSocketRelayTransport` (ws_transport.py:195)。**ゲートウェイ側からコネクタへ外向きに dial する** (公開ポート不要)。
- 受信は `_event_from_wire()` (ws_transport.py:94-144) が snake_case ワイヤ形式から `SessionSource`/`MessageEvent` を再構築し、`delivered_via_upstream_relay=True` をローカルで刻印 (ワイヤからは読まない)。`source.platform` には下位プラットフォーム (discord 等) が入る。
- コネクタ側は TypeScript (`relay/protocol.ts`, `routedEgressGuard.ts` への言及あり) で別リポジトリ (推測: コード自体はこのリポジトリに存在しない)。

### 2.5 `platform_registry.py` と `channel_directory.py`

- `PlatformRegistry` (platform_registry.py:162): if/elif のアダプタ工場を置き換える自己登録レジストリ。`PlatformEntry` (38-159) がアダプタ factory に加えて**認可 env 名・max_message_length・PII 安全性・絵文字・システムプロンプトヒント・cron 配送 env・プロセス外送信関数**まで 1 エントリに束ねる。重い SDK import を避けるため **deferred loader** (169-200) で初回ルックアップ時にのみ実 import。
- `channel_directory` (channel_directory.py:1-7): 起動時+5 分毎に到達可能なチャンネル/連絡先を集めて `~/.hermes/channel_directory.json` に保存。`send_message` ツールの `action="list"` と**フレンドリ名→ID 解決** (`resolve_channel_name`, :333) に使う。列挙 API がないプラットフォームはセッション履歴から逆引き (`_build_from_sessions`, :265)。手編集が消えないよう `channel_aliases.json` を毎回オーバーレイ (:20-40)。

---

## 3. 複数メッセージの束ね方

エージェント実行中 (`_active_sessions` にキーが居る間) に届いたメッセージの扱いが `handle_message` (base.py:4585-4779) に集約されている。**割り込みではなく「現在のターン終了後にカスケード実行」が基本方針**。

1. **コマンドのバイパス** (4630-4675): `/stop` `/new` `/approve` 等はキューに入れず即ディスパッチ (キューに入れると deadlock または会話へのリークになる)。
2. **clarify 返信のバイパス** (4677-4731): エージェントが `clarify` ツールで `Event.wait` ブロック中なら、次の非コマンド発言は新ターンではなく resolver へ直行。
3. **photo バースト** (4743-4746): アルバムは複数イベントで届くため、`merge_pending_message_event()` (base.py:2064-2123) で pending スロットの既存イベントに `media_urls` を追記マージ。
4. **テキストのデバウンス** (`busy_text_mode == "queue"` のとき): `_queue_text_debounce()` (4234-4284) が `TextDebounceState` (1811-1816) にバッファし、**「最後の発言から `_busy_text_debounce_seconds`」と「最初の発言から `_busy_text_hard_cap_seconds`」の早い方**でフラッシュ (`_text_debounce_delay`, 4224-4232)。テキストは `\n` 連結、`message_id` は最新のものに更新 (リプライアンカー用)。**送信者が変わったら混ぜない**: `_can_merge_text_debounce_events()` (4205-4222) が (platform, user_id) 単位で同一性を確認し、共有セッションでの発言者混線を防ぐ。
5. フラッシュ先は `_pending_messages[session_key]` (1 スロット)。現行タスク終了後に `_process_message_background` が pending を拾って次ターンを開始する (「cascade」、4757-4770 のログ文言)。

デバウンスと別に、`merge_pending_message_event(merge_text=True)` で pending スロット内でもテキスト追記が起きる (Telegram の連投対応、base.py:2114-2121)。

`message_timestamps.py` は束ねとは独立で、**「タイムスタンプは LLM 文脈にだけ 1 回描画し、永続化する本文はクリーンに保つ」**ためのモジュール (message_timestamps.py:1-6)。`render_user_content_with_timestamp()` (:114-129) が既存プレフィクスを剥がしてから `[Tue 2026-04-28 13:40:53 CEST]` を 1 個だけ付ける。デフォルト OFF、`gateway.message_timestamps.enabled` でオプトイン (run.py:770-787)。

---

## 4. エージェントへの入力テキスト化

会話は「role/content の履歴 + 今回の user テキスト」としてエージェントに渡る。プラットフォーム構造 (リプライ・添付・送信者) は**すべて角括弧注記としてテキストに畳み込まれる**。中心は `run.py` の `_prepare_message_text` (run.py:9960 付近から始まる巨大メソッド)。

実際のテンプレート (適用順):

1. **送信者プレフィクス** — 共有マルチユーザセッション (グループ/スレッド) のときだけ:
   `[{user_name}] {message}` (run.py:9993-9994)。DM では付けない。判定は `is_shared_multi_user_session()` (session.py:781-799)。
2. **チャンネル文脈バックフィル** — require_mention で拾わなかった間のグループ発言:
   `{channel_context}\n\n[New message]\n{message}` (run.py:9999-10000)
3. **添付ノート** — 画像はモデルが vision 対応ならネイティブ添付 (パスをセッション別バッファに退避、run.py:10035-10045)、非対応なら `vision_analyze` の説明文を注入。音声 VOICE は STT してテキスト化 + 生成した transcript を `🎙️ "..."` として即エコー (10056-10078)。音声ファイル/動画/文書はパスを指す注記:
   `[The user sent an audio file attachment: '{name}'. It is saved at: {path}. ... transcribe or process it yourself ...]` (run.py:10097-10106)
4. **Discord のみ**: `[Triggering message id: \`{id}\` — use as \`message_id\` for reply/react/pin via the discord tools.]` をユーザターン側に付ける (run.py:10186-10191)。システムプロンプトに入れるとターン毎に変わる ID がプロンプトキャッシュを壊すため、あえて user content に載せる設計。
5. **リプライ文脈** (run.py:10193-10207):
   - bot の発言への返信: `[Replying to your previous message: "{500字までの引用}"]\n\n{message}`
   - 他者への返信: `[Replying to: "{...}"]\n\n{message}`
   - 引用が履歴に既在でも常に注入する。「重複排除ではなく曖昧性解消 (どの発言への返信かを指す)」とコメントに明記。
6. `@path` 参照はファイル内容展開 (`preprocess_context_references_async`, run.py:10209 以降)。

履歴の replay 側は `_build_gateway_agent_history()` (run.py:790-878):
- `system` と `session_meta` 行はスキップ (エージェントがシステムプロンプトを再構築するため)
- タイムスタンプ opt-in 時は user 行にのみ `[...]` を付与 (834-835)
- ミラー行は `[Delivered from {mirror_source}] {content}` に変形 (860-862)
- 中断された tool_call の尻尾を除去 (`_strip_interrupted_tool_tails` / `_strip_dangling_tool_call_tail`, 866-875) — SIGKILL 直後の未応答 tool_call が resume 時の無限再実行ループを起こすため

`gateway/session_context.py` はプロンプト生成ではなく、**ツール実行時のセッション同定** (`HERMES_SESSION_PLATFORM/CHAT_ID/...`) を `os.environ` から `contextvars.ContextVar` に移したもの (session_context.py:8-23)。並行メッセージ処理で env が last-writer-wins になり別スレッドへ返信が飛ぶバグの対策で、タスク毎コピーになる。継承リーク対策の `reset_session_vars()` (245-290) まである。システムプロンプトへの注入用データは `SessionContext` dataclass (session.py:257-290: source + connected_platforms + home_channels + shared_multi_user_session)。

---

## 5. エージェント出力の受け取りと送信

### 5.1 型付きイベント語彙 (gateway/stream_events.py)

エージェント→ゲートウェイの配送契約を 7 個の frozen dataclass に固定 (stream_events.py:43-159): `MessageChunk` (テキスト差分) / `MessageStop(final)` (セグメント終端。tool 境界の中間 stop は `final=False`) / `Commentary` (tool 呼び出し前の「まずリポジトリを見ます」等の完結した interim 発言) / `ToolCallChunk(tool_name, preview, args, index)` / `ToolCallFinished(duration, ok)` / `LongToolHint` / `GatewayNotice(kind, text)`。

設計原則がモジュール docstring に明記されている (stream_events.py:23-33):
- **イベントは transport であって context ではない**。ここを流れたものは履歴に永続化されない。プラットフォームが表示上「食べた」ものと履歴のバイト列が乖離しないため。
- 「smart agent が構造化データを出し、smart gateway が配送を決める」。tool 表示の絵文字/省略などプレゼン判断はアダプタ側 (`format_tool_event`, base.py:2593) に移した。

### 5.2 ディスパッチと消費

- `GatewayEventDispatcher` (stream_dispatch.py:40-129): 同期・asyncio なしの薄いルータ。Message 系 → `adapter.render_message_event(event, sink)` (base.py:2572-2591 のデフォルトは sink の `on_delta`/`on_segment_break`/`on_commentary` へ写像)。ToolCallChunk → `adapter.format_tool_event()` の戻り (None なら握りつぶし=そのプラットフォームでは tool chrome を出さない) を progress キューへ。tool_mode は "all/new/verbose/off"、"new" は同一ツール連続を dedup (:105-107)。dispatch は例外を握りつぶす (「プレゼンはエージェントループを壊してはならない」:92-93)。
- `GatewayStreamConsumer` (stream_consumer.py:83-): **「最初に 1 通送り、以後 editMessageText で逐次上書き」**が基本 transport (docstring :10-12、Telegram/Discord/Slack で普遍的に使えるため)。
  - スレッド境界: エージェント worker thread から `on_delta()` (thread-safe な `queue.Queue`) → asyncio タスク `run()` が消費。
  - レート制御: `edit_interval` 秒間隔 + `buffer_threshold` 文字のバッファリング (StreamConsumerConfig, :54-80)。flood エラーが 3 連続 (`_MAX_FLOOD_STRIKES`, :98-100) で以後の編集を放棄、`_current_edit_interval` で適応バックオフ (:177)。
  - セグメント: tool 境界で `_NEW_SEGMENT` を挟み、以後のテキストは tool progress の下に**新しいメッセージ**として出す (:46-47, 315-317)。
  - Telegram native draft: `transport="auto"/"draft"` かつ DM のとき `send_draft` (base.py:2530) でタイピング風アニメーション。失敗 1 回で edit 方式へ永久フォールバック (:204-214)。
  - fresh-final: プレビューが `fresh_final_after_seconds` 以上表示されていたら、最終回答を編集でなく**新規メッセージで送り直し、プレビュー群を削除** (:61-68, 156-162)。Telegram のみ有効化 (run.py:15887-15895)。
  - think ブロック除去: `<think>` 等をストリーム中にステートマシンで抑制 (:377-484)。行頭境界チェックで「タグに言及しただけの散文」の誤検出を防ぐ。
  - 構築場所は run.py:15896-15913 (プロキシ経路) / 17188-17197。`metadata` にスレッドルーティング情報、`initial_reply_to_id` にトリガー message_id。
- **二重送信防止**: consumer が最終応答まで配送済みなら `agent_result["already_sent"]=True` となり (run.py:19099-19130)、通常送信パスはテキスト再送をスキップ (run.py:11596 ほか)。

### 5.3 応答フィルタ (gateway/response_filters.py)

- エージェントが「返信しない」ことを選べる制御トークン: `NO_REPLY` / `[SILENT]` / `SILENT` / `NO REPLY` (完全一致・64 字以内のみ、:13-44)。成功ターンのみ有効 (:47-53)。
- ストリーミング対応版 `is_partial_silence_marker()` (:56-80): 蓄積バッファが silence マーカーの**接頭辞である間は画面に出さない**。`NO_REPLY` の途中の "NO" を一瞬表示して消す事故を防ぐ。cron 側にも narration 版がある (`_is_silence_narration`, delivery.py:36-55: `*(silent)*` や 🔇 だけの応答を配送しない)。

### 5.4 補助ストア

- `rich_sent_store.py`: Telegram Bot API 10.1 の rich message は**ユーザが返信しても `reply_to_message` に本文がエコーされない** (検証済みと docstring に記載、:3-6)。そこで送信時に `(chat_id, message_id) → text` を `~/.hermes/state/rich_sent_index.json` に最大 1000 件記録し (:39-68)、受信時に `reply_to_id` から引用本文を復元する。全操作 best-effort (失敗は no-op)。
- `mirror.py`: `send_message` ツールや cron が別チャットへ送ったとき、**宛先セッションのトランスクリプトに mirror 行を追記**して受け手側エージェントに文脈を与える (:25-53)。role の選択に罠があり、エージェント自身の発言は `assistant`、cron 等の第三者配送は `user` にしないと SQLite 境界で mirror メタデータが落ちて assistant→assistant 連続になり strict-alternation なプロバイダが壊れる (docstring :42-49)。replay 時は `[Delivered from {source}]` プレフィクスになる (run.py:860-862)。

### 5.5 分割・レート制限・フォーマット変換

- **分割**: `BasePlatformAdapter.truncate_message()` (base.py:5493-5622)。コードフェンス境界を保存し (チャンク末尾で ``` を閉じ、次チャンク先頭で言語タグ付きで再開)、インラインコードのバッククォート対を壊さない位置を探し、複数チャンクには ` (1/3)` を付ける。長さ関数は `len_fn` 注入式で Telegram は `utf16_len` (絵文字がサロゲートペアで 2 単位、base.py:133-145)。
- **レート制限**: 送信は `_send_with_retry()` (base.py:4073) が `SendResult.retryable` / `retry_after` を見て再送。retry 可能なエラーパターンは接続系のみで、read timeout は**二重配送リスクがあるため意図的に除外** (base.py:2126-2143)。Signal には専用の `signal_rate_limit.py` もある (未読)。
- **フォーマット変換**: 共通中間表現は「エージェントが出す Markdown」で、各アダプタの `format_message()` が方言へ変換する。Telegram: MarkdownV2 エスケープ (plugins/platforms/telegram/adapter.py:168-)。Signal: `_markdown_to_signal` で style ranges に変換 (signal.py:1007)。Slack: mrkdwn / Block Kit (plugins/platforms/slack/block_kit.py)。relay 経由では `markdown_dialect` を descriptor で広告 (descriptor.py:56)。
- **配送ルータ**: cron/ツール出力は `DeliveryRouter.deliver()` (delivery.py:246-) が処理。dead target (削除されたグループ、bot ブロック) は `DeadTargetRegistry` でスキップし、後続の成功送信で自動解除 (:269-298)。チャンク送信できないプラットフォームは `MAX_PLATFORM_OUTPUT=4000` で切り詰め (:23-29)。

---

## 6. 設計の学び / 転用できそうなポイント

Slack/Discord ボットを新規設計する際の観点。

### 真似すべき点

- **正規化イベント + `raw_message` エスケープハッチの二層構造** (base.py:1716-1780)。共通フィールドは薄く保ち、リアクション ACK のような固有機能は `raw_message`/`metadata` 経由でアダプタ内に閉じる (signal.py:1612)。共通モデルの肥大化を防げる。
- **リプライは「ID + 引用テキスト + 著者 + 自分宛か」に平坦化し、プロンプトには `[Replying to: "..."]` として常に注入** (run.py:10193-10207)。履歴に同文があっても入れる理由 =「重複排除でなく曖昧性解消」という整理はそのまま使える。
- **スレッド ID の単一スロット化** (`SessionSource.thread_id`)。Slack thread_ts / Discord thread / TG topic を 1 概念に潰し、セッションキー生成 (session.py:822) を single source of truth の関数 1 個にする。「スレッドは共有・グループは per-user・DM は per-chat」というデフォルトの分離規則も UX として妥当。
- **添付は受信時に bytes をローカルキャッシュし、プロンプトには「パス + どう扱うべきかの指示」の注記だけ入れる** (base.py:1628, run.py:10097-10125)。エージェントがツールで自力処理でき、トークンも節約できる。
- **アクティブセッション中の後続メッセージは「割り込まずデバウンスして次ターンにカスケード」**。デバウンス窓 + ハードキャップの二重締切 (base.py:4224-4232)、送信者が変わったらマージしない (4205)、photo アルバムのメディア追記マージ (2064) は連投 UX の完成形に近い。
- **`/stop` `/approve` とツール待ち応答のキュー・バイパス** (base.py:4630-4731)。「エージェントが Event.wait でブロック中に来た返答は resolver へ直行させないと deadlock」という failure mode は自作すると必ず踏む。
- **ストリーミングを型付きイベントに分離し「transport であって context ではない」を不変条件にする** (stream_events.py:23-33)。表示で間引いた tool chrome と永続履歴が乖離しない。プレゼン判断 (絵文字・省略・出さない) はアダプタに置く。
- **send→edit ストリーミングの実戦的ディテール**: flood 3 ストライクで編集放棄、tool 境界で新規メッセージにセグメント分割、silence マーカーの接頭辞ホールドバック (response_filters.py:56)、長時間ストリーム後の fresh-final 再送。エージェントに `NO_REPLY` という「沈黙する権利」を与えるのも群れチャットでは重要。
- **送信エラーの機械可読分類** (`error_kind` 閉集合 + `classify_send_error`, base.py:1905-2002) と dead target 登録/自動解除 (delivery.py:269)。特に「chat-level not_found と thread-level not_found の区別」(base.py:2005) は見落としがちな要件。
- **長文分割のコードフェンス保存アルゴリズム** (base.py:5493) と **UTF-16 長さ関数の注入** (Telegram の 4096 制限は UTF-16 code unit)。長さの「単位」をプラットフォーム能力として抽象化する発想 (descriptor の `len_unit`) ごと持ち帰れる。
- **並行セッションの識別情報は env でなく ContextVar** (session_context.py:8-23)。process-global な os.environ にセッション ID を書くと並行処理で必ず混線する。
- **capability descriptor による汎用アダプタ** (relay/descriptor.py)。プラットフォーム差を「能力の値」(max_length, supports_edit, markdown_dialect...) に還元できれば、ゲートウェイ側の per-platform 分岐は消せる — ただし本体側はまだ per-platform アダプタが主で、これは実験段階 (EXPERIMENTAL 明記) という事実も含めて参考にすべき。
- **ミラー行の role 選択の教訓** (mirror.py:42-49): 代理配送を assistant role で書くと strict-alternation プロバイダで壊れる。

### 避けるべき点 / 注意点

- **`gateway/run.py` が 20,000 行**。プロンプト組み立て・認可・ストリーミング配線・スラッシュコマンドが単一ファイルに同居しており、行番号参照が壊れやすく変更コストが高い。イベント語彙や consumer は綺麗に切り出されているのと対照的。新規設計なら runner 相当を最初から分割すべき。
- **`BasePlatformAdapter` 5,600 行の god base class**。デバウンス・リトライ・分割・セッションガード・typing 管理が全部基底にあり、継承でしか再利用できない。mixin (whatsapp_common) や descriptor の方向へ移行中に見えるが、新規なら composition (デバウンサ・チャンカーを独立オブジェクトに) が素直。
- **識別子リネームの二重管理** (`guild_id`→`scope_id` の dual-read/dual-write, session.py:143-149)。ワイヤ形式に載せるフィールド名は最初から中立語彙 (scope) にしておくと移行儀式が不要。
- **プラットフォーム固有 quirks の本流への漏出**: base.py の `_thread_metadata_for_source` / `_reply_anchor_for_event` (base.py:55-107) に Telegram DM topic / Feishu の分岐がハードコードされている。quirk はアダプタ側 override に置く規律を最初に決めた方がよい。
- **受信リアクションのモデル不在**。Slack/Discord ボットではリアクションがトリガーや承認 UI になりがちなので、新規設計なら `MessageEvent` 相当に最初から reaction イベント型を持たせる (hermes は送信側 ACK のみ)。
- **pending メッセージが 1 セッション 1 スロット** (`_pending_messages[session_key]` にマージ)。順序付きキューではないため、種類の異なるメッセージが混ざるケースの意味論がマージ規則 (merge_pending_message_event) の複雑さとして現れている。要件次第では素直な FIFO + 世代番号の方が読みやすい。
- **ファイルベース JSON ストアの多用** (rich_sent_store, channel_directory, sessions.json)。単一プロセス前提なら十分だが、いずれも「best-effort・壊れたら握りつぶす」規約で成立している。マルチプロセス/水平スケールを見込むなら最初からストレージ境界を切る。

---

## 付記: 事実確認できていない領域

- Discord/Telegram アダプタ (各 7,800/8,300 行) は plugin.yaml とレジストリ登録・grep 結果のみ確認し、通読していない。
- `qqbot/`, `weixin.py`, `yuanbao*.py`, `bluebubbles.py`, `msgraph_webhook.py` 等の個別アダプタ、`signal_rate_limit.py`、`sticker_cache.py` は未読。
- リレーのコネクタ実装 (TypeScript) はこのリポジトリに存在せず、docstring の参照 (`relay/protocol.ts`) からの推測。
- `agent/prompt_builder.py` の `PLATFORM_HINTS` 本文は ADDING_A_PLATFORM.md の記述から把握したもので、ファイル自体は未読。
