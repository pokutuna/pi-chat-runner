# Config 設計 — pi を動かすために何をどこに置くか

チャンネルごとに pi の振る舞いを変えるための設定 (Config) の整理。
「何を Config (ChannelDoc) に入れ、何を入れないか」の判断基準と、
pi 起動設定への実体化を定める。関連: [architecture.md](architecture.md) §2,
[components.md](components.md) Config 節, [session-model.md](session-model.md) §7。

## 0. 結論 — 置き場所は 4 つ + 秘匿

| 置き場所 | 何を置くか | 変更の手段 |
|---|---|---|
| **env** | 設定ファイルが `${env.X}` で参照する値の source (Slack token・store backend 等) + boot 前提 (CONFIG_PATH / LOG_LEVEL)。secret は値でなく env 名で拾う | デプロイ (Cloud Run env + `--set-secrets`) |
| **コンテナイメージ** | 実行能力: pi 本体、CLI ツール (gcloud 等)、**skill**、reply/permission-gate extension、焼き込みリポジトリ | イメージビルド + デプロイ |
| **設定ファイル `agent.yaml` の boot ブロック (設定リポジトリ)** | bridge 本体の挙動宣言: connector (接続) / store (永続化) / agent (実行環境)。boot 時に 1 回直読み。値は `${env.X}` 参照で env と結ぶ | ファイル編集 + 再起動 |
| **同ファイルの `channels` ブロック (設定リポジトリ)** | 振る舞いのテキスト: プロンプト、起動条件、モデル (初期版はこれだけ。能力の選択は将来拡張 §2)。イベントごとに読み直す | ファイル編集 (デプロイ・再起動不要) |
| **GCS (/data)** | セッションが生む状態: transcript / workspace / artifacts。+ 大きな読み取り専用データ (docs/) | 随時 |
| Secret Manager | 秘匿値: Slack token、(将来の) 外部 API キー。値は Secret Manager → env に注入し、`agent.yaml` からは **`${env.X}` で名前参照のみ** | 随時 |

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
  必要になったら Ingress の追加として扱う ([components.md](components.md) 拡張の軸)

## 2. ChannelDoc スキーマ

チャンネル設定は**振る舞いのテキストと trigger、およびイメージに焼いた能力への参照**を
持つ。能力 (skill / CLI / extension) の実体は常にイメージに焼く — config が持てるのは
そのパスだけ。全チャンネル共通の skill / extension は pi の自動発見パス
(`$AGENT_HOME/.pi/agent/skills|extensions/`) に焼けば config 不要で常に有効。
チャンネル別にしたいものは自動発見されない場所 (例 `/app/skills/`) に焼き、
`skills` / `extensions` フィールドで **additive に追加**する (共通分を外す手段ではない)。

チャンネル設定は設定ファイル (§6) の `channels` ブロックに**配列**で並べ、先頭に
**必ず `default`** エントリを置く。実行時は常に **`default` + そのチャンネル固有
エントリ** をマージした 1 つの ChannelDoc で動く (§2.2 マージ)。「どの値がどこから
来たか」がファイル上で 1 対 1 に読めるよう、フィールド構造は default とチャンネルで
完全に同じにする。

```yaml
# channels ブロック — 配列。先頭の default は必須、以降は channel ごとの差分
channels:
  - channel: default        # 予約名。全チャンネルの土台。ここだけは省略不可
    model: gemini-3.5-flash # pi (agent) のモデル既定
    trigger:
      when:
        - kind: mention     # 既定は mention のみ (§7 trigger.when)

  - channel: "#alerts"      # Slack API で channelId に解決 (ID 直書きも可)
    model: gemini-3-pro     # default.model を上書き
    systemPrompt: ./prompts/alerts.md
    trigger:                # trigger は単位で置換 (§2.2)。default の mention は引き継がない
      when:
        - kind: keyword
          pattern: "(ALERT|ERROR|CRIT)"
        - and:
            - kind: classifier
              criteria: インフラのアラートや障害報告と思われる発言
```

