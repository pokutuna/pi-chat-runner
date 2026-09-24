# Config

設定を System Config / Channel Config / Agent Config の 3 つに分け、1 つの YAML ファイルに並べる。
[design.md](../design.md) の Config 節に対応する詳細設計。
実行中に変わる状態 (Channel の有効・無効、Thread↔Session 対応、Session の実行状況) は設定ではなく Control State として扱う (§6)。

## 1. 3 分類

| 分類 | 対象 | 読むタイミング | 消費する場所 |
|---|---|---|---|
| System Config | Runner プロセスの構成 (チャット接続、State の保存先、Runtime の実行環境、時間の既定値) | boot 時に 1 回 | composition root (実装選択)、Dispatcher、Runtime |
| Channel Config | Channel 単位のメッセージ処理 (起動条件、Session の区切り、返信方法) + Channel 固有の Agent Config | メッセージごと (再起動不要) | Gate、Dispatcher、Egress |
| Agent Config | Agent の振る舞いと Runtime への引き渡し (プロンプト、モデル、Tool、Skill、Extension、env) | メッセージごと (再起動不要) | Runtime |

Channel Config と Agent Config は「default を Channel ごとに上書きする」形で解決する (§3)。

### 1.1 System Config

| フィールド | 意味 | 消費する場所 |
|---|---|---|
| `chat.slack.mode` | `socket` \| `events`。Ingress 実装の選択 | Ingress ([ingress-egress.md](ingress-egress.md)) |
| `chat.slack.botToken` / `botUserId` | 送信用トークンと自己判定用の bot user ID | Ingress / Egress |
| `chat.slack.socket.appToken` | `mode: socket` で必須 | Ingress |
| `chat.slack.events.signingSecret` / `port` | `mode: events` で必須。既定 port 8080 | Ingress |
| `state.control.backend` | `memory` \| `sqlite` \| `firestore` | Control State ([state.md](state.md)) |
| `state.control.sqlite.path` | SQLite のファイルパス | Control State |
| `state.control.firestore.projectId` / `database` / `rootDoc` | Firestore の接続先。`rootDoc` は偶数セグメントのドキュメントパス | Control State |
| `state.agent.workdirDir` | Workdir の退避先。空なら退避なし | Agent State ([state.md](state.md)) |
| `state.agent.sharedDir` | Channel 単位の Shared の置き場。空なら Shared なし | Agent State |
| `state.agent.sharedWarnBytes` | Shared のサイズ警告閾値 | Agent State |
| `runtime.uid` / `gid` | Agent プロセスを起動する UID/GID。両方指定するか両方省略する | Runtime ([runtime.md](runtime.md)) |
| `runtime.home` | Agent に渡す `HOME`。既定 `/home/agent` | Runtime |
| `runtime.permissionMode` | Node Permission Model の有効化。既定 true | Runtime |
| `runtime.allowAddons` | `--allow-addons` の opt-in。既定 false | Runtime |
| `turnTimeoutMs` | 1 Turn の上限。超過で Agent を kill | Session ([message-dispatch.md](message-dispatch.md)) |
| `progressNoticeIntervalMs` | 長時間 Turn の進捗通知の間隔。0 で無効 | Egress |
| `leaseTtlMs` | Session 実行の lease TTL | Dispatcher |
| `lingerMs` | Turn 終了後に Agent プロセスと lease を保つ時間 | Session |

System Config は全 Channel 共通で、Channel ごとの上書きを持たない。

### 1.2 Channel Config

| フィールド | 意味 | 消費する場所 |
|---|---|---|
| `trigger.when` | Gate の合成木 (§4)。省略時は Channel = mention のみ、DM = 空 (disabled) | Gate |
| `trigger.allowBots` | bot 投稿を Gate 評価へ届ける opt-in。既定 false | Gate |
| `trigger.whileRunning` | 実行中 Session へのメッセージの扱い。`passthrough` (既定) は Gate を省略して steering、`evaluate` は毎回評価する | Gate |
| `session.mode` | `thread` (既定) \| `channel`。Session キーの導出 | Dispatcher |
| `session.affinity.scope` | `session` (既定、合流しない) \| `channel` | Dispatcher |
| `session.affinity.windowSec` | Session 終了後も合流できる秒数。既定 0 (稼働中のみ) | Dispatcher |
| `session.affinity.debounceSec` | 連投を 1 Turn に束ねる遅延 | Dispatcher |
| `session.idleResetMinutes` | 無活動で Transcript を世代交代する分数 | Dispatcher |
| `session.maxTranscriptKb` | Transcript がこのサイズを超えたら世代交代 | Dispatcher |
| `reply.mode` | `thread` (既定) \| `flat`。Channel 直下トリガーへの返信先 | Egress |
| `agent` | この Channel 固有の Agent Config (§1.3 の全フィールド) | Runtime |

