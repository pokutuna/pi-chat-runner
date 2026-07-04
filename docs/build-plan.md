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

## Step 4: 永続化と排他 (Firestore + GCS)

作るもの: inbox / sessions / lease の Firestore 実装 ([design/session-model.md](design/session-model.md) §4)、
dedupe (doc ID = event_id の create())、workdir の restore / flush ([design/session-runtime.md](design/session-runtime.md) §3)、
compose.yaml (Firestore エミュレータ)。
ローカルでは /data の代わりに普通のディレクトリで確認してよい。

Firestore は本物でなく **docker compose のエミュレータ**に対して開発・テストする。
SDK は `FIRESTORE_EMULATOR_HOST` が立っていれば自動でそちらへ接続するため、
store 実装にエミュレータ用の分岐は要らない。lease の txn 競合や dedupe の
create() 衝突といった並行系テストも、実プロジェクト不要・課金ゼロで回せる。

- [ ] `docker compose up` → `FIRESTORE_EMULATOR_HOST` 指定で store のテストが通る
- [ ] lease 排他・dedupe の並行系テストがエミュレータ上で再現する
- [ ] プロセス kill → 再起動 → 同スレッドの会話が再開する
- [ ] 2 プロセス同時起動で lease が排他し、負けた側は inbox 投入のみ
- [ ] 同じ event_id の再送が二重処理されない
- [ ] flush 前クラッシュ → 再起動後に同じ入力から再実行される

## Step 5: Cloud Run デプロイ (Events API)

作るもの: `HttpEventSource` (署名検証 + 3s ACK)、service.yaml
(secretKeyRef / env / GCS FUSE マウント)、Dockerfile での base image ビルド。

- [ ] 本番 Slack の mention に応答する
- [ ] min-instances=0 からのコールドスタートで取りこぼさない
- [ ] インスタンスを跨いだスレッド再開 (デプロイし直して継続)
- [ ] linger 中の追いメッセージが同一 workdir で処理される

## Step 6: 仕上げ (初期版ゴール)

作るもの: UID 分離 + FUSE dir-mode ([design/session-runtime.md](design/session-runtime.md) §6)、`PI_ENV_PASSTHROUGH` ([design/session-runtime.md](design/session-runtime.md) §2)、
turn timeout (10 分) + エラー投稿 + ❌、DM 既定 config (`dm`)、
CLI (`apply` / `status` / `init`)、base image の公開。

- [ ] pi の bash から /data が読めない・Runner の environ が読めない
- [ ] timeout 超過 → kill → ❌ + エラー投稿、再依頼で復帰
- [ ] DM で passthrough 起動する
- [ ] `apply` → ChannelDoc 反映 → 次イベントから挙動が変わる
- [ ] `status` で sessions 一覧と transcript dump が見える
- [ ] `init` の scaffold から利用者の拡張イメージがビルドできる

## 想定ディレクトリツリー (新規リポジトリ)

```
<repo>/
├── package.json            # npm パッケージ (Runner + CLI)
├── Dockerfile              # base image ([design/session-runtime.md](design/session-runtime.md) §5)
├── compose.yaml            # Firestore エミュレータ (開発・テスト用)
├── service.yaml            # Cloud Run 定義 (secretKeyRef / env)
├── src/
│   ├── server.ts           # エントリポイント (EventSource 起動 + HTTP)
│   ├── ingress/
│   │   ├── event-source.ts # EventSource IF + Http / Socket 実装
│   │   └── slack-adapter.ts# IngressAdapter (署名検証・codec)
│   ├── gate/
│   │   ├── gate.ts         # Gate IF + registry + any/all
│   │   └── gates/          # mention.ts / keyword.ts / passthrough.ts
│   ├── session/
│   │   ├── runner.ts       # lease → drain → kick のオーケストレーション
│   │   ├── runtime.ts      # SessionRuntime: spawn / RPC / timeout
│   │   ├── workdir.ts      # tmpfs 準備・restore・flush
│   │   └── inbox.ts        # InboxStore (poll / 既読管理)
│   ├── store/
│   │   ├── firestore.ts    # ChannelDoc / SessionDoc / lease
│   │   └── config-source.ts# ConfigSource IF (Firestore / File)
│   ├── reply/
│   │   ├── router.ts       # thread_key → thread_ts、投稿、formatter フック
│   │   └── reactions.ts    # 👀 / ✅ / ❌
│   └── cli/                # apply.ts / status.ts / init.ts
├── extensions/
│   └── reply.ts            # pi extension (イメージの /app/extensions/ へ)
├── skills/                 # サンプル skill (イメージの /app/skills/ へ)
├── examples/
│   └── config/
│       ├── channels/       # ask-ai.yaml / dm.yaml
│       └── prompts/        # *.md
└── test/
```

ステップとの対応: Step 1 = ingress + reply の骨格、Step 2 = session/runtime +
extensions/、Step 3 = gate + config-source(File) + examples/、Step 4 = store +
workdir、Step 5 = Dockerfile + service.yaml、Step 6 = cli + 隔離まわり。