```typescript
// マージ後の実行時 ChannelDoc。channel 解決済み。無ければ default 単独と同じ
interface ChannelDoc {
  systemPrompt?: string;   // 役割・口調・チャンネル運用ルール (app 共通プロンプトに追記)
  context?: string[];      // 短い参照テキスト (数 KB まで)。長い・多いものは skill へ
  trigger?: TriggerConfig; // Gate 合成木 ([session-model.md](session-model.md) §5, §7)。省略時は mention のみ
  model?: string;          // pi (agent) のモデル。省略時は app 既定 (§2.3)
  tools?: string[];        // pi --tools allowlist
  excludeTools?: string[]; // pi --exclude-tools denylist
  skills?: string[];       // チャンネル別に追加する skill のパス (pi --skill、additive)
  extensions?: string[];   // チャンネル別に追加する extension (.ts/.js) のパス (pi --extension、additive)
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

`skills` / `extensions` はチャンネル別に追加ロードする能力への**パス参照** (pi の
`--skill` / `--extension` に渡る)。セマンティクスと制約:

- **additive**: 自動発見分 (共通 skill / extension、および Runner 常時注入の
  reply/permission-gate/export) への追加であって、選択・除外の手段ではない
- **パスの意味論は pi にそのまま委ねる**: `skills` は SKILL.md を直接含む単体 skill
  dir でも、複数 skill を束ねた親 dir でもよい (pi が SKILL.md を再帰発見する)。
  `extensions` は .ts/.js のファイルパス (pi の `--extension` はディレクトリを受けない)
- **絶対パス、または設定ファイルの場所からの相対 (`./` 始まり) のみ**。裸の相対パス
  ("skills/foo") は基準 (config dir か workdir か) が曖昧なので schema で弾く。相対は
  ConfigSource が絶対化してから渡す — Runner と pi は常に同一ファイルシステム上にいる
  (pi は Runner の子プロセス) ため、コンテナ/ホストの区別は生じない
- **実在しないパスは kick 失敗 (fail-loud)**: 黙って能力抜きで動くと調査コストが高い
- **セキュリティ**: channels ブロックは再起動なしで反映される (§6) が、extension は
  pi 子プロセス内 (UID 分離下) で動くため、パス注入で得られる権限は systemPrompt 編集で
  agent の bash に任意コードを実行させられるのと同等 — config 編集者 = デプロイ者という
  前提では実質的な昇格にならない。Node Permission Model 有効時、read 許可は指定パスの
  ディレクトリにだけ自動で足す

### 2.1 default と channel の関係

- `channel: default` は**必須の予約エントリ**で、全チャンネルの土台になる。ここに
  書いた値が、固有エントリで上書きされない限りそのまま効く。
- 個別チャンネルのエントリは「default からの差分」だけを書く。省略したフィールドは
  default の値をそのまま受け継ぐ (マージ規則は §2.2)。
- ファイルに固有エントリが無いチャンネルは **default 単独** で動く。つまり「doc が
  無いチャンネル」= default そのもの。
- **DM は default を継承しない**。予約名 `dm` エントリを別の土台として扱い、
  `dm` エントリ + その channelId 固有エントリ (通常は無い) をマージする。default の
  trigger (多くは mention) が DM の既定 (passthrough) を壊さないようにするため。
  `dm` エントリも無ければ DM は passthrough (§1 の表の通り)。DM の既定が channel と
  違うのは、1:1 の明示的な話しかけでメンションが自然な操作にならないから。
- **DM を一切許可しない運用にしたい場合**、`dm` エントリを書いて `trigger.when: []`
  にする。`evaluateWhen` は空配列を「vacuously false」として扱う (§7、gate.ts) ため、
  誰が DM を送っても起動しなくなる。同じ考え方は通常チャンネルの `default` にも
  適用でき、「未登録チャンネルからは一切起動しない」運用にしたい場合は
  `default.trigger.when: []` にする (ただし default は全チャンネルの土台なので、
  個別に許可したいチャンネルは trigger.when を持つ固有エントリで明示的に上書きする
  必要がある)。

### 2.2 マージ規則

`merge(default, channel)` の規則は**1 つだけ**:

> **channel に書いた top-level フィールド = その値。書かないフィールド = default の値。**

深いマージ (部分マージ) は**一切しない**。`session` や `reply` の内側キー、`trigger.when`
の木、`context` などの配列も、どれも「フィールド単位で丸ごと置換」する。

| フィールド | 規則 |
|---|---|
| `model` / `systemPrompt` (スカラ) | channel にあれば置換、無ければ default |
| `context` / `tools` / `excludeTools` (配列) | channel にあれば**配列ごと**置換 (要素マージしない) |
| `trigger` (木) | channel にあれば**丸ごと**置換 (`when` の木を部分マージしない) |
| `session` / `reply` (object) | channel にあれば**object ごと**置換 (内側キーもマージしない) |

このルールを選ぶ理由は **「default を頭の中で合成しなくても、channel エントリだけ読めば
実際に効く値が全部そこにある」** を成り立たせるため。フィールドごとに「これはマージ・
これは置換」と規則が分かれていると、実効設定を知るのに default を覚えて頭で合成する
必要が出る。全フィールド一律置換なら、channel に書いたキーはそのまま・書かないキーは
default、とだけ覚えればよい。

代償は、`session.mode` だけ変えたいときも `session` を丸ごと (他のキーも) 書く必要が
あること。だが session/reply は小さな object なので負担は小さく、「一部だけ上書き」の
曖昧さを消せる利点の方を取る。

**それでも実効設定は dump で確認できる** (§6 実効設定の書き出し)。channels ブロックは
「差分の宣言」、`show` コマンドの出力は「合成済みの事実」と割り切り、迷ったら手で
合成せず dump を見る。

### 2.3 モデルの指定

モデル指定は 2 系統あり、**役割が違うので別の場所に書く**:

| 用途 | 書く場所 | 既定の解決順 |
|---|---|---|
| pi (agent) 本体 | `model` (default / channel) | channel.model → default.model → コード既定 |
| classifier の判定 | `trigger.when[]` の各 classifier ノードの `model` (§7) | ノードの `model` → コード既定 |

pi は実作業を担うので性能が要る。classifier は trigger 判定だけなので低コスト・高速な
モデル (lite 系) を充てる。両者を同じ `model` に相乗りさせると「片方だけ上げたい」が
表現できないため、classifier のモデルは**その判定を書く場所 (`trigger.when` の
classifier ノード) にそのまま `model` で添える**。service 単位の共通既定という中間層は
置かない — モデルは常に「pi 本体 = `model`」「classifier = そのノードの `model`」の
2 箇所だけで完結し、階層をたどらなくても出所が分かる。未指定時のコード既定 (fallback)
は bridge の 1 箇所に置く。

将来拡張 (必要になったら足す。§3 末尾):

- `image?: string` — チャンネル特化イメージ。単一サービスでは同居できないため、
  別 Cloud Run サービスを立てて委譲する構成 ([architecture.md](architecture.md) §1) とセットで導入
- `mcpServers?: string[]` — MCP は pi がネイティブに持たないため見送り中 (§3)。
  繋ぐなら extension を書き `extensions` で参照する

フィールドは**ホワイトリスト**であり、pi の settings を生でパススルーするフィールド
(`piSettings: {...}` のような) は置かない。理由:

- pi の内部仕様に channels ブロックの中身が結合し、pi 更新のたびに全チャンネルの doc が壊れうる
- 実行フラグを doc 編集で自由に注入できると、「宛先はホストが握る」安全方針
  ([chat-model.md](chat-model.md) §5.3) を Config 経由で迂回できてしまう
  (`skills` / `extensions` のパス参照は例外だが、実体はイメージに焼かれたもの
  しか指せず、権限も agent 相当に留まる — §2 のセキュリティ項)
- 必要な設定が増えたら、その都度名前を付けてスキーマに足す (少数に保つ圧力になる)

## 3. 能力はイメージに焼く (初期版は manifest なし)

初期版はイメージ内の**固定パス規約 + チャンネルからのパス参照**で能力を与える。
宣言ファイル (manifest) は持たない:

```
/app/
  node_modules/@earendil-works/pi-coding-agent … pi 本体 (npm 依存)
  extensions/reply.ts             … reply extension (この基盤パッケージが同梱)
  skills/                         … 利用側リポジトリの skill (SKILL.md 形式)。全チャンネル共通
  server.js                       … Runner (この基盤パッケージ)