`session.mode` / `reply.mode` の DM 既定は `channel` / `flat`。組み合わせの規則は [session-model.md](session-model.md)、affinity / debounce の動作は [message-dispatch.md](message-dispatch.md) を正とする。

### 1.3 Agent Config

| フィールド | 意味 |
|---|---|
| `systemPrompt` | 役割・口調・運用ルール。共通プロンプトへ追記する |
| `context` | 短い参照テキストの配列。初回 Turn の入力先頭に足す |
| `model` | pi の `--model` に渡す shorthand。`provider/model-id[:thinking]` 形式で、`/` を必須とする |
| `tools` | pi の `--tools` allowlist。指定時も reply は常に補う |
| `excludeTools` | pi の `--exclude-tools` denylist。reply を書いても無視する |
| `skills` | 追加ロードする Skill のパス (`--skill`)。自動発見分への additive |
| `extensions` | 追加ロードする Extension のファイルパス (`--extension`)。additive |
| `memory` | 組み込み memory skill の配線。Shared 有効時の既定 true、false で opt-out |
| `env` | Agent プロセスへ渡す env の名前=値マップ (足し算モデル)。値に `${env.X}` を書ける唯一の Agent Config フィールド (§2.1) |
| `sandbox` | Agent を srt (sandbox-runtime) で包むルール ([runtime.md](runtime.md) §5.5)。トップレベルでは `false` / srt ネイティブ形式のファイルパス / srt の設定をそのままインラインで書いたもの、省略で無効。Channel 側は配列に要素を足すだけ (§3.2)。provider の到達先も含め、network に何を許すかは全部このルールに書く |

すべて Runtime が消費する ([runtime.md](runtime.md))。`model` の provider prefix は必須で、bare id は pi 側の fuzzy match で provider が非決定になるため schema で弾く。認証は pi に委譲し、API キー系 provider は `env` に env 名を列挙して渡す。google-vertex だけは Runtime が ADC marker を付ける。

Skill / CLI / Extension の実体はコンテナイメージに含め、Agent Config はそのパスを参照するだけにする。YAML から新しいコードを持ち込む経路は作らない。

## 2. YAML の形

`CONFIG_PATH` が指す 1 つの YAML に `system` / `agent` / `channels` の 3 ブロックを並べる。

