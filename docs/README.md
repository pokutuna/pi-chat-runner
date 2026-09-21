# チャット駆動エージェント設計ドキュメント

Slack などのチャットから pi を駆動するエージェントランナーの設計一式である。
全体像は [design.md](design.md)、領域ごとの詳細は `design/` 配下にまとめる。

## 構成

- **design.md** — 設計全体の概要。Runner / Session / Runtime / State / Config と、メッセージ処理の流れを説明する
- **design/** — 領域ごとの詳細設計 (chat-model / session-model / architecture / config / session-runtime / persistence など)
- **research/** — hermes-agent / pi の実装調査 (コード参照付き。実装時のリファレンス)
- 直下 — 運用ガイド

## ドキュメント一覧

| ドキュメント | 内容 |
|---|---|
| [design.md](design.md) | メインの設計概要: Core Components / Pipeline / Session Model / Runtime / Config |
| [design/chat-model.md](design/chat-model.md) | ConversationRef/ChatEvent/アダプタ (Ingress/Egress)/プロンプト化/出力 Sink |
| [design/session-model.md](design/session-model.md) | sessionKey・エントリ列・lease/steering・起動 3 段ゲート・再開・隔離・成果物・クロスセッション |
| [design/architecture.md](design/architecture.md) | Slack × GCP の最終案 (単一組織向け簡素版): channels 軸 Firestore、GCS FUSE、実装順序 |
| [design/config.md](design/config.md) | Config 設計: ユースケース→置き場所の判断基準、ChannelDoc スキーマ、pi 起動設定への実体化、記述形式 (YAML + apply)、カスタマイズポイント全体地図 |
| [design/session-runtime.md](design/session-runtime.md) | セッション実行の仕様: pi の kick シーケンス、env allowlist、tmpfs/GCS flush と再開、steering の RPC 配達、最小イメージ、同居コンテナ内の隔離 |
| [design/persistence.md](design/persistence.md) | StateStore / WorkdirStorage の抽象と backend 差し替え |
| [design/shared.md](design/shared.md) | チャンネル共有ディレクトリの restore / flush と権限 |
| [design/memory.md](design/memory.md) | 組み込み memory skill の構成 |
| [design/local-dev.md](design/local-dev.md) | Slack なしで全パイプラインを動かす local mode |
| [design/progress-notice.md](design/progress-notice.md) | 長時間ターンの進捗通知 |
| [design/model-access-broker.md](design/model-access-broker.md) | Model Broker の設計 (Draft) |
| [design/pi-model-broker-extension.md](design/pi-model-broker-extension.md) | Model Broker package / pi extension の設計 (Draft) |
| [forward-proxy.md](forward-proxy.md) | sandbox を使わず、派生コンテナ内の forward proxy で pi の通信先を絞る英語レシピ |
| [research/hermes-chat-modeling.md](research/hermes-chat-modeling.md) | hermes のメッセージ/アダプタ/束ね/プロンプト化/ストリーム出力 |
| [research/hermes-session-model.md](research/hermes-session-model.md) | hermes のセッションキー/永続化/再開/steering/scale-to-zero/起動フィルタ |
| [research/pi-session-model.md](research/pi-session-model.md) | pi の JSONL ツリー永続化/導出コンテキスト/compaction/RPC/orchestrator |