+ apt で入れた CLI (gcloud, kubectl, rg, jq …)
```

- **pi の自動発見パスに焼いた skill は全チャンネル共通で全部有効**。チャンネル別の
  skill は自動発見されない場所に焼いて `skills` で参照する (§2)。チャンネルで能力を
  **絞る**欲求は、まず systemPrompt (「このチャンネルでは X をするな」) で受け、
  それで足りなくなったら選択・除外のセマンティクスを導入する
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
| ビルド時 | pi 本体 / reply・permission-gate extension / skill / CLI | Dockerfile (利用側リポジトリで build) |
| デプロイ時 | Slack token・signing secret / store backend / bucket 等 | Cloud Run `--set-secrets` + env。`agent.yaml` が `${env.X}` で拾う。実行時に Secret Manager を引くコードは書かない |
| 実行時 (セッションごと) | ChannelDoc の差分 (プロンプト・model) + transcript | 設定ファイルの channels ブロック直読み (FileConfigSource) → pi の spawn 引数 |

Vertex AI の認証は Cloud Run のサービスアカウント (ADC) で済むため、API キーの配布は無い。

### kick — Runner が pi を子プロセスで起動する

pi の CLI がそのまま注入ポイントになる (`--mode rpc` / `--session` /
`--append-system-prompt` / `--extension` / `--model` は実在のフラグ)。
中間の設定ファイル生成は不要:

```typescript
// lease 取得後、ターン実行の頭で
const workdir = `/tmp/sessions/${threadTs}`;           // tmpfs。セッション別 ([session-model.md](session-model.md) §7)
await restoreFromGcs(workdir, sessionFile);            // transcript を GCS からコピー (無ければ新規)

// pi の entrypoint / node_modules は import.meta.resolve で自動検出する
// (PI_ENTRYPOINT 等の env で渡さない。§4「pi のパス自動検出」)
const pi = spawn("node", [
  "--permission",                                      // Node Permission Model (既定 ON)
  "--allow-fs-read=...", "--allow-fs-write=...",       // workdir / HOME / extension dir に限定
  piEntrypoint,                                        // 自動検出した dist/cli.js
  "--mode", "rpc",                                     // stdin/stdout JSONL
  "--session", `${workdir}/session.jsonl`,
  "--model", channel.model,                            // channels の model (未指定なら pi 既定)
  "--append-system-prompt", buildPrompt(channel),      // app 共通 + ChannelDoc.systemPrompt
  "--extension", "/app/extensions/reply.ts",           // 常時注入 (Config で外せない)
  "--extension", "/app/extensions/permission-gate.ts", // 常時注入 (事故防止層)
  // 共通 skill は pi 既定パス ($AGENT_HOME/.pi/agent/skills) の自動ロードに任せ
  // --skill は配線しない。チャンネル別の追加分 (ChannelDoc.skills / .extensions §2)
  // だけを --skill / --extension で追加する
], { cwd: workdir });