```yaml
# --- system: Runner プロセスの構成 (boot 時に 1 回読む) ---
system:
  chat:
    slack:
      mode: ${env.SLACK_MODE:-socket}          # socket | events
      botToken: ${env.SLACK_BOT_TOKEN}
      botUserId: ${env.SLACK_BOT_USER_ID}
      socket:
        appToken: ${env.SLACK_APP_TOKEN:-}     # mode: socket で必須
      events:
        signingSecret: ${env.SLACK_SIGNING_SECRET:-}
        port: ${env.PORT:-8080}
  state:
    control:
      backend: ${env.CONTROL_STATE_BACKEND:-memory}    # memory | sqlite | firestore
      sqlite:
        path: ${env.SQLITE_PATH:-/tmp/pi-chat-runner/state.db}
      firestore:
        projectId: ${env.FIRESTORE_PROJECT_ID:-}
        database: ${env.FIRESTORE_DATABASE:-(default)}
        rootDoc: ${env.FIRESTORE_ROOT_DOC:-pi-chat-runner/default}
    agent:
      workdirDir: ${env.WORKDIR_ARCHIVE_DIR:-} # 空なら Workdir の退避なし
      sharedDir: ${env.SHARED_DIR:-}           # 空なら Shared なし
      sharedWarnBytes: ${env.SHARED_WARN_BYTES:-}
  runtime:
    uid: ${env.PI_AGENT_UID:-}
    gid: ${env.PI_AGENT_GID:-}
    home: ${env.PI_AGENT_HOME:-/home/agent}
    permissionMode: ${env.PI_PERMISSION_MODE:-true}
    allowAddons: ${env.PI_ALLOW_ADDONS:-false}
  turnTimeoutMs: ${env.TURN_TIMEOUT_MS:-600000}
  progressNoticeIntervalMs: ${env.PROGRESS_NOTICE_INTERVAL_MS:-30000}
  leaseTtlMs: ${env.LEASE_TTL_MS:-60000}
  lingerMs: ${env.LINGER_MS:-20000}

# --- agent: 全 Channel 共通の Agent Config (default) ---
agent:
  model: google-vertex/gemini-3.5-flash
  systemPrompt: ./prompts/ask-ai.md            # ./ 始まりはファイル参照 (§3)
  env:
    GH_TOKEN: ${env.GH_TOKEN:-}                # Agent へ渡す env の名前=値 (§2.1)
  sandbox: ./sandbox/vertex.json               # srt のルール (§3.2)。省略で無効

# --- channels: Channel ごとの設定 (メッセージごとに読み直す) ---
channels:
  - channel: default                           # 必須の予約エントリ
    trigger:
      when:
        - kind: mention

  - channel: dm                                # DM の土台。無ければ DM は disabled
    trigger:
      when: []                                 # 明示的に disabled

  - channel: C0000000001
    trigger:
      when:
        - kind: keyword
          pattern: "(ALERT|ERROR|CRIT)"
        - and:
            - kind: sender
              is: bot
            - kind: classifier
              criteria: インフラのアラートや障害報告と思われる発言
              model: gemini-3.1-flash-lite
      allowBots: true
      whileRunning: passthrough
    session:
      affinity:
        scope: channel
        windowSec: 600
        debounceSec: 15
    reply:
      mode: thread
    agent:                                     # この Channel 固有の Agent Config
      model: google-vertex/gemini-3-pro
      systemPrompt: ./prompts/alerts.md
      skills:
        - /app/skills/gc-logging
      sandbox:                                 # Channel 側は配列に足すだけ (§3.2)
        network:
          allowedDomains: [api.github.com]
```

### 2.1 ブロックごとの読み方

3 ブロックは 1 つのファイルに同居するが、それぞれ独立にロードして検証する。全体を 1 つの zod スキーマに統合はしない。

| | `system` | `agent` / `channels` |
|---|---|---|
| 読むタイミング | boot 時に 1 回。反映は再起動 | メッセージごと (再起動不要) |
| `${env.X}` | 解決する | 解決しない (例外: `agent.env` の値。§2.1 末尾) |
| 検証 | strict。未知キー・未解決の env 参照は fail-loud | strict。同上 |

`${env.X}` を `system` ブロック内だけで解決するのは、`agent` / `channels` を secret-free に保つため。この 2 ブロックが env に触れないことが、`dump` (§5) が secret を解決した値を出さないことの根拠になる。secret は値を直書きせず、`${env.X}` で env (Secret Manager 由来) を拾う。

唯一の例外が `agent.env` で、ここは Agent プロセスへ渡す env の値そのものを書く場所なので `${env.X}` を解決する。解決はファイルをロードするたびに行い、Channel ごとの上書きは名前の追加・置換だけを扱う。`dump` はこのフィールドの値を解決せず、書かれたままの参照文字列を表示する。

### 2.2 `${env.X}` 参照

- `${env.NAME}` — NAME が未設定なら fail-loud で throw する (空文字は「設定された」扱い)。
- `${env.NAME:-default}` — 未設定または空文字なら default を使う (シェルの `${VAR:-default}` と同じ)。
- 解決順は `yaml.parse` → `resolveEnvRefs(parsed, env)` → zod の 3 段。env 参照は常に string を返し、number / boolean への変換は zod 側に委ねる。
- YAML テキストではなく parse 済みオブジェクトを再帰走査して string 値の中だけを置換するため、YAML 構造やコメントを壊さず、エラーで参照フィールドのパスを示せる。

### 2.3 env の優先順位

`system` の一部フィールドは env からも直接上書きできる。優先順位は **env > YAML > コード既定**。

