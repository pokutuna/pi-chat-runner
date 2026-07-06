# Config 設計 — pi を動かすために何をどこに置くか

チャンネルごとに pi の振る舞いを変えるための設定 (Config) の整理。
「何を Config (ChannelDoc) に入れ、何を入れないか」の判断基準と、
pi 起動設定への実体化を定める。関連: [architecture.md](architecture.md) §2,
[components.md](components.md) Config 節, [session-model.md](session-model.md) §7。

## 0. 結論 — 置き場所は 4 つ + 秘匿

| 置き場所 | 何を置くか | 変更の手段 |
|---|---|---|
| **コード / デプロイ設定 (env)** | 全チャンネル共通の動作原理: reply 注入、lease/linger/debounce 既定値、EventSource 切替 | デプロイ |
| **コンテナイメージ** | 実行能力: pi 本体、CLI ツール (gcloud 等)、**skill**、reply extension、焼き込みリポジトリ | イメージビルド + デプロイ |
| **ChannelDoc (Firestore)** | 振る舞いのテキスト: プロンプト、起動条件、モデル (初期版はこれだけ。能力の選択は将来拡張 §2) | doc 編集 (デプロイ不要) |
| **GCS (/data)** | セッションが生む状態: transcript / workspace / artifacts。+ 大きな読み取り専用データ (docs/) | 随時 |
| Secret Manager | 秘匿値: Slack token、(将来の) 外部 API キー。他の場所からは**名前参照のみ** | 随時 |

判断基準は 2 軸:

1. **実行体を伴うか** — バイナリ・依存・プロセス起動が要る → イメージ。テキストだけ → ChannelDoc
2. **変更頻度** — 日次で調整したい → ChannelDoc。リリース単位でよい → イメージ / コード

skill はテキストだが「エージェントの能力」であり、どのバージョンで動いたかの再現性が
欲しいため**イメージに同梱を基本**とする (ChannelDoc は有効化の選択のみ)。
プロンプトは「チャンネルの運用」であり日次で調整したいため ChannelDoc に置く。
この線引きが **能力 = イメージ、振る舞い = Config、状態 = GCS** という 3 分割を保つ。

## 1. ユースケースから導く

想定するチャンネルと、それぞれで「何が変わるか」:

| チャンネル | 起動 (Gate) | 能力 (イメージ) | 振る舞い (テキスト) | モデル |
|---|---|---|---|---|
| #ask-ai — 汎用質問 | mention | 既定 | 既定 | 既定 |
| #alerts — アラート対応 | keyword + classifier (all) | runner-infra (gcloud/kubectl + 調査 skill) | 対応手順プロンプト + runbook 参照 | 既定 |
| #proj-x — 開発サポート | mention | 既定 (gh CLI + リポジトリ調査 skill) | リポジトリ知識のプロンプト | 高性能 |
| DM — お試し・個人利用 | passthrough | 既定 | 既定 | 既定 |

観察:

- チャンネル間で変わるのは **trigger / image / skill・MCP の有効化 / テキスト / model の 5 種だけ**。
  lease の挙動、reply の結線、transcript の置き場はどのユースケースでも変わらない
  → それらを Config に入れない根拠
