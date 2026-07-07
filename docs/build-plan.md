# 実装順序プラン — 動作確認しながら初期版まで

[design/architecture.md](design/architecture.md) §8 の実装順序を、動かして確認できる単位に展開したもの。
各ステップは「前のステップが動いたまま次を足す」構成で、
スコープは [initial-scope.md](initial-scope.md) の決定に従う。

## 技術スタック

| 領域 | 選定 | 理由 |
|---|---|---|
| ランタイム | Node 26 | base image (node:26-slim) と一致。pi も Node |
| 言語 | TypeScript (最新安定版) | strict 設定。tsconfig は tsdown/Vitest と共有 |
| HTTP | Hono | Events API エンドポイント + health check。軽量・TS ファースト |
| Slack | @slack/web-api + @slack/socket-mode | Bolt は使わない — EventSource / IngressAdapter 抽象を自前で持つ設計 ([design/architecture.md](design/architecture.md) §1) と Bolt のリスナー層が二重になる。薄い SDK を素材として使い、署名検証は自前実装 |
| dev 実行 | tsx | watch 起動 |
| ビルド | tsdown | npm 配布 (Runner + CLI) の dist/ 生成。reply extension は pi が `--extension` で TS を直接ロードするためビルド対象外 (ソースのまま同梱) |
| テスト | Vitest | Firestore エミュレータ (compose, Step 4) と組み合わせる |
| スキーマ検証 | zod | channels/*.yaml の apply 時 strict 検証 ([design/config.md](design/config.md) §6) と ChannelDoc 型を単一ソース化 |
| YAML | yaml | |
| GCP | @google-cloud/firestore | GCS は FUSE 経由なので SDK 不要 (status CLI で必要になったら @google-cloud/storage) |
| lint/format | Biome | 単一ツールで高速 |
| パッケージ管理 | pnpm | 単一パッケージ。モノレポ化が必要になっても workspace 移行が容易 |

## Step 0: リポジトリ scaffold

作るもの: TypeScript プロジェクト設定、後述のディレクトリ骨格、CI (lint + test)。

- [ ] `npm run build` / `npm test` が通る

## Step 1: Slack App での疎通 (Socket Mode)

作るもの: Slack App (manifest)、`SocketEventSource`、`IngressAdapter` の最小 codec、
WebClient での投稿。Gate も pi も無し — mention に固定文字列を返すだけ。

- [ ] mention → スレッドに固定返信が付く
- [ ] トリガーメッセージに 👀 リアクションが付く
- [ ] mention 以外のメッセージには反応しない

## Step 2: pi 単体の起動を試す (Slack なし)

作るもの: `SessionRuntime` の spawn 部分 ([design/session-runtime.md](design/session-runtime.md) §1-2)、reply extension、
RPC イベント (stdout) の購読。ターミナルから叩く使い捨てスクリプトで駆動する。

- [ ] prompt 投入 → `tool_execution_end` で reply の引数が host に届く
- [ ] reply が 1 ターンに複数回呼ばれるケースを観測できる
- [ ] 実行中に steer を stdin へ書く → 次のステップ境界で反映される
- [ ] `--session` の JSONL を指定して再 spawn → 文脈が継続する
- [ ] pi の bash で `env` → allowlist 以外が見えない

## Step 3: 一気通貫 (ローカル・インメモリ)

作るもの: Gate registry (mention / keyword / passthrough + any/all)、
`ConfigSource(File)` で channels/*.yaml 直読み、thread_key → thread_ts の Map、
formatter フック (identity)、inbox はメモリ実装。**ここで「ローカルで動く
#ask-ai」が完成する** ([design/architecture.md](design/architecture.md) §8 の中間ゴール)。

- [ ] mention → Gate 通過 → pi 起動 → reply がスレッドに付く
- [ ] スレッド内の追いメッセージが実行中の pi に steer される
- [ ] keyword Gate のチャンネルで発火/非発火が YAML どおり
- [ ] reply を呼ばず終わるケースで沈黙し、✅ だけ付く
- [ ] YAML 編集 → 再起動なしで挙動が変わる (File watch は任意)

## Step 4: 永続化と排他 (Store/Storage 抽象)

作るもの: `InboxStore` (drain/ack 分離) / `SessionStore` / `LeaseStore` の
インタフェースと 3 実装 (InMemory / SQLite / Firestore)、runner への lease + linger
組み込み、`WorkdirStorage` (restore/flush、実装はファイルコピー 1 つ)、
develop/compose.yaml (Firestore エミュレータ)。設計は [design/persistence.md](design/persistence.md)。

実装選択は env (`STORE_BACKEND=memory|sqlite|firestore`、`WORKDIR_ARCHIVE_DIR`)。
ローカル開発の既定は InMemory で、エミュレータ無しで動く。永続化・排他込みの
確認は SQLite で行い、Firestore 実装は **docker compose のエミュレータ**に対する
コントラクトテストで検証する (SDK は `FIRESTORE_EMULATOR_HOST` が立っていれば
自動でそちらへ接続するため、store 実装にエミュレータ用の分岐は要らない。
ローカルで未起動ならテストは skip)。

- [ ] 3 実装が共通コントラクトテスト (dedupe / drain-ack / lease 排他・期限切れ) を通る
- [ ] `docker compose up` → Firestore 実装のコントラクトテストがエミュレータで通る
- [ ] SQLite: プロセス kill → 再起動 → 同スレッドの会話が再開する
- [ ] 2 プロセス同時起動で lease が排他し、負けた側は inbox 投入のみ
- [ ] 同じ event_id の再送が二重処理されない
- [ ] kick 失敗後に同じ入力で再 kick できる (ack しない限り inbox に残る)
- [ ] agent_end 直後の追いメッセージが linger で拾われ、同一セッションで処理される
- [ ] flush 前クラッシュ → 再起動後に同じ入力から再実行される (at-least-once)
- [ ] `WORKDIR_ARCHIVE_DIR` 指定で restore/flush が働き、workdir 削除後も文脈が戻る

## Step 5: Cloud Run デプロイ (Events API)

作るもの: `HttpEventSource` (署名検証 + 3s ACK)、service.yaml
(secretKeyRef / env / GCS FUSE マウント)、Dockerfile での base image ビルド。

- [x] 本番 Slack の mention に応答する
- [x] min-instances=0 からのコールドスタートで取りこぼさない
- [x] インスタンスを跨いだスレッド再開 (デプロイし直して継続)
- [x] linger 中の追いメッセージが同一 workdir で処理される

## Step 6: 仕上げ (初期版ゴール)

作るもの: UID 分離 + FUSE dir-mode ([design/session-runtime.md](design/session-runtime.md) §6)、agent.yaml + `envPassthrough` ([design/config.md](design/config.md) §6, [design/session-runtime.md](design/session-runtime.md) §2)、
turn timeout (10 分) + エラー投稿 + ❌、DM 既定 config (`dm`)、
CLI (`apply` / `status` / `init`)、base image の公開。

- [x] UID 分離: `PI_AGENT_UID`/`PI_AGENT_GID` (両方セットで有効) で pi を別 uid/gid で spawn し、workdir を chown/chmod 0700 する ([src/session/runner.ts](../src/session/runner.ts) の agentUid/chownRecursive)
- [ ] pi の bash から /data が読めない・Runner の environ が読めない (実行環境での検証。UID 分離の実装自体は上記の通り済み)
- [x] timeout 超過 → kill → ❌ + エラー投稿、再依頼で復帰 (`turnTimeoutMs`、既定 10 分)
- [x] DM で passthrough 起動する (予約名 `dm` の doc が無ければ既定 passthrough)
- [x] agent.yaml + `envPassthrough` (bridge 予約 prefix の拒否込み)
- [ ] `apply` → ChannelDoc 反映 → 次イベントから挙動が変わる (CLI 未実装。`src/cli/` はディレクトリのみ)
- [ ] `status` で sessions 一覧と transcript dump が見える (CLI 未実装)
- [ ] `init` の scaffold から利用者の拡張イメージがビルドできる (CLI 未実装)

## 実装済みの追加機能 (計画時に無かった、または前倒しで入ったもの)

- [x] session/reply の 2 軸 (`session.mode` / `reply.mode`) と、channel モードの
  idle/size 世代交代 (transcript rotation) ([design/session-model.md](design/session-model.md) §3)
- [x] イベント駆動の push 配達 (実行中セッションへの steer を新規イベント受信時に即時実行。
  「ターン境界ポーリング」ではない。[design/session-runtime.md](design/session-runtime.md) §4)
- [x] `extensions/permission-gate.ts` (bash tool の denylist: パッケージ管理・破壊的操作・
  chmod/chown・PID 1 kill をブロックする事故防止層。[design/session-runtime.md](design/session-runtime.md) §6)
- [x] `trigger.debounceSec` (kick 遅延方式: 連投バーストを 1 ターンに束ねる。スライディング +
  hard cap ×3、mention は即 kick。[design/session-model.md](design/session-model.md) §5。
  `trigger.cooldownSec` は未実装で、設定されると warn して無視される)

## 未着手 (将来。design にあるが計画に現れていない項目)

- [ ] classifier Gate / cooldown Gate ([design/session-model.md](design/session-model.md) §5)
- [ ] resume_pending を伴う再開設計・鮮度窓・再開ループ遮断 ([design/session-model.md](design/session-model.md) §6)
- [ ] SessionEntry (エントリ列) 台帳・artifact / outcome エントリ ([design/session-model.md](design/session-model.md) §2, §7, §8)
- [ ] リアクションによる再開 (`targetIsOwnMessage` からの逆引き。[design/chat-model.md](design/chat-model.md) §2.3)
- [ ] EgressAdapter / MessageChunker (長文分割) / InboundDebouncer ([design/chat-model.md](design/chat-model.md) §3.2, §3.4)

## 想定ディレクトリツリー (新規リポジトリ)

```
<repo>/
├── package.json            # npm パッケージ (Runner + CLI)
├── Dockerfile              # base image ([design/session-runtime.md](design/session-runtime.md) §5)
├── src/
│   ├── server.ts           # エントリポイント (EventSource 起動 + HTTP)
│   ├── ingress/
│   │   ├── chat-event.ts   # InboundMessage 等、プラットフォーム中立のイベント型
│   │   ├── event-source.ts # EventSource IF + Ack IF (プラットフォーム中立)
│   │   ├── user-resolver.ts# UserResolver IF + enrichEvent (プラットフォーム中立)
│   │   └── slack/          # adapter.ts / http-event-source.ts /
│   │                       # socket-event-source.ts / user-resolver.ts (Slack 実装)
│   ├── gate/
│   │   ├── gate.ts         # Gate IF + registry + any/all
│   │   └── gates/          # mention.ts / keyword.ts / passthrough.ts
│   ├── config/             # agent-config.ts / channel-doc.ts / config-source.ts
│   ├── session/
│   │   ├── runner.ts       # lease → drain → kick のオーケストレーション
│   │   ├── runtime.ts      # SessionRuntime: pi の spawn / RPC / timeout (pi 専用実装)
│   │   ├── rpc.ts          # stdin/stdout JSONL のプロトコル層
│   │   └── pi-events.ts    # pi のイベント型 (ドメイン層)
│   ├── store/
│   │   ├── workdir.ts      # WorkdirStorage IF + Copy(退避) / Noop(退避なし) 実装
│   │   └── state/
│   │       ├── interfaces.ts # InboxStore / SessionStore / LeaseStore / StateStore IF
│   │       ├── inbox-item.ts # inboxItemId
│   │       └── backends/      # firestore.ts / sqlite.ts / memory.ts
│   ├── reply/
│   │   ├── router.ts       # thread_key → thread_ts、投稿、formatter フック
│   │   └── reactions.ts    # 👀 / ✅ / ❌
│   └── cli/                # 未実装 (apply.ts / status.ts / init.ts 予定)
├── extensions/
│   └── reply.ts            # pi extension (イメージの /app/extensions/ へ)
├── skills/                 # サンプル skill (イメージの /app/skills/ へ)
├── examples/
│   ├── service.yaml        # Cloud Run 定義の雛形 (secretKeyRef / env、要編集)
│   ├── slack-app-manifest.socket.yaml # Slack App 作成用 manifest、Socket Mode 版 (要編集)
│   ├── slack-app-manifest.http.yaml   # Slack App 作成用 manifest、Events API 版 (要編集)
│   └── config/
│       ├── channels/       # ask-ai.yaml / dm.yaml
│       └── prompts/        # *.md
├── develop/                # このリポジトリ自身のローカル動作確認用ツール
│   ├── compose.yaml        # Firestore エミュレータ (開発・テスト用)
│   └── drive-pi.ts         # pi 単体駆動スクリプト (Step 2 検証用)
└── test/
```

ステップとの対応: Step 1 = ingress + reply の骨格、Step 2 = session/runtime +
extensions/、Step 3 = gate + config-source(File) + examples/、Step 4 = store +
workdir、Step 5 = Dockerfile + service.yaml、Step 6 = cli + 隔離まわり。