| env | 対応フィールド |
|---|---|
| `TURN_TIMEOUT_MS` | `system.turnTimeoutMs` |
| `PROGRESS_NOTICE_INTERVAL_MS` | `system.progressNoticeIntervalMs` |
| `PI_AGENT_UID` / `PI_AGENT_GID` | `system.runtime.uid` / `gid` (片方だけの設定は fail-loud。空文字は未設定と同じ。コンテナイメージは既定で `1001`) |
| `PI_AGENT_HOME` | `system.runtime.home` |
| `PI_PERMISSION_MODE` / `PI_ALLOW_ADDONS` | `system.runtime.permissionMode` / `allowAddons` |

この経路は `${env.X}` 参照とは別のロジックなので二重に効きうる。運用では YAML 側を `${env.X:-default}` に一本化し、env 直接上書きはローカルでの一時的な変更に限る。

YAML を介さずプロセス環境から直接読む env は以下に限る。

| env | 用途 |
|---|---|
| `CONFIG_PATH` | 設定ファイルのパス。未設定なら `examples/config/agent.yaml` |
| `LOG_LEVEL` | ログレベル |
| `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` / `GOOGLE_APPLICATION_CREDENTIALS` | ADC と classifier の解決 |
| `METADATA_SERVER_DETECTION` | metadata server 検出の抑止 |

## 3. ファイルのロードと Channel の解決

Channel Config と Agent Config は、リポジトリに置いた YAML を実行時にそのまま直読みする (`FileConfigSource`)。書く場所と読む場所が同じ 1 ファイルで、中間ストアも焼き込みステップも挟まない。実装は 1 つだけで、本番もローカルも同じローダーを使う。

```typescript
interface ConfigSource {
  channel(id: string): Promise<ResolvedChannel | null>;
}
interface ResolvedChannel {
  trigger?: Trigger;
  session?: SessionConfig;
  reply?: ReplyConfig;
  agent: AgentConfig;
}
```

### 3.1 予約エントリと土台の選択

- `channels` は配列で、`channel: default` エントリを必須とする。スキーマ検証で存在を強制する。
- 通常の Channel は `default` を土台に、その Channel ID のエントリを重ねる。固有エントリが無い Channel は `default` 単独で動く。
- `dm` は予約エントリで、**DM は `dm` のみを土台にし `default` を継承しない**。1:1 の DM で mention という操作が意味を持たず、`default` の trigger (多くは mention) をそのまま適用できないため。
- `dm` エントリが無ければ **DM は disabled** (`when: []` と同じ vacuously false)。DM を使うには `dm` エントリで `trigger.when` を明示する。
- DM のセッションは実 channelId (`D...`) で管理し、予約名は Config の解決にのみ使う。
- 未登録の Channel から一切起動しない運用にしたい場合は `default.trigger.when: []` を書き、許可する Channel だけ固有エントリで上書きする。

### 3.2 マージ規則

Channel 部分と Agent 部分を別々にマージする。どちらも規則は 1 つだけ。

> 上書き側に書いたトップレベルフィールド = その値。書かないフィールド = 土台の値。

deep merge は一切しない。`session` や `reply` の内側キー、`trigger.when` の木、`context` などの配列も、すべてフィールド単位で丸ごと置換する。

| 部分 | 段 |
|---|---|
| Channel (`trigger` / `session` / `reply`) | `channels[default]` → `channels[id]` の 2 段 |
| Agent | `agent` (default) → `channels[default].agent` → `channels[id].agent` の 3 段 |

`session.mode` だけ変えたいときも `session` を丸ごと書くことになるが、「Channel エントリだけ読めば実際に効く値がそこにある」を成り立たせる方を取る。合成結果は `dump` (§5) で確認できる。

マージ対象のフィールド一覧は型から網羅を強制する (`Record<keyof AgentConfig, true>` を書かせる) ため、フィールドを足してマージから漏れることがない。

**`sandbox` だけは配列への追加**。トップレベル `agent.sandbox` に srt の設定そのもの (srt ネイティブ形式で、network / filesystem / credentials をすべて持つ。ファイル参照はロード時にインライン化、§3.5) を書き、`channels[].agent.sandbox` にはその配列へ足す要素だけを書く。丸ごと置換だと Channel ごとに provider の到達先まで書き直すことになり、Channel の 1 行が sandbox 全体を弱める経路になるため。想定する変更 (ドメインの追加、読み書き先の追加、Channel 限定で env を隠す) は全部 union で足りるので、削除・置換・スカラの上書きは持たない。