pi.stdin.write(promptJsonl(drainedEvents));            // 束ねた入力を投入
pi.stdout → onEvent:                                   // RPC イベント購読
  tool_execution_end (reply) → thread_key 解決 → chat.postMessage
  agent_end                  → idle 判定へ
// ターン境界: inbox ポーリング → steer/followUp を stdin から注入
// 終了: transcript を GCS へ書き戻し → プロセス破棄 (状態はファイルに全部ある)
```

- **pi のパス自動検出**: pi の entrypoint (`dist/cli.js`) と node_modules ルートは
  `import.meta.resolve("@earendil-works/pi-coding-agent")` で自動検出する (server.ts の
  `resolvePiPaths`)。旧 `PI_ENTRYPOINT` / `PI_NODE_MODULES_DIR` / `PI_BIN` / `PI_APP_DIR`
  は全廃。pi は package.json の dependencies で、Docker は `pnpm install --prod` で
  `/app/node_modules` に置く (別 COPY 合成はしない)
- **起動は Node Permission Model 経由**: `agent.runtime.permissionMode` (既定 ON) のとき
  `node --permission --allow-fs-read=... --allow-fs-write=... <entrypoint> <pi 引数>` で
  起動し、read は workdir / HOME / extension のディレクトリ、write は workdir と HOME に
  限る。詳細は [session-runtime.md](session-runtime.md) §6。`permissionMode: false` で
  従来どおり pi を直接起動する
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

kick シーケンスの全体・pi へ渡す env (`agent.env` の足し算モデル §5)・イメージの拡張規約は
[session-runtime.md](session-runtime.md) に詳細化した。

## 5. Config に入れないもの (と、どこに行くか)

| 入れないもの | 置き場所 | 理由 |
|---|---|---|
| reply tool の注入・RPC 結線 | コード | 全チャンネル共通の安全方針。外せる設定にしない |
| pi settings の生パススルー | (存在しない) | §2 の通り。名前付きフィールドのみ |
| API キー・トークン類 | Secret Manager → Cloud Run `--set-secrets` で env に。`agent.yaml` からは `${env.X}` で名前参照 | YAML に平文を置かない。実行時に Secret Manager を引くコードも書かない |
| MCP 接続 | (初期版では存在しない) | pi は MCP ネイティブ対応を持たない (§3)。能力は CLI + skill で賄い、必要になったら extension として結線 |
| lease TTL / linger / debounce / inbox ポーリング間隔 | env (全チャンネル共通の調整が要るなら agent.yaml §6 に昇格) | チャンネルごとに変える動機がまだ無い。生じたら §2 に昇格 |
| Slack token / Ingress 切替 | `agent.yaml` の connector.slack (値は `${env.X}` 経由) | チャンネルでなく接続の属性。§6 で connector に集約 |
| リポジトリの clone 指定 | イメージ焼き込み or GCS tarball ([session-model.md](session-model.md) §7) | コールドスタートを Config で悪化させない |
| ツールの allowlist | イメージ (入れない CLI は使えない) | 「何ができるか」は doc 編集でなくイメージのレビューで変わるべき。細粒度の許可制御が要る運用になったら名前付きフィールドとして昇格を検討 |

**迷ったときの判定順**:

1. 秘匿値か? → Secret Manager (名前参照)
2. 実行体 (バイナリ・プロセス) を伴うか? → イメージ (+ manifest 宣言)
3. チャンネルごとに変えたいか? → ChannelDoc (名前付きフィールドを足す)
4. セッション中だけ変えたいか? → config_change エントリ (transcript)
5. どれでもない → コード / env (全チャンネル共通の動作原理)

## 6. 記述形式 — YAML をリポジトリに置き直読みする

**人が書く形式はリポジトリ内の YAML** とし、それを**そのまま実行時に直読み**する
(`FileConfigSource`)。書く場所と読む場所が同じ 1 つの YAML で、中間ストア (Firestore) や
焼き込みステップ (apply) は挟まない — YAML がマスター。

### 選択肢の比較

| 方式 | 長所 | 短所 | 判断 |
|---|---|---|---|
| **YAML をリポジトリに置き直読み (採用)** | git でレビュー・履歴・ロールバック。複数行テキストが書きやすい。書いた YAML がそのまま効く (中間表現なし) | 反映に再デプロイ (イメージ or 設定リポジトリの取り込み) が要る | 基本線 |
| Firestore console / CLI で直接編集 + apply で焼く | ランタイムが単一ストアだけ見ればよい | レビュー UI・apply の一手間・secret 焼き込み漏洩の懸念。中間表現と YAML の二重管理 | やらない (廃止) |
| Slack コマンドで編集 (`/agent config`) | チャットで完結 | 権限制御と検証 UI を自作するはめになる | やらない (閲覧系 `/agent status` は将来可) |
| 環境変数 / イメージに焼く | 不変で安全 | 「デプロイなしで変えられる」利点が消える | channels ブロックの存在意義と矛盾 |

YAML を選ぶ決め手は**複数行テキスト**。この Config の中身はプロンプト・分類器の
自然文 criteria などテキストが主役で、JSON では書けず TOML でも読みにくい。
さらに長いプロンプトは Markdown ファイルに逃がし、YAML からファイル参照する。

Firestore + apply を採らない理由は、YAML を直読みできる以上、中間ストアと焼き込みは
「二重管理と secret 焼き込みの経路」を増やすだけで得が無いから。ConfigSource 実装は
`FileConfigSource` の 1 つだけで、本番もローカルも同じ YAML を同じローダーで読む。

### リポジトリ構成 (npm パッケージ利用側)

この仕組みを npm パッケージとして使う側のリポジトリに、設定一式を置く:

```
agent-config/
  agent.yaml            # 設定ファイル本体 (connector/store/agent + channels。下記)
  prompts/
    alerts.md           # 長文プロンプト (YAML からファイル参照)
