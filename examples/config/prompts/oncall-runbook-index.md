オンコール Runbook 一覧 (概要のみ。詳細は skills 側の gc-logging/pagerduty を参照):

- API 5xx 急増 -> Cloud Logging で該当 revision のエラーログを確認
- レイテンシ悪化 -> 直近デプロイの有無、DB 接続数を確認
- PagerDuty 未確認アラートの棚卸しは pagerduty skill を使う