| 追加できる配列 | |
|---|---|
| `network.allowedDomains` / `network.deniedDomains` | 末尾に追加、重複は 1 つに |
| `filesystem.allowRead` / `allowWrite` / `denyRead` / `denyWrite` | 同上 |
| `credentials.envVars` / `credentials.files` | `name` / `path` で同一視。同じキーで内容が違えば error |

これ以外のキー (`strictAllowlist` や `filesystem.disabled` 等のスカラ) は Channel 側では strict に弾く。`channels[].agent.sandbox: false` は「この Channel は sandbox なし」で、これだけは置換。トップレベルが無効 (省略か `false`) のまま Channel が追加を書くのは error にする — 足す土台が無いのに書かれたルールは、書いた人の意図 (この Channel を守りたい) と実際 (何も守られない) が食い違うため。合成後の設定は srt の schema で再検証し、`dump` (§5) に出す。`enableWeakerNestedSandbox` / `enableWeakerNetworkIsolation` / `filesystem.disabled` はエラーも警告も出ないまま sandbox を弱めるので、どの段でもロード時に error。

### 3.3 provenance

マージと同時に、各フィールドがどのエントリ由来かを記録する。`default` / `channel` / `dm` / `default agent` / `channel agent` の 5 ラベルで、どの段からも値が来なかったフィールドは記録しない (読む側でコード既定に落ちる)。`dump` (§5) がこれを表示する。

### 3.4 キャッシュと再読み込み

`FileConfigSource` は mtime ベースでキャッシュする。`stat` して前回と mtime が変わっていなければ parse 済みの結果を再利用し、変わっていれば読み直す。file watch は使わない。これで「YAML を編集すれば再起動なしで挙動が変わる」が成立する。`stat` に失敗した場合はキャッシュを使わずロードに進み、ファイル不在のエラーメッセージ (fail-loud) をそのまま出す。

### 3.5 ファイル参照とパスの絶対化

相対パスの起点は常に設定ファイルのあるディレクトリで、マージ後の結果に対して一括で適用する。

| フィールド | 扱い |
|---|---|
| `systemPrompt` / `context` | `./` `../` 始まりならファイルを読んでインライン化する。読めなければ fail-loud |
| `skills` / `extensions` | 内容は読まず、絶対パス化だけする。裸の相対パス (`skills/foo`) は基準が曖昧なので schema で拒否する |
| `sandbox` (トップレベル `agent` のみ) | パスならファイル (JSON / YAML、srt ネイティブ形式) を読んで正規化・検証し、ルールをインライン化する。読めない・不正なら fail-loud。パスの規則は `skills` と同じ |

インライン化した結果をディスクへ書き戻す処理は持たない。インライン化後の値が実行時スキーマの形を守っていることを、もう一度 strict 検証で確かめる。

## 4. Gate の合成規則

`trigger.when` は Gate のブール木で、Gate はこの基盤が提供する `kind` から選んで設定値を添える。

```
Node = Gate | { and: Node[] } | { or: Node[] }
```

- **配列は OR**。`when: [A, B]` は「A または B」。「どれか当たれば起動」が最頻ケースなので無指定を OR にする。
- **AND は `{ and: [...] }`** で明示する。`{ or: [...] }` も書ける (配列 OR と同義で、意図を明示したいとき用)。
- ネストできる。`combinator` キーワードは持たない — 構造だけで合成を表す。
- **否定 (`negate`) を持たない**。「〜でない」は classifier の criteria を書き換えて表現する。この方針のため sender の `id` / `name` も allowlist 専用になる。
- **空の AND は true** (単位元)、**空の OR は false** (vacuously false)。トップレベルの `when: []` は OR[] なので起動しない。
- 評価は短絡する。判定理由には `OR[...]` / `AND[...]` の簡易表記で、発火を決めた葉の gate 名と理由を含める。

既定の `when` は、`trigger` を書いていない Channel では mention のみ、DM では空配列 (= disabled)。

### 4.1 Gate の種別