```

設定は **1 ファイル**にまとめる。channels を分けない理由は、boot ブロックと
channels で読むタイミングは違っても「この bot の構成」としては 1 つの宣言であり、
ファイルを分けても対応関係の把握が難しくなるだけだから。チャンネルも同じファイル内の
配列に束ねる — **default と各チャンネルの対応関係を 1 画面で見比べられる**ように
するため。ファイル名は自由 (CONFIG_PATH で指すのはファイルパス)。長文プロンプト
だけは Markdown に逃がし、設定ファイルのあるディレクトリからの相対パスで参照する。

```yaml
# channels ブロック (agent.yaml 内)
channels:
  - channel: default          # 必須の土台 (§2.1)
    model: gemini-3.5-flash
    trigger:
      when:
        - kind: mention

  - channel: "#alerts"        # Slack API で channelId に解決 (ID 直書きも可)
    systemPrompt: ./prompts/alerts.md   # ファイル参照は実行時に読み込む (ディスクへ書き戻さない)
    context:
      - ./prompts/escalation.md
    model: gemini-3-pro       # default.model を上書き (§2.2)
    trigger:                  # trigger 単位で置換 (§2.2)
      debounceSec: 30
      when:
        - and:                # keyword AND classifier (§7)
            - kind: keyword
              pattern: "(ALERT|ERROR|CRIT)"
            - kind: classifier
              criteria: |
                インフラのアラートや障害報告と思われる発言。
                雑談や既に対応中と明言されたものは除く
```

(skill や CLI はここに現れない — イメージ側の関心事 (§3)。YAML が持つのはテキストと trigger と model だけ)

### agent.yaml — 設定ファイル

設定は `CONFIG_PATH` (既定 `examples/config/agent.yaml`) が指す **1 つの YAML** に書く。
connector (接続) → store (永続化) → agent (エージェント実行) → channels
(チャンネルごとの振る舞い) を「**入口 → 出口**」の順に 1 ファイルへ並べる。
ファイルは 1 つだが、ブロックによって読み方が違う:

| | boot ブロック (connector / store / agent) | channels ブロック |
|---|---|---|
| 対象 | bridge プロセスの構成 (接続・永続化・実行環境。全チャンネル共通) | チャンネルごとの振る舞い (default + 差分) |
| 読むタイミング | boot 時に 1 回。変更の反映は再起動/デプロイ | イベントごと (再起動不要) |
| 解決 | 3 モジュール (connector / store / agent) が同じファイルを読み、各自のトップレベルキーだけ取り出す | FileConfigSource がイベントごとに channels キーだけ取り出す |
| `${env.X}` 参照 | 解決する (secret はここで env から拾う) | 解決しない (secret を書く場所ではない。dump の安全性の根拠、下記) |

boot ブロックの値には `${env.X}` / `${env.X:-default}` で環境変数を参照できる
(下記「`${env.X}` 参照」)。secret は値を直書きせず `${env.X}` で env (Secret Manager
由来) を拾う。同じ書き方で「値直書き」も「env 注入」も表現でき、YAML 側で
`${env.X:-default}` に一本化すると読みやすい。

```yaml
# agent.yaml — connector (接続) → store (永続化) → agent (実行) → channels (振る舞い) の順。
# boot ブロックの値には ${env.X} / ${env.X:-default} を書ける。secret は ${env.X} で env を拾う。

# --- connector: チャット接続 (受信 Ingress + 送信 Egress) ---
connector:
  slack:
    mode: ${env.SLACK_MODE:-socket}       # socket | events。既定 socket
    botToken: ${env.SLACK_BOT_TOKEN}      # 送信・自己判定用 (常に必須, xoxb-...)
    botUserId: ${env.SLACK_BOT_USER_ID}   # 自分への mention 判定用 (常に必須, U...)
    socket:
      appToken: ${env.SLACK_APP_TOKEN:-}  # mode: socket のとき必須 (xapp-...)
    events:
      signingSecret: ${env.SLACK_SIGNING_SECRET:-}  # mode: events のとき必須
      port: ${env.PORT:-8080}             # events の listen ポート

