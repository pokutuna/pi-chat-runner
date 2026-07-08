# 初期版スコープの決定事項

インタビューで確定した初期版の線引きの一覧。実装は新規リポジトリで開始し、
この tmp/docs/ 一式を設計入力として渡す前提のため、
本ドキュメントが「初期版で何をどこまで作るか」の正典になる。

## 決定表

| 論点 | 決定 | 補足 |
|---|---|---|
| 初期 Gate セット | mention / keyword / passthrough | registry と apply 時のスキーマ検証 ([design/config.md](design/config.md) §7) は初期版から。classifier (Flash-Lite) は次段 |
| keyword Gate の仕様 | 正規表現 (JS `RegExp`) によるマッチ | パターン文字列を `new RegExp(pattern)` としてそのまま構築する。不正な正規表現はコンストラクション時にエラーとして表面化させる。インラインフラグ (`(?i)` 等) は JS の RegExp が対応しないため、大文字小文字を無視したい場合はパターン側で書き分ける ([design/session-model.md](design/session-model.md) §5) |
| 受付の合図 | トリガーメッセージに 👀 リアクション | Gate 通過 = セッション到達時に付与。ターン正常終了で ✅ に差し替え、失敗で ❌。reply の無い沈黙 ([design/session-model.md](design/session-model.md) §5) でも「見た/終わった」は伝わる |
| エラーの可視化 | スレッドに短いエラー投稿 + ❌ | 「処理に失敗しました (詳細はログ)」程度を host が投稿。再試行が尽きたときのみ (at-least-once の途中失敗では出さない) |
| 添付ファイル | 初期版はテキストのみ | 添付の存在は「添付ファイルあり (未対応)」とプロンプトに注記。ダウンロード対応 (bot token での取得 + workdir 配置) は将来 |
| 成果物の返却 | reply テキストのみ | 生成ファイルは artifacts/ として GCS に残り管理者は取り出せる。reply へのファイル添付 (files.upload) は将来拡張 |
| compaction | 初期版は放置 | transcript サイズが閾値を超えたら warning ログのみ。世代回転 session-g\<N\> ([design/session-model.md](design/session-model.md) §2) の器は設計済みで後付け可 |
| turn timeout | 既定 10 分 (env `TURN_TIMEOUT_MS`) | 超過で pi を kill ([design/session-runtime.md](design/session-runtime.md) §6)。入力は inbox に残るため再実行可能 |
| DM | DM 用の既定 config で対応 | channels/ と同スキーマの特別 ID `dm` を 1 つ用意し全 DM で共有 (gate は passthrough 既定)。YAML + apply の管理経路も共通 |
| 既定モデル | Gemini Flash 系 (env `DEFAULT_MODEL`) | 重いチャンネルだけ ChannelDoc.model で Pro に上げる |
| mrkdwn 整形 | 初期版はそのまま投稿 | reply 投稿パスに formatter フックだけ設ける (初期は identity)。markdown→mrkdwn 変換は後から差し込む |
| 観測性 | 構造化ログ + CLI status | Cloud Logging に sessionKey / turn / gate 判定を構造化出力。apply CLI ([design/config.md](design/config.md) §6) に sessions 一覧・transcript dump のサブコマンドを足す |
| 実装の置き場所 | 新規リポジトリ | hermes-agent / pi は参照元に過ぎない。npm 公開・Dockerfile 同梱・init scaffold ([design/session-runtime.md](design/session-runtime.md) §5) と整合 |

## 明示的に「後で」に倒したもの

classifier Gate、markdown→mrkdwn 変換、添付ファイルのダウンロード、
reply へのファイル添付、compaction の自動トリガー、チャンネル特化イメージ
([design/config.md](design/config.md) §2 将来拡張)、ハード隔離 ([design/session-runtime.md](design/session-runtime.md) §6 将来パス)。
いずれも差し込み点 (registry / formatter フック / 世代回転 / kick インタフェース)
は初期版の設計に含まれており、後付けで壊れない。
