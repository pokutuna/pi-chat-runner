# チャット駆動エージェント設計ドキュメント

hermes-agent (NousResearch) と pi (earendil-works) の実装調査をもとにした、
Slack から pi を駆動するエージェントブリッジの設計一式である。実装は新規リポジトリで行い、
このディレクトリを設計入力として渡す。

## 構成

- **design/** — この agent 実行環境の設計。[design/README.md](design/README.md) がメインの Design Doc で、
  詳細スペック 6 本 (chat-model / session-model / architecture / components / config / session-runtime) がぶら下がる
- **research/** — hermes-agent / pi の実装調査 (コード参照付き。実装時のリファレンス)
- 直下 — 長期で残さないもの: `initial-scope.md` (初期版スコープの決定事項)、
  `build-plan.md` (実装順序プラン)

## ドキュメント一覧

| ドキュメント | 内容 |
|---|---|
| [design/README.md](design/README.md) | メインの Design Doc: Objective/Goals/Scenarios/Security/Timeline |
| [design/chat-model.md](design/chat-model.md) | ConversationRef/ChatEvent/アダプタ (Ingress/Egress)/プロンプト化/出力 Sink |
| [design/session-model.md](design/session-model.md) | sessionKey・エントリ列・lease/steering・起動 3 段ゲート・再開・隔離・成果物・クロスセッション |
| [design/architecture.md](design/architecture.md) | Slack × GCP の最終案 (単一組織向け簡素版): channels 軸 Firestore、GCS FUSE、実装順序 |
| [design/components.md](design/components.md) | コンポーネント README: Trigger/Gate/Inbox/Session/Runner/Reply の全体像 (Mermaid 図付き) |
| [design/config.md](design/config.md) | Config 設計: ユースケース→置き場所の判断基準、ChannelDoc スキーマ、pi 起動設定への実体化、記述形式 (YAML + apply)、カスタマイズポイント全体地図 |
| [design/session-runtime.md](design/session-runtime.md) | セッション実行の仕様: pi の kick シーケンス、env allowlist、tmpfs/GCS flush と再開、steering の RPC 配達、最小イメージ、同居コンテナ内の隔離 |
| [initial-scope.md](initial-scope.md) | 初期版スコープの決定事項: Gate セット、受付/エラーの合図、timeout、DM、既定モデル、観測性、「後で」の一覧 |
| [build-plan.md](build-plan.md) | 実装順序プラン: Step 0-6 (疎通 → pi 単体 → 一気通貫 → 永続化 → デプロイ → 仕上げ)、動作確認リスト、想定ディレクトリツリー |
| [research/hermes-chat-modeling.md](research/hermes-chat-modeling.md) | hermes のメッセージ/アダプタ/束ね/プロンプト化/ストリーム出力 |
| [research/hermes-session-model.md](research/hermes-session-model.md) | hermes のセッションキー/永続化/再開/steering/scale-to-zero/起動フィルタ |
| [research/pi-session-model.md](research/pi-session-model.md) | pi の JSONL ツリー永続化/導出コンテキスト/compaction/RPC/orchestrator |

旧版は tmp/chat-agent-design/ にそのまま残している (履歴として維持)。