# --- store: 永続化バックエンド ---
store:
  backend: ${env.STORE_BACKEND:-memory}   # memory | sqlite | firestore
  sqlite:
    path: ${env.SQLITE_PATH:-/tmp/pi-chat-runner/state.db}  # backend: sqlite 用

# --- agent: pi 本体の挙動・env・実行環境 ---
agent:
  provider: ${env.PI_PROVIDER:-google-vertex}   # pi の --provider
  turnTimeoutMs: ${env.TURN_TIMEOUT_MS:-600000} # 1 ターン上限 ms。超過で kill (session-runtime.md §6)
  progressNoticeIntervalMs: ${env.PROGRESS_NOTICE_INTERVAL_MS:-5000}  # 長時間ターンの進捗通知の間隔 ms。0 で無効化 (progress-notice.md)
  env:                    # pi 子プロセスへ渡す env の「足し算」(§5)。ここに書いた名前だけ
    GH_TOKEN: ${env.GH_TOKEN:-}   # が追加で pi に渡る。値は ${env.X} 参照可
  runtime:                # コンテナイメージの作り方と対になる実行環境設定
    uid: ${env.PI_AGENT_UID:-}
    gid: ${env.PI_AGENT_GID:-}
    permissionMode: ${env.PI_PERMISSION_MODE:-true}  # Node Permission Model。既定 ON
    home: ${env.PI_AGENT_HOME:-/home/agent}

# --- channels: チャンネルごとの振る舞い (§2。イベントごとに読み直す) ---
channels:
  - channel: default
    model: gemini-3.5-flash
    trigger:
      when:
        - kind: mention
