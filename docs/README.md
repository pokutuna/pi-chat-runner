# チャット駆動エージェント設計ドキュメント

Slack などのチャットから pi を駆動するエージェントランナーの設計一式である。
全体像は [design.md](design.md)、領域ごとの詳細は `design/` 配下にまとめる。

## 構成

- **design.md** — 設計全体の概要。Runner / Session / Runtime / State / Config と、メッセージ処理の流れを説明する
- **design/** — 領域ごとの詳細設計 (architecture / session-model / message-dispatch / state / runtime / config / ingress-egress / local-dev)
- **research/** — hermes-agent / pi の実装調査 (コード参照付き。実装時のリファレンス)
- 直下 — 運用ガイド

## ドキュメント一覧

| ドキュメント | 内容 |
|---|---|
| [design.md](design.md) | メインの設計概要: Core Components / Pipeline / Session Model / Runtime / Config |
| [design/architecture.md](design/architecture.md) | Core Components と Pipeline、起動時の実装選択、モジュール配置、event と session の分離 |
| [design/session-model.md](design/session-model.md) | Channel / Thread / Session / Turn、session.mode と reply.mode、Thread Key、コマンド、終了条件 |
| [design/message-dispatch.md](design/message-dispatch.md) | Session の選択と affinity、debounce、steering、lease、起動と Turn 境界、Inbox の dedupe |
| [design/state.md](design/state.md) | Control State の Store と backend、Agent State の archive、Workdir / Shared のパスと復元・保存 |
| [design/runtime.md](design/runtime.md) | pi の起動準備と引数、Extension と Skill、Agent の隔離 (UID / env / srt sandbox)、システムプロンプト、RPC |
| [design/config.md](design/config.md) | Config の 3 分類、YAML の形、ロードと Channel の解決、Gate の合成規則、dump |
| [design/ingress-egress.md](design/ingress-egress.md) | ChatEvent と Slack の正規化、Thread Key から送信先への解決、整形と分割、リアクション、進捗通知 |
| [design/local-dev.md](design/local-dev.md) | Slack なしで全パイプラインを動かす local mode |
| [proposals/model-access-broker.md](proposals/model-access-broker.md) | Model Broker の設計 (Draft) |
| [proposals/pi-model-broker-extension.md](proposals/pi-model-broker-extension.md) | Model Broker package / pi extension の設計 (Draft) |
| [research/hermes-chat-modeling.md](research/hermes-chat-modeling.md) | hermes のメッセージ/アダプタ/束ね/プロンプト化/ストリーム出力 |
| [research/hermes-session-model.md](research/hermes-session-model.md) | hermes のセッションキー/永続化/再開/steering/scale-to-zero/起動フィルタ |
| [research/pi-session-model.md](research/pi-session-model.md) | pi の JSONL ツリー永続化/導出コンテキスト/compaction/RPC/orchestrator |