| kind | 必須項目 | 判定 |
|---|---|---|
| `mention` | なし | 自分への mention を含むか |
| `keyword` | `pattern` | 正規表現がテキストに一致するか |
| `classifier` | `criteria` (`model` は任意) | criteria と本文を LLM に渡して判定。呼び出しには 10 秒のタイムアウトがあり、**タイムアウトを含む呼び出し失敗は fail-closed** (起動しない) |
| `passthrough` | なし | 常に true |
| `reaction` | `emoji` (非空配列) | reaction イベントで、付与 (removed でない) かつ emoji が一覧にあるか |
| `sender` | `is` / `id` / `name` の少なくとも 1 つ | 送信者による判定 (§4.2) |

message 以外のイベントに対して mention / keyword / classifier は false、reaction 以外に対して reaction は false を返す。

classifier の `model` はそのノードに添える。pi 本体のモデル (Agent Config の `model`) とは別機構で、階層を辿らずに出所が分かるよう「pi 本体 = `agent.model`」「classifier = そのノードの `model`」の 2 箇所で完結させる。

### 4.2 `kind: sender`

`is` (送信者種別) / `id` (ユーザ ID の allowlist) / `name` (表示名の allowlist) の 3 軸を持ち、複数書けば AND。キー名は判定対象の `Sender` のフィールドに 1:1 で対応する。

- `id` は `Sender.id` との完全一致。改名の影響を受けない安定した指定。
- `name` は Ingress が正規化した `Sender.displayName` との完全一致。Gate 自体はプラットフォーム中立な文字列比較で、何が名前かは Ingress が決める。`id` と相互マッチはしない。
- **表示名を解決できなかった送信者は fail-closed** (起動しない)。
- 表示名はユーザが変更できるため、改名すると静かに一致しなくなる。厳格な同一性が要る用途は `id` で書く。これは起動条件であって認可境界ではない (認可は `allowBots` / DM 既定 disabled / Channel の選択の側にある)。

### 4.3 `trigger.allowBots`

既定 false。bot の投稿 (自己エコーは Ingress が除外済み) は `allowBots: true` の Channel でのみ Gate 評価と steering に乗る。`kind: sender` と組み合わせると「人間は mention のみ、bot はキーワードで自動起動」のような書き分けができる。

```yaml
trigger:
  allowBots: true
  when:
    - and: [{ kind: sender, is: human }, { kind: mention }]
    - and: [{ kind: sender, is: bot }, { kind: keyword, pattern: "ALERT|CRITICAL" }]
```

`/new` 等のテキストコマンドは `allowBots: true` でも bot 送信者では発動しない。reaction gate は付与した送信者 (通常は人間) で判定するため `allowBots` の影響を受けない。

### 4.4 `trigger.whileRunning`

実行中 Session に届いたメッセージの扱いを決める。`passthrough` (既定) は Gate を省略して steering へ渡す。`evaluate` は実行中でも毎回 `when` を評価し、通らなければ捨てる。詳細は [message-dispatch.md](message-dispatch.md)。

### 4.5 検証の二段構え

Gate の種別ごとの必須項目は、まず schema の refinement で strict に検証する。その後、木を評価可能な Gate インスタンスへ組み立てる段でも同じ条件を再検査し、欠落していれば schema 通過後のバグとして fail-loud で throw する。黙って無視すると起動判定が静かに変わってしまうため。`classifier` は ClassifierClient が注入されていなければ組み立て時に throw する。

## 5. 実効設定の書き出し (dump)

マージ規則 (§3.2) を頭の中で追わずに、ある Channel で実際に効く設定を確認できる `dump` サブコマンドを持つ。

```
$ node dist/server.mjs dump C0000000001
channel: C0000000001

[channel]
trigger.when:               OR[ keyword, AND[ sender(is=bot), classifier(gemini-3.1-flash-lite) ] ]  ← channel
trigger.allowBots:          true                          ← channel
trigger.whileRunning:       passthrough                   ← code default
session.mode:               thread                        ← code default
session.affinity.scope:     channel                       ← channel
reply.mode:                 thread                        ← code default

[agent]
model:                      google-vertex/gemini-3-pro    ← channel agent
systemPrompt:               (from ./prompts/alerts.md)    ← channel agent
skills:                     [/app/skills/gc-logging]      ← channel agent
memory:                     true                          ← code default
```