```

boot ブロックに**モデルは置かない**。pi 本体のモデルは `channels` の
default.model / channel.model、classifier のモデルは `trigger.when` の各 classifier
ノードの `model` に書く (§2.3)。service 単位のモデル既定という中間層を持たないので、
boot ブロックには connector / store / agent.provider / agent.turnTimeoutMs /
agent.progressNoticeIntervalMs / agent.env / agent.runtime のような**モデル以外の
bridge 構成**だけが残る。

agent の一部フィールド (provider / turnTimeoutMs / progressNoticeIntervalMs / runtime.*)
は env も直接 override できる。優先順位は **env > agent.yaml > コード既定**
(PI_PROVIDER / TURN_TIMEOUT_MS / PROGRESS_NOTICE_INTERVAL_MS / PI_AGENT_UID・GID /
PI_PERMISSION_MODE / PI_AGENT_HOME が対応。resolveAgentConfig)。
これは `${env.X}` 参照とは別のロジックで二重に効きうるが、実運用では agent.yaml 側で
`${env.X:-default}` に一本化するのが読みやすい (env override 経路は「ローカルで一時的に
上書き」用に残す)。boot 時に strict に validate し、未知キーは fail-loud で落とす。

agent.yaml に**入れない**もの:

| 入れないもの | 置き場所 | 理由 |
|---|---|---|
| secret の値 | Secret Manager → env → `${env.X}` で参照 | 平文を repo に置かない (§5)。YAML に書くのは `${env.X}` の**env 名**だけで値ではない |
| pi のパス (旧 PI_ENTRYPOINT / PI_NODE_MODULES_DIR / PI_BIN / PI_APP_DIR) | (書かない — 自動検出) | server.ts の `resolvePiPaths` が `import.meta.resolve` で自動検出する (§4)。全廃 |
| skill の共通登録 | イメージ (pi 既定パス $AGENT_HOME/.pi/agent/skills) | pi が自動ロードする (§3)。チャンネル別の追加だけ channels の `skills` で参照する (§2) |

### `${env.X}` 参照

boot ブロック (connector / store / pi / agent) の値には `${env.X}` を書ける
(`src/config/env-ref.ts`)。secret を平文で置かず env (Secret Manager 由来) から拾う・
デプロイ先ごとに変わる値を YAML から切り出す、の両方をこの 1 記法でまかなう。
channels ブロックは解決対象外 (secret を書く場所ではなく、dump 経路が env に触れない
根拠になる):

- `${env.NAME}` — NAME が未設定なら**fail-loud で throw** (空文字は「設定された」扱い)。
- `${env.NAME:-default}` — 未設定 **または** 空文字のとき default を使う (シェルの
  `${VAR:-default}` と同じセマンティクス)。
- 解決順は **`yaml.parse` → `resolveEnvRefs(parsed, env)` → zod** の 3 段。`${env.X}` は
  zod の前に文字列として解決し、number / boolean への coerce は zod 側 (`z.coerce.number()`
  / `z.coerce.boolean()`) に委ねる (env-ref は string しか返さない)。
- YAML テキストではなく `parse` 済みオブジェクトを再帰走査して string 値の中だけ置換する
  ため、YAML 構造やコメントを壊さず、エラーで参照フィールドのパスを示せる。

### 直読み (FileConfigSource)

ConfigSource 実装は `FileConfigSource` の**1 つだけ** (`src/config/config-source.ts`)。
本番もローカルも同じ YAML を同じローダーで読む — 「本番は Firestore、ローカルはファイル」と
実装が分かれることはない:

```typescript
interface ConfigSource { channel(id: string): Promise<ChannelDoc | null>; }
class FileConfigSource implements ConfigSource {}  // YAML を直接パース (唯一の実装)
```

- **validate は読み込み時に厳格に**。スキーマ違反・未解決の `${env.X}` は boot / イベント
  処理で fail-loud に落とす。
- **ファイル参照 (`./prompts/*.md`) のインライン化は実行時 (FileConfigSource) の話**で、
  読んだ内容を**ディスクへ解決済みで書き戻す処理は無い**。中間ストアに焼く経路が無いので、
  解決済みの secret や本文がリポジトリ外へ漏れる面が生えない。
- git が監査ログを兼ねる。「いつ誰がどのプロンプトに変えたか」は git history で追う。

### 実効設定の書き出し (dump)

`default` (DM は `dm`) と channel をマージした後、あるチャンネルで**実際に効く設定
(実効設定)** を確認できる `dump` サブコマンドを持つ。マージ規則 (§2.2) を頭の中で
追わずに、結果を目で見られること。

- **対象は channels ブロックだけ**。dump は `resolveChannelConfig` (channels の抽出・
  ロード → default/dm 特定 → merge) を呼び、同じファイルに同居する boot ブロック
  (connector / store / pi / agent) には**触れない** (channels キーだけ取り出し、
  `${env.X}` 解決も行わない)。したがって boot ブロックの `${env.X}` secret が dump
  出力に解決済みで現れる経路は無い (dump は secret を触らない — 漏洩面が構造上存在しない)。
- **解決関数はランタイムと共有する**。dump 専用の別実装を持たず、イベント処理で使う
  `resolveChannelConfig(channelId)` をそのまま呼ぶ。dump と本番で結果がずれないことを保証する。
- **出所 (provenance) を併記する**。各フィールドが `default` / `dm` / channel 由来か
  コード既定 (fallback) かを付記する。「なぜこの model になったのか」がマージ規則を
  再現しなくても分かる。
- 人向けの整形出力と、機械可読な `--json` の両方を出す (`src/config/dump.ts`)。

```
$ node dist/server.mjs dump '#alerts'
channel: #alerts
model:            gemini-3-pro            ← channel
systemPrompt:     (from ./prompts/alerts.md)   ← channel
trigger.when:     OR[ keyword, AND[ classifier(gemini-3.1-flash-lite), classifier(code default) ] ]  ← channel
session.mode:     thread                  ← code default
```

## §7 ユーザーのカスタマイズポイント全体地図

利用者から見た「何をどこでカスタマイズするか」の一覧。§0 の置き場所判断を
利用者視点で裏返したもの。

| カスタマイズしたいこと | 層 | 記述場所 | 形式 |
|---|---|---|---|
| Slack 接続・認証情報 (mode / token / botUserId) | 設定リポジトリ + デプロイ | agent.yaml の connector.slack (値は `${env.X}`。secret は `--set-secrets` で env に) (§6) | YAML |
| 永続化バックエンド (memory / sqlite / firestore) | 設定リポジトリ | agent.yaml の store (§6) | YAML |
| bridge の挙動既定 (provider / turn timeout / agent.runtime。モデルは含まない) | 設定リポジトリ | agent.yaml の agent (§6) | YAML |
| Gate の選択 + 合成 + 設定値 (分類 criteria・classifier モデル) | チャンネル | agent.yaml の channels (trigger.when) | YAML |
| 初期プロンプト・文脈 | チャンネル | agent.yaml の channels + prompts/*.md 参照 | YAML + Markdown |
| pi (agent) の利用モデル | チャンネル | agent.yaml の channels (model: default / channel) | YAML |
| CLI・コマンド追加 / pi-extension | 実行環境 | Dockerfile (FROM base + `pnpm install --prod`, [session-runtime.md](session-runtime.md) §5) | コード (イメージ) |
| skill (全チャンネル共通) | 実行環境 | イメージの pi 既定パス ($AGENT_HOME/.pi/agent/skills)。pi が自動ロード (§3) | コード (イメージ) |
| skill / extension (チャンネル別) | 実行環境 + チャンネル | 自動発見されないパスに焼き、agent.yaml の channels (skills / extensions) で参照 (§2) | コード (イメージ) + YAML |
| ユーザー CLI 用の secret (例: GH_TOKEN) | デプロイ + 設定リポジトリ | 値は `--set-secrets` で env に、pi へ通すのは agent.yaml の `agent.env` に名前を明示列挙 (足し算モデル §5, [session-runtime.md](session-runtime.md) §2) | YAML |

bridge の設定の置き場は CONFIG_PATH が指す agent.yaml (§6)。「service.yaml を bridge の
設定ファイルとして扱う」案も検討したが、それは Cloud Run 固有の整理で、Ingress /
Store と同様に runtime を差し替え可能に保つ方針 ([architecture.md](architecture.md) §1) と衝突するため
やめた。env の役割は secret・環境の同一性・一時的な override に限定し (agent.yaml が
`${env.X}` で拾う source。§6 の表)、挙動の宣言は runtime に依存しない設定リポジトリ側の
YAML に置く。これで「実行環境以外のカスタマイズは YAML で表現できる」が全層で成立する。

「agent の設定 (Gate)」と「チャンネルの設定 (プロンプト)」は概念としては別だが、
格納は同じ ChannelDoc の別フィールド (trigger vs systemPrompt/context/model)。
分ける必要が出るのは Gate 設定をチャンネル横断で共有したくなったときで、初期版では不要。

### trigger と gate の役割分担

- **gate** = 1 つの判定。「mention されたか」「keyword に一致したか」「classifier が
  真と言ったか」のような yes/no を返す最小単位 ([session-model.md](session-model.md) §5)。
  設定ファイルの表面では `kind: mention` / `kind: classifier` … として `trigger.when` の
  葉に現れる (「gate」「gates」という語をキーには出さない — 語より木の構造で表す)。
- **trigger** = そのチャンネルで「いつ起動するか」全体。中身は 2 つ:
  - `when` — gate をどう合成して**起動可否**を決めるか (ブール木、下記)。
  - `debounceSec` (/ 実装保留中の `cooldownSec`) — 合成結果が真でも実際に
    **発火させるかの抑制** (連投のまとめ・連続起動の抑止)。判定そのものではないので
    `when` の木の外、`trigger` 直下に置く。

つまり trigger ⊃ when(gate の合成) + 発火制御。gate は trigger の構成部品で、
trigger = gate ではない。

### trigger.when — Gate の合成木

Gate はこの基盤が提供する type 名 (`kind`) から選び、設定値を添える。読み込み時 (§6) に
type の存在と設定スキーマを strict に検証する。合成は `trigger.when` の**ブール木**で表す:

```
Node = Gate | { and: Node[] } | { or: Node[] }
```

- **配列は OR**。`when: [A, B]` は「A または B」。素直に「どれか当たれば起動」を並べる
  のが最頻ケースなので、無指定 (配列) を OR にする。
- **AND は `{ and: [...] }`** で明示。`{ or: [...] }` も書ける (配列 OR と同義で、意図を
  はっきりさせたいとき用)。
- ネストできる。`combinator` キーワードは持たない — 構造 (配列 / `and` / `or`) だけで
  合成を表し、「1 階層目の combinator が何か」を覚える必要をなくす。
- 否定 (`negate`) は持たない。「〜でない」は classifier の criteria を書き換えて表現する
  (質問の向きを変えればよい)。

```yaml
# 「#alert に一致(RegEx) OR (料理の話題である AND 店の話ではない)」
trigger:
  debounceSec: 60
  when:
    - kind: keyword                        # ─┐ 配列 = OR
      pattern: "#alert"                     #  │
    - and:                                  #  │ ┌ AND
        - kind: classifier                  #  │ │
          criteria: 料理・レシピの話題        #  │ │
          model: gemini-3.1-flash-lite      #  │ │ この classifier の判定モデル (§2.3)
        - kind: classifier                  #  │ │
          criteria: 外食・店の話ではない       #  │ └
```

`when` の各葉 (Gate) が [session-model.md](session-model.md) §5 の 1 判定に対応し、
`and` / `or` / 配列がその合成にあたる。`debounceSec` (/ 実装保留中の `cooldownSec`) は
木の外 (trigger 直下) に置く — これは判定の合成ではなく起動の抑制 (発火制御) なので
(上記「trigger と gate の役割分担」)。

この方式で「**YAML = データ、コード搬入 = イメージのみ**」という安全特性が
明文化される。YAML をどう書いても新しいコードは持ち込めない (criteria/pattern は
データ、Gate 選択は登録済みコードの選択、`skills` / `extensions` はイメージに
焼かれた実体へのパス参照 — §2 のセキュリティ項)。

### 初期版でできないこと (線引き)

| できないこと | 理由 | 回避策 / 将来パス |
|---|---|---|
| custom Gate (利用者コード) | Gate は bridge プロセス内で動くため、pi イメージ拡張では追加できず bridge 本体のコード拡張になる | classifier のプロンプトで表現力を吸収。それでも足りなければ bridge の fork |
| チャンネルごとの CLI の有無・共通能力の除外 | イメージは全チャンネル共通で、`skills` / `extensions` は追加 (additive) のみ (§2) | 抑制はプロンプトで行う。強い分離が要るなら将来の image フィールド (§2 の将来拡張) |
| channels ブロックへの secret 記載 | YAML に平文 secret を置かない方針 (§5) | Secret Manager + `--set-secrets` (値) + agent.yaml の `agent.env` に env 名を明示列挙 ([session-runtime.md](session-runtime.md) §2) |
