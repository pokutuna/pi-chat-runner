# pi-coding-agent の設定項目の調査

pi の設定体系の全体像。対象: earendil-works/pi (2026-07-05 時点の main)。
一次情報: `packages/coding-agent/docs/settings.md`, `docs/providers.md`,
`docs/usage.md`, `src/cli/args.ts`, `src/core/settings-manager.ts`。

## 設定の 4 層

| 層 | 場所 | 備考 |
|---|---|---|
| settings.json | `~/.pi/agent/settings.json` (global) / `.pi/settings.json` (project) | project が global を override (nested merge) |
| CLI フラグ | spawn 引数 | bridge の注入点。settings より個別優先 (例: `--session-dir` > `PI_CODING_AGENT_SESSION_DIR` > `sessionDir`) |
| 環境変数 | `PI_*` と provider 認証系 | 下記 |
| コンテキストファイル | `~/.pi/agent/AGENTS.md` (global) + cwd から `AGENTS.md` / `CLAUDE.md` を discovery | `--no-context-files` で無効化 |

## settings.json の主要カテゴリ

bridge 運用に関係するものを中心に (全項目は settings.md 参照):

| カテゴリ | 主な項目 | bridge との関係 |
|---|---|---|
| Model & Thinking | `defaultProvider` / `defaultModel` / `defaultThinkingLevel` / `thinkingBudgets` | spawn 引数 `--model` (provider/model-id 形式) で上書きされるので ChannelDoc 側が勝つ |
| **Compaction** | `compaction.enabled` (**既定 true**) / `reserveTokens` (16384) / `keepRecentTokens` (20000) | **pi は自動 compaction が既定で有効**。閾値チューニングもここ |
| Retry | `retry.enabled` (true) / `maxRetries` (3) / `baseDelayMs` / `retry.provider.*` | 一時エラーの吸収は pi 側に既にある。bridge の再試行と二重にしない |
| Message Delivery | `steeringMode` / `followUpMode` (共に既定 `"one-at-a-time"`) | inbox 配達 ([session-runtime.md](../design/session-runtime.md) §4) と噛み合う既定 |
| Resources | `packages` / `extensions` / `skills` / `prompts` / `themes` (glob, `!` 除外) | 固定パス規約の代替・補完。npm/git パッケージから skill を配布する将来手段 |
| Sessions | `sessionDir` | `--session` で明示 spawn するので未使用 |
| Shell | `shellPath` / `shellCommandPrefix` / `npmCommand` | `shellCommandPrefix` は bash 全コマンドへの前置 — 隔離ラッパーの seam にもなる |
| Trust | `defaultProjectTrust` (既定 `"ask"`) | 下記「project trust」 |
| Network / Telemetry | `httpProxy` / `enableInstallTelemetry` | `--offline` or `PI_OFFLINE=1` で起動時の外部通信を全停止 |
| Images | `images.blockImages` | 添付未対応の初期版と整合 |

## CLI フラグ (args.ts、37 個)

- 実行モード: `--mode` (interactive/print/json/rpc) / `--print` / `--verbose` / `--export`
- モデル: `--provider` / `--model` / `--models` / `--api-key` / `--thinking` / `--list-models`
- プロンプト: `--system-prompt` / `--append-system-prompt` / `--prompt-template` / `--no-context-files`
- セッション: `--session` / `--session-dir` / `--session-id` / `--continue` / `--resume` / `--fork` / `--no-session` / `--name`
- リソース: `--extension` / `--skill` / `--theme` / `--no-extensions` / `--no-skills` / `--no-themes` / `--no-prompt-templates`
- ツール: `--tools` / `--exclude-tools` / `--no-tools` / `--no-builtin-tools`
- trust: `--approve` / `--no-approve`
- その他: `--offline` / `--help` / `--version`

## 環境変数

- `PI_*`: `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, `PI_CODING_AGENT_SESSION_DIR`,
  `PI_PACKAGE_DIR`, `PI_CODING_AGENT_DIR`, `PI_TELEMETRY` など
- provider 認証の解決順: `--api-key` > `auth.json` > 環境変数 > `models.json`
- **Google Vertex AI は ADC 対応** (providers.md): `GOOGLE_CLOUD_PROJECT` と
  **`GOOGLE_CLOUD_LOCATION`** が必要 (または `GOOGLE_APPLICATION_CREDENTIALS`)

## project trust (セキュリティ上重要)

- 非対話モード (`-p` / `--mode json` / `--mode rpc`) は trust プロンプトを出さず、
  `defaultProjectTrust` (既定 `"ask"`) では **project リソースを無視**する
- つまり workdir に `.pi/settings.json` や `.pi` 拡張を仕込まれても、
  RPC モードの既定では読み込まれない — bridge にとって安全側の既定
- `--approve` / `--no-approve` で 1 回分の上書きが可能

## bridge 設計への含意

1. **auto-compaction は pi 既定で有効** — [initial-scope.md](../initial-scope.md) の
   「compaction は放置」は「pi の自動 compaction に任せる」が正確。bridge 側の
   warning ログは transcript の GCS サイズ監視として残す意味だけある
2. **env allowlist に `GOOGLE_CLOUD_LOCATION` が必要** —
   [session-runtime.md](../design/session-runtime.md) §2 に反映済み
3. **settings.json は「能力 = イメージ」の一部にできる** — retry / steeringMode /
   compaction 閾値などの挙動既定はイメージ内の `~/.pi/agent/settings.json`
   (HOME はイメージ内で bridge が管理) に焼く。ChannelDoc からは model と
   プロンプトだけ、の整理が保てる
4. 本番 spawn では `--offline` (または `PI_OFFLINE=1`) を付け、起動時の
   バージョンチェック・telemetry の外部通信を止める (コールドスタート短縮)
5. `--no-context-files` は使わない: workdir の AGENTS.md discovery は
   ChannelDoc.context を実体化する受け皿として活用余地がある