- **ChannelDoc が無くても動く** (#ask-ai と DM は doc なしの既定動作)。
  Config は「既定からの差分」だけを持つ
- 定期実行 (日次レポート等) は Trigger の外 (スケジューラ起動) なので Config の対象外。
  必要になったら EventSource の追加として扱う ([components.md](components.md) 拡張の軸)

## 2. ChannelDoc スキーマ (初期版)

初期版は**振る舞いのテキストと trigger だけ**。能力 (skill / CLI / extension) はイメージに
焼き、チャンネルごとの選択はしない — 1 サービス 1 イメージなので選択の余地自体を作らない。

```typescript
// channels/{channelId} — 無ければ既定動作 (mention 起動)
interface ChannelDoc {
  systemPrompt?: string;   // 役割・口調・チャンネル運用ルール (app 共通プロンプトに追記)
  context?: string[];      // 短い参照テキスト (数 KB まで)。長い・多いものは skill へ
  trigger?: TriggerConfig; // Gate 合成 ([session-model.md](session-model.md) §5)。省略時は mention のみ
  model?: string;          // 省略時は app 既定 (agent.yaml の pi.model / env PI_MODEL。§6)
  tools?: string[];        // pi --tools allowlist
  excludeTools?: string[]; // pi --exclude-tools denylist
  session?: {              // セッション (文脈) の単位 ([session-model.md](session-model.md) §3)
    mode?: "thread" | "channel";  // 既定 thread。dm の既定は channel
    idleResetMinutes?: number;    // channel モードのみ。無活動で transcript を世代交代
    maxTranscriptKb?: number;     // channel モードのみ。transcript がこのサイズ超過で世代交代
  };
  reply?: {                // チャンネル直下トリガーへの返信先 ([session-model.md](session-model.md) §3)
    mode?: "thread" | "flat";     // 既定 thread。dm の既定は flat
  };
}
```

`session.mode` は sessionKey の導出ポリシー (thread = `channelId:threadTs ?? ts`、
channel = `channelId`)。`reply.mode` はチャンネル直下トリガーへの返信先で、スレッド内
トリガーは mode に関わらずそのスレッドに返す。2 軸の組み合わせと境界規則は
[session-model.md](session-model.md) §3「セッション単位と返信先の分離」を正とする。

`tools` / `excludeTools` は pi の `--tools` / `--exclude-tools` に渡る。`--tools` は
built-in だけでなく extension のツールにも適用されるため、reply extension も対象になる。
bridge の返信経路は reply 一択なので、`--tools` 指定時は reply を常に補い、
`excludeTools` に reply を書いても無視する。両方未指定なら現状どおり全ツール有効。

DM は channelId 個別の doc ではなく、予約名 `dm` の doc (`channels/dm.yaml`) を
全 DM 共通で参照する。doc が無ければ既定 trigger は passthrough (§1 の表の通り)。
チャンネルの既定 (mention) と異なるのは、DM が 1:1 の明示的な話しかけであり
メンションが自然な操作にならないため。`channel: "default"` のフォールバック doc は
DM には適用しない — 通常チャンネル向けの trigger (多くは mention) が DM の既定
(passthrough) を上書きしてしまうため。DM の振る舞いを変えるのは `dm.yaml` だけ。

将来拡張 (必要になったら足す。§3 末尾):

- `image?: string` — チャンネル特化イメージ。単一サービスでは同居できないため、
  別 Cloud Run サービスを立てて委譲する構成 ([architecture.md](architecture.md) §1) とセットで導入
- `skills?: string[]` / `mcpServers?: string[]` — イメージ同梱能力の有効化選択。
  イメージ側の manifest 宣言とセットで導入

フィールドは**ホワイトリスト**であり、pi の settings を生でパススルーするフィールド
(`piSettings: {...}` のような) は置かない。理由:

- pi の内部仕様に Firestore の中身が結合し、pi 更新のたびに全チャンネルの doc が壊れうる
- 任意の extension パスや実行フラグを doc 編集で注入できると、
  「宛先はホストが握る」安全方針 ([chat-model.md](chat-model.md) §5.3) を Config 経由で迂回できてしまう
- 必要な設定が増えたら、その都度名前を付けてスキーマに足す (少数に保つ圧力になる)

## 3. 能力はイメージに焼く (初期版は manifest なし)

初期版はイメージ内の**固定パス規約だけ**で能力を与える。宣言ファイル (manifest) も
チャンネルごとの有効化選択も持たない:

```
/app/
  node_modules/@earendil-works/pi-coding-agent … pi 本体 (npm 依存)
  extensions/reply.ts             … reply extension (この基盤パッケージが同梱)
  skills/                         … 利用側リポジトリの skill (SKILL.md 形式)。全チャンネル共通
  server.js                       … Runner (この基盤パッケージ)
+ apt で入れた CLI (gcloud, kubectl, rg, jq …)
```

- **skill は全チャンネル共通で全部有効**。チャンネルで能力を絞りたい欲求は、まず
  systemPrompt (「このチャンネルでは X をするな」) で受け、それで足りなくなったら
  §2 の将来拡張 (manifest + 選択) を導入する
- **MCP は初期版で見送り**。pi 本体は MCP をネイティブに持たない (coding-agent core に
  MCP 結線は無く、繋ぐなら extension を書くことになる)。エージェントの能力は
  **イメージ内の CLI + skill** で賄う — CLI は pi の bash ツールから叩け、使い方は skill で
  教えられるので、初期ユースケース (§1) には十分
- skill を頻繁に書き換える運用が生じたら GCS (`/data/skills/`) 読み込みを足す ([architecture.md](architecture.md) §9)。
  既定はイメージ同梱 (バージョンが image tag に固定され「どの skill で動いたか」が再現できる)

## 4. コンテナへの与え方と kick

設定がコンテナに入るタイミングは 3 つ。**ビルドで能力、デプロイで秘匿と既定値、
実行時にチャンネル差分**、と役割が重ならない:

| タイミング | 与えるもの | 手段 |
|---|---|---|
| ビルド時 | pi 本体 / reply extension / skill / CLI | Dockerfile (利用側リポジトリで build) |
| デプロイ時 | Slack token・signing secret / app 既定値 (モデル, bucket) | Cloud Run `--set-secrets` + env。実行時に Secret Manager を引くコードは書かない |
| 実行時 (セッションごと) | ChannelDoc の差分 (プロンプト・model) + transcript | Firestore read → pi の spawn 引数 |

Vertex AI の認証は Cloud Run のサービスアカウント (ADC) で済むため、API キーの配布は無い。

### kick — Runner が pi を子プロセスで起動する

pi の CLI がそのまま注入ポイントになる (`--mode rpc` / `--session` /
`--append-system-prompt` / `--extension` / `--skill` は実在のフラグ)。
中間の設定ファイル生成は不要:

```typescript
// lease 取得後、ターン実行の頭で
const workdir = `/tmp/sessions/${threadTs}`;           // tmpfs。セッション別 ([session-model.md](session-model.md) §7)
await restoreFromGcs(workdir, sessionFile);            // transcript を GCS からコピー (無ければ新規)

const pi = spawn("pi", [
  "--mode", "rpc",                                     // stdin/stdout JSONL
  "--session", `${workdir}/transcript.jsonl`,
  "--model", channel.model ?? env.DEFAULT_MODEL,
  "--append-system-prompt", buildPrompt(channel),      // app 共通 + ChannelDoc.systemPrompt
  "--extension", "/app/extensions/reply.ts",           // 常時注入 (Config で外せない)
  "--skill", "/app/skills",                            // イメージ同梱 (全チャンネル共通)
], { cwd: workdir });

pi.stdin.write(promptJsonl(drainedEvents));            // 束ねた入力を投入
pi.stdout → onEvent:                                   // RPC イベント購読
  tool_execution_end (reply) → thread_key 解決 → chat.postMessage
  agent_end                  → idle 判定へ
// ターン境界: inbox ポーリング → steer/followUp を stdin から注入
// 終了: transcript を GCS へ書き戻し → プロセス破棄 (状態はファイルに全部ある)
```

- **プロセスは使い捨て**: pi は「状態はセッションファイル、プロセスはいつ殺してもよい」
  設計 ([../research/pi-session-model.md](../research/pi-session-model.md) orchestrator) なので、ターンごとに spawn して捨ててよい。linger 中に追撃が
  来たら同じ workdir で再 spawn するだけ
- ChannelDoc.context は初回ターンのみ prompt の先頭に足す (spawn 引数でなく入力側)

### 設定の優先順位 (初期版は 3 層)

```
app 既定 (env)  <  ChannelDoc  <  セッション config_change
     │                 │                  │
     └─ モデル既定値等    └─ チャンネル差分     └─ 実行中の /model 変更等 (transcript に記録 [session-model.md](session-model.md) §6)
```

manifest 層 ([§2] 将来拡張) を導入したときに app 既定と ChannelDoc の間に挟まる。

kick シーケンスの全体・env の allowlist・イメージの拡張規約は [session-runtime.md](session-runtime.md) に詳細化した。

## 5. Config に入れないもの (と、どこに行くか)

| 入れないもの | 置き場所 | 理由 |
|---|---|---|
| reply tool の注入・RPC 結線 | コード | 全チャンネル共通の安全方針。外せる設定にしない |
| pi settings の生パススルー | (存在しない) | §2 の通り。名前付きフィールドのみ |
| API キー・トークン類 | Secret Manager → Cloud Run `--set-secrets` で env に | Firestore doc に平文を置かない。実行時に Secret Manager を引くコードも書かない |
| MCP 接続 | (初期版では存在しない) | pi は MCP ネイティブ対応を持たない (§3)。能力は CLI + skill で賄い、必要になったら extension として結線 |
| lease TTL / linger / debounce / inbox ポーリング間隔 | env (全チャンネル共通の調整が要るなら agent.yaml §6 に昇格) | チャンネルごとに変える動機がまだ無い。生じたら §2 に昇格 |
| Slack token / EventSource 切替 | デプロイ設定 (env + Secret Manager) | チャンネルでなくデプロイの属性 |
| リポジトリの clone 指定 | イメージ焼き込み or GCS tarball ([session-model.md](session-model.md) §7) | コールドスタートを Config で悪化させない |
| ツールの allowlist | イメージ (入れない CLI は使えない) | 「何ができるか」は doc 編集でなくイメージのレビューで変わるべき。細粒度の許可制御が要る運用になったら名前付きフィールドとして昇格を検討 |

**迷ったときの判定順**:

1. 秘匿値か? → Secret Manager (名前参照)
2. 実行体 (バイナリ・プロセス) を伴うか? → イメージ (+ manifest 宣言)
3. チャンネルごとに変えたいか? → ChannelDoc (名前付きフィールドを足す)
4. セッション中だけ変えたいか? → config_change エントリ (transcript)
5. どれでもない → コード / env (全チャンネル共通の動作原理)

## 6. 記述形式 — YAML をリポジトリに置き、apply で Firestore へ

「Firestore が実行時の正」は変えずに、**人が書く形式はリポジトリ内の YAML** とし、
CLI の apply で Firestore に書き込む。書く場所と読む場所を分ける。

### 選択肢の比較

| 方式 | 長所 | 短所 | 判断 |
|---|---|---|---|
| Firestore console / CLI で直接編集 | 手数最小 | レビューなし・履歴なし・タイポ即本番 | 緊急の一時変更のみ |
| **YAML + apply (採用)** | git でレビュー・履歴・ロールバック。複数行テキストが書きやすい | apply の一手間 | 基本線 |
| Slack コマンドで編集 (`/agent config`) | チャットで完結 | 権限制御と検証 UI を自作するはめになる | やらない (閲覧系 `/agent status` は将来可) |
| 環境変数 / イメージに焼く | 不変で安全 | 「デプロイなしで変えられる」利点が消える | ChannelDoc の存在意義と矛盾 |

YAML を選ぶ決め手は**複数行テキスト**。この Config の中身はプロンプト・分類器の
自然文 criteria などテキストが主役で、JSON では書けず TOML でも読みにくい。
さらに長いプロンプトは Markdown ファイルに逃がし、YAML からファイル参照する。

### リポジトリ構成 (npm パッケージ利用側)

この仕組みを npm パッケージとして使う側のリポジトリに、設定一式を置く:

```
agent-config/
  agent.yaml            # bridge 本体の設定 (チャンネル横断の挙動既定。下記)
  channels/
    alerts.yaml         # ChannelDoc 相当 (1 チャンネル 1 ファイル)
    proj-x.yaml
  prompts/
    alerts.md           # 長文プロンプト (YAML から参照)
```

```yaml
# channels/alerts.yaml
channel: "#alerts"        # apply 時に Slack API で channelId に解決 (改名に強いのは ID。両方可)
systemPrompt: ./prompts/alerts.md   # ファイル参照は apply 時にインライン化
context:
  - ./prompts/escalation.md
trigger:
  combinator: all
  debounceSec: 30
  gates:
    - kind: keyword
      pattern: "(ALERT|ERROR|CRIT)"
    - kind: classifier
      criteria: |
        インフラのアラートや障害報告と思われる発言。
        雑談や既に対応中と明言されたものは除く
model: gemini-3-pro
```

(skill や CLI はここに現れない — イメージ側の関心事 (§3)。YAML が持つのはテキストと trigger と model だけ)

### agent.yaml — bridge 本体の設定ファイル

チャンネル横断の bridge の挙動既定は CONFIG_DIR 直下の `agent.yaml` に書く。
channels/*.yaml と同じ設定の木に置くが (1 つの設定リポジトリで全部見える)、
ファイルとしては分けたまま合流させない。性質が違うため:

| | agent.yaml | channels/*.yaml |
|---|---|---|
| 対象 | bridge プロセスの挙動既定 (全チャンネル共通) | チャンネルごとの振る舞い差分 |
| 読むタイミング | boot 時に 1 回。変更の反映は再起動/デプロイ | イベントごと |
| Firestore | 経由しない (apply の対象外) | 本番は apply で書き込む (§6) |

```yaml
# agent.yaml (すべて省略可。ファイル自体が無ければ全項目コード既定)
pi:
  provider: google-vertex
  model: gemini-3.5-flash
  turnTimeoutMs: 600000   # 1 ターンの上限。超過で pi を kill (session-runtime.md §6)
  envPassthrough:         # pi へ継承する env 名の追加 allowlist (session-runtime.md §2)。
    - GH_TOKEN            # SLACK_ 等の bridge 予約 prefix はコードで拒否する
```

優先順位は **env > agent.yaml > コード既定**。env は「ローカルで一時的に変えて
試す」ための override として残す (PI_PROVIDER / PI_MODEL / TURN_TIMEOUT_MS /
PI_ENV_PASSTHROUGH が対応)。boot 時に strict に validate し、未知キーは
fail-loud で落とす (apply の validate と同じ姿勢)。

agent.yaml に**入れない**もの:

| 入れないもの | 置き場所 | 理由 |
|---|---|---|
| secret | Secret Manager → env | 平文を repo に置かない (§5)。envPassthrough に書くのは env の**名前**だけで値ではない |
| 環境の同一性 (SLACK_MODE / STORE_BACKEND / PORT / GOOGLE_CLOUD_PROJECT) | env | デプロイ先ごとに変わるのが本質。runtime が提供する env が適所 |
| 実行環境の記述 (PI_AGENT_UID/GID / PI_PERMISSION_MODE / PI_ENTRYPOINT 等) | env | イメージ・OS レイアウトとペアの値で、イメージを変えるときにしか変わらない |

### apply フロー

```
YAML + .md ──validate──▶ ChannelDoc (JSON) ──diff 表示──▶ Firestore 書き込み
             (スキーマ検証・         (ファイル参照の        (現在の doc との差分を
              チャンネル名解決)       インライン化)          確認してから write)
```

- **validate は apply 時に厳格に** (スキーマ違反・存在しない skill 名はここで止める)。
  実行時の fail-soft (§3) は「Firestore に直接書かれた変な doc」への防御として残す
- **ファイル参照は apply 時にインライン化**して Firestore doc を自己完結にする。
  実行時にリポジトリへの依存が無い — Runner は Firestore だけ読めば動く
- 適用は手動 CLI から始め、運用が固まったら CI (main マージで apply) に昇格
- git が監査ログを兼ねる。「いつ誰がどのプロンプトに変えたか」は Firestore でなく
  git history で追う

### ローカル/お試しでの直読み

Socket Mode でのローカル動作確認 ([architecture.md](architecture.md) §1) では、Firestore を経由せず
**同じ YAML をファイルから直接読む**ローダーを使える:

```typescript
interface ConfigSource { channel(id: string): Promise<ChannelDoc | null>; }
class FirestoreConfigSource implements ConfigSource {}  // 本番
class FileConfigSource implements ConfigSource {}       // ローカル: YAML を直接パース
```

スキーマは同一 (validate も共通)。EventSource の差し替え (Events API / Socket Mode) と
対になる差し替え軸で、「ローカルは apply 不要で YAML を編集 → 即再現」ができる。

## §7 ユーザーのカスタマイズポイント全体地図

利用者から見た「何をどこでカスタマイズするか」の一覧。§0 の置き場所判断を
利用者視点で裏返したもの。

| カスタマイズしたいこと | 層 | 記述場所 | 形式 |
|---|---|---|---|
| Slack 接続・認証情報 | デプロイ | Cloud Run の service.yaml (secretKeyRef で Secret Manager 参照) | YAML (Cloud Run ネイティブ) |
| bridge の挙動既定 (既定 model / turn timeout / envPassthrough) | 設定リポジトリ | CONFIG_DIR/agent.yaml (§6) | YAML |
| Gate の選択 + 設定値 (分類プロンプト・モデル) | チャンネル | channels/*.yaml の trigger | YAML |
| 初期プロンプト・文脈 | チャンネル | channels/*.yaml + prompts/*.md 参照 | YAML + Markdown |
| 利用モデル | チャンネル | channels/*.yaml の model | YAML |
| CLI・コマンド追加 / pi-extension / skill | 実行環境 | Dockerfile (FROM base + 固定パス COPY, [session-runtime.md](session-runtime.md) §5) | コード (イメージ) |
| ユーザー CLI 用の secret (例: GH_TOKEN) | デプロイ + 設定リポジトリ | 値は --set-secrets (service.yaml)、pi へ通す名前は agent.yaml の envPassthrough ([session-runtime.md](session-runtime.md) §2) | YAML |

bridge の挙動設定の置き場は CONFIG_DIR/agent.yaml (§6)。「service.yaml を bridge の
設定ファイルとして扱う」案も検討したが、それは Cloud Run 固有の整理で、EventSource /
Store と同様に runtime を差し替え可能に保つ方針 ([architecture.md](architecture.md) §1) と衝突するため
やめた。env の役割は secret・環境の同一性・一時的な override に限定し (§6 の表)、
挙動の宣言は runtime に依存しない設定リポジトリ側の YAML に置く。これで
「実行環境以外のカスタマイズは YAML で表現できる」が全層で成立する。

「agent の設定 (Gate)」と「チャンネルの設定 (プロンプト)」は概念としては別だが、
格納は同じ ChannelDoc の別フィールド (trigger vs systemPrompt/context/model)。
分ける必要が出るのは Gate 設定をチャンネル横断で共有したくなったときで、初期版では不要。

### Gate は registry 選択式

Gate はこの基盤が提供する type 名から選び、設定値を添える。apply 時 (§6) に
type の存在と設定スキーマを strict に検証する。YAML 例:

```yaml
trigger:
  combinator: any
  gates:
    - kind: mention
    - kind: classifier
      model: gemini-2.5-flash-lite
      prompt: ./prompts/gate-triage.md   # prompts/ のファイル参照を再利用
  cooldownSec: 60
```

この方式で「**YAML = データ、コード搬入 = イメージのみ**」という安全特性が
明文化される。YAML をどう書いても新しいコード実行経路は生えない (プロンプトは
データ、Gate 選択は登録済みコードの選択)。

### 初期版でできないこと (線引き)

| できないこと | 理由 | 回避策 / 将来パス |
|---|---|---|
| custom Gate (利用者コード) | Gate は bridge プロセス内で動くため、pi イメージ拡張では追加できず bridge 本体のコード拡張になる | classifier のプロンプトで表現力を吸収。それでも足りなければ bridge の fork |
| チャンネルごとの能力差 (skill/CLI の有無) | イメージは全チャンネル共通 | 抑制はプロンプトで行う。強い分離が要るなら将来の image フィールド (§2 の将来拡張) |
| ChannelDoc への secret 記載 | Firestore に平文 secret を置かない方針 (§5) | Secret Manager + --set-secrets (値) + agent.yaml の envPassthrough (名前, [session-runtime.md](session-runtime.md) §2) |