- **対象は `agent` / `channels` ブロックだけ**。`system` には触れず、`${env.X}` も解決しないため、secret が解決済みで出力に現れる経路が構造上存在しない。
- **解決関数はランタイムと共有する**。dump 専用の実装を持たず、メッセージ処理で使う解決をそのまま呼ぶことで、dump と本番で結果がずれないことを保証する。
- **出力は Channel Config / Agent Config の 2 セクション**に分ける。
- **provenance ラベル**は `default` / `channel` / `dm` / `default agent` / `channel agent` の 5 つ。どの段からも値が来なかったフィールドは `code default` と表示する。
- `--json` で機械可読な形も出す。JSON では未設定フィールドの値を `null` にし、`source` に `code default` を添える (`null` は「設定されていない」であって「null という値」ではない)。
- DM で `dm` エントリが無い場合は、マージ結果を持たずコード既定 (disabled) に落ちる旨を注記する。

## 6. Control State との境界

以下は実行中に変わる状態であり、Config には置かない。詳細は [state.md](state.md)。

| 状態 | 変更の手段 |
|---|---|
| Channel の有効・無効 | チャットからの `/enable` `/disable` |
| Thread と Session の対応 | Dispatcher が affinity の解決時に記録する |
| Session の実行状況 | Session の起動・終了に伴い Dispatcher と Session が更新する |

Config は「静的な宣言」、Control State は「実行中に変わる事実」という線引きにする。したがって YAML を書き換えても実行中の Session の有効・無効は変わらず、`/disable` した Channel は YAML の `trigger.when` に関わらずメッセージを捨てる。

## 7. 実装対応

現行実装との対応表。YAML のトップレベルは本文どおり `system` / `agent` / `channels` の 3 ブロックで、それぞれ独立に読む。

| 設計上の名前 | 現行の実装 |
|---|---|
| System Config | `src/config/system-config.ts` (`SystemConfigSchema`, `loadSystemConfig`, `resolveSystemConfig`)。YAML では `system` ブロック |
| System Config (chat) | `system.chat.slack` (`SlackChatConfig`) |
| System Config (state) | `system.state.control` (backend + sqlite/firestore) と `system.state.agent` (`workdirDir` / `sharedDir` / `sharedWarnBytes`) |
| System Config (runtime, 時間) | `system.runtime` (`ResolvedRuntimeConfig`) と `system.{turnTimeoutMs,progressNoticeIntervalMs,leaseTtlMs,lingerMs}` |
| Agent Config | `src/config/agent-config.ts` (`AgentConfigSchema`)。YAML ではトップレベル `agent` ブロックと `channels[].agent` の両方に同じスキーマが使われる |
| Channel Config | `src/config/channel-config.ts` (`ChannelConfigSchema`, `ChannelEntrySchema`, `ChannelsFileSchema`) |
| Agent Config の `env` | `AgentConfigSchema` の `env` (`agent.env` / `channels[].agent.env`)。`${env.X}` を解決する唯一の Agent Config フィールド |
| Agent Config の `sandbox` | `src/config/sandbox-config.ts` (`SandboxRulesSchema` / `SandboxAdditionsSchema` / `mergeSandboxAdditions` / `loadSandboxRuleFile`)。Channel 側の形は `src/config/channel-config.ts` (`ChannelAgentConfigSchema`)、Channel が足す要素の union は `mergeSandboxLayer` (`src/config/config-source.ts`) |
| ファイルのロードと Channel の解決 | `src/config/config-source.ts` (`ConfigSource`, `ResolvedChannel`, `FileConfigSource`, `loadChannelConfigFile`, `resolveChannelConfig`, `mergeChannelPart`, `mergeAgentConfig`) |
| ブロックごとの独立ロード | `src/config/root-config.ts` (`readRootConfig`) |
| `${env.X}` 参照 | `src/config/env-ref.ts` (`resolveEnvRefs`) |
| dump | `src/config/dump.ts` (`formatEffectiveConfig`)、CLI は `src/server.ts` |
| Gate の合成と評価 | `src/gate/gate.ts` (`defaultWhen`, `buildWhen`, `evaluateWhen`, `createGate`)、各 Gate は `src/gate/gates/` |
| Gate 評価の呼び出し | `src/gate/evaluate.ts` (`GateEvaluator.admit` / `#resolveWhen`) |
| Channel Config の既定値解決 | `src/dispatch/policy.ts` (`resolveSessionPolicy`) |
