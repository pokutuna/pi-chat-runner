# develop/ — ローカル開発・動作確認用リソース

このディレクトリはローカルでの開発・動作確認専用。本番デプロイの構成は
`examples/` (docs/design 参照) が正。

| ファイル | 用途 |
|---|---|
| `compose.yaml` | Firestore エミュレータ (`FirestoreStateStore` のテスト専用) |
| `compose.local-container.yaml` | UID 分離 + Node Permission Model を有効にした状態で、コンテナ内で Socket Mode を動かす検証用 |
| `Dockerfile.cloud-run-verify` | `config/` を焼き込み、Cloud Run へ実機デプロイして動作確認するための使い捨てイメージ |
| `config/` | 上記で使うローカル設定 (`agent.yaml` ほか)。実チャンネル ID を含むため git 管理外 (`.gitignore`) |
| `drive-pi.ts` | Slack を介さず pi プロセスを直接駆動する使い捨てスクリプト |

## config/ の作り方

`config/` は `.gitignore` されているため、初めて使うときは自分で用意する。
`examples/config/agent.yaml` を土台に、確認したい Gate (mention/keyword/classifier/
reaction) ごとの実チャンネル ID を並べるのが早い ([config.md](../docs/design/config.md) §6)。

## Firestore エミュレータ

```sh
docker compose -f develop/compose.yaml up -d
FIRESTORE_EMULATOR_HOST=localhost:8080 pnpm test
```

## コンテナでのローカル検証 (UID 分離 + Permission Model)

```sh
docker build -t pi-chat-runner:local .
docker compose -f develop/compose.local-container.yaml --env-file .env.socket up
docker compose -f develop/compose.local-container.yaml --env-file .env.socket down -v
```

`pi-smart-fetch` など native addon 拡張も確認したい場合は、先に
`examples/smart-fetch-agent/Dockerfile` で `smart-fetch-agent:local` をビルドし、
`compose.local-container.yaml` の `image:` をそちらに向ける。

## Cloud Run での実機検証

`config/` を焼き込んだイメージをビルドし、Artifact Registry へ push して既存の
Cloud Run サービスを一時的に更新する。**共有環境を書き換えるので、検証後は
本来のデプロイ手順で正しいイメージ・設定に戻すこと。**

```sh
# 1. base image (+ 拡張があればその上のイメージ) を用意
docker build --platform linux/amd64 -t pi-chat-runner:local .

# 2. develop/config を焼き込む
docker build --platform linux/amd64 \
  -f develop/Dockerfile.cloud-run-verify \
  -t <region>-docker.pkg.dev/<project>/<repo>/<image>:<tag> \
  .

# 3. push
docker push <region>-docker.pkg.dev/<project>/<repo>/<image>:<tag>

# 4. 既存サービスを更新 (CONFIG_PATH を develop/config/agent.yaml に向ける)
gcloud run services update <service> \
  --project <project> --region <region> \
  --image <region>-docker.pkg.dev/<project>/<repo>/<image>:<tag> \
  --update-env-vars CONFIG_PATH=develop/config/agent.yaml
```

ログは Cloud Logging で確認する:

```sh
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.revision_name="<revision>"' \
  --project <project> --format=json --order asc
```
