# Pi Model Broker Package

- Author: pokutuna
- Status: Draft
- Created: 2026-07-21
- URL: 発行後に記入

## Objective

Model Broker server と pi extension を一つの独立 package として提供し、pi-chat-runner などの host が upstream credential を pi process に渡さずに複数の AI provider を利用できるようにする。

## Decision

**Pi Model Broker Package** は pi-chat-runner と別の repository で開発し、通常の npm package 兼 pi package として配布する。

同じ package に次の四つを含める。

1. Model Broker server library
2. Broker を単独起動する CLI
3. provider manifest の共有 contract
4. pi の Provider Routing Extension

extension 自体の責務は次の三つに限定する。

1. `PI_MODEL_BROKER_URL` から provider manifest を取得する。
2. manifest を検証する。
3. provider ごとに `pi.registerProvider()` を呼ぶ。

extension は Broker server を同じ process で起動せず、pi-chat-runner の module も import しない。
Broker server と extension が同じ npm artifact に入っていても、runtime の process boundary は維持する。

```text
Host
  ├─ startBroker() または pi-model-broker serve
  │    └─ Model Broker ── upstream credential ── AI provider
  │
  └─ pi + Provider Routing Extension
       ├─ GET /v1/providers ────────────────▶ Model Broker
       └─ provider request ─────────────────▶ Model Broker
```

pi-chat-runner は package version を固定して image に組み込み、初期実装では server library を runner process 内で起動する。
別 UID が必要な deployment は同じ package の CLI を別 process または sidecar として起動する。

package の同梱範囲は security boundary ではない。
credential を隠す性質は、Broker と pi が別 process で動き、pi から Broker の env、memory、credential file を読めないことによって成立する。

## Background

pi は `models.json` と extension API の `pi.registerProvider()` により、built-in provider の `baseUrl` を上書きできる。
`models` を指定しなければ、built-in model catalog、API adapter、model ごとの互換性設定は維持される。

async extension factory は pi の model 解決より前に完了する。
extension は起動時に provider 設定を取得してから、通常の `--model provider/model-id` を pi に解決させられる。

この repository の pi 0.79.9 では、空の `PI_CODING_AGENT_DIR` で OpenAI provider を mock Broker へ向け、次を確認した。

- dummy key だけで `--list-models openai` が built-in models を列挙した。
- `openai/gpt-4` が `/providers/openai/v1/responses` へ request を送った。
- credential 環境変数がなければ、Broker は dummy Authorization header を受信した。
- `OPENAI_API_KEY` が存在すると、pi は dummy key よりその値を優先した。

最後の挙動から、extension 単独では credential の非露出を保証できない。
pi の credential 解決順は、`--api-key`、`auth.json`、process environment、extension の dummy key の順だからである。
credential を pi へ渡さない責任は host が持つ。

## Goals

- pi-chat-runner から Broker package を独立させる。
- package の同梱単位を変えずに、Broker を embedded、別 process、sidecar のいずれでも起動できるようにする。
- URL 一つで複数 provider を登録できるようにする。
- built-in provider の model 名と model 選択方法を維持する。
- pi の標準 API type を使う custom provider を登録できるようにする。
- Broker の異常時に通常 provider へ黙って fallback しないようにする。
- package と Broker の互換性を自動テストできるようにする。

## Non-Goals

- credential vault、OAuth login、OAuth refresh は実装しない。
- extension 内では provider request と response を中継しない。
- OpenAI、Anthropic、OpenRouter などの wire protocol は再実装しない。
- outbound network は制限しない。
- provider 間の fallback、課金管理、rate limit は実装しない。
- pi の credential 解決順は変更しない。

## Usage

通常の pi CLI では、Broker を起動して package を読み込む。

```sh
npx @scope/pi-model-broker@1.0.0 serve \
  --config /path/to/model-broker.json \
  --listen 127.0.0.1:43127

PI_MODEL_BROKER_URL=http://127.0.0.1:43127/ \
  pi -e npm:@scope/pi-model-broker@1.0.0 \
  --model openai/gpt-4
```

継続利用する場合は pi package として install できる。

```sh
pi install npm:@scope/pi-model-broker@1.0.0
```

`pi install` は extension を pi に登録する操作であり、Broker daemon を自動起動しない。
Broker CLI は npm の global install、`npx`、service manager、または host application の dependency として別に起動する。

開発中は local path を使う。

```sh
PI_MODEL_BROKER_URL=http://127.0.0.1:43127/ \
  pi -e /absolute/path/to/pi-model-broker \
  --list-models openai
```

利用者は従来どおり `provider/model-id` を選ぶ。
prompt や skill に Broker URL を教える必要はない。

## Package Structure

package は Broker、CLI、extension、共有 contract を含む。

```text
pi-model-broker/
  package.json
  README.md
  LICENSE
  src/
    cli.ts
    server.ts
    proxy.ts
    contract.ts
    extension.ts
    broker-url.ts
    manifest.ts
    registration.ts
  dist/
    cli.js
    server.js
    contract.js
    extension.js
  test/
    unit/
    integration/
```

extension entrypoint は Broker server module を import しない。
package の install と pi の extension load によって Broker が自動起動する副作用は設けない。

Broker の HTTP 実装に必要な runtime dependency は package に含める。
pi から import する package は peer dependency にする。

```json
{
  "name": "@scope/pi-model-broker",
  "version": "0.1.0",
  "type": "module",
  "keywords": ["pi-package"],
  "bin": {
    "pi-model-broker": "./dist/cli.js"
  },
  "exports": {
    "./server": "./dist/server.js",
    "./contract": "./dist/contract.js"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  },
  "peerDependenciesMeta": {
    "@earendil-works/pi-coding-agent": {
      "optional": true
    }
  },
  "pi": {
    "extensions": ["./dist/extension.js"]
  },
  "files": ["dist", "README.md", "LICENSE"]
}
```

`@scope/pi-model-broker` は package が server も含む構成と一致する。
scope は publish 前に確定する。

`@earendil-works/pi-coding-agent` は optional peer にする。
Broker CLI と server library だけを使う環境へ pi 本体を install させず、extension を読み込む pi host には既存の pi package を使わせるためである。

## Broker Server Interface

### Library API

pi-chat-runner は server entrypoint を import して Broker を起動する。

```typescript
import { startModelBroker } from "@scope/pi-model-broker/server";

const broker = await startModelBroker({
  listen: { host: "127.0.0.1", port: 0 },
  providers: {
    openai: {
      upstreamBaseUrl: "https://api.openai.com/v1",
      headers: {
        Authorization: `Bearer ${openAiApiKey}`,
      },
    },
  },
});

broker.url;
await broker.close();
```

`port: 0` は OS に ephemeral port を選ばせる。
`startModelBroker()` は listen が完了してから resolve し、canonical Broker URL と idempotent な `close()` を返す。

provider 設定は pi-chat-runner が解決した値を memory 上で渡す。
library は pi-chat-runner の config 型や env reference 構文に依存しない。

### CLI

別 process として動かす場合は同じ package の CLI を使う。

```sh
pi-model-broker serve \
  --config /run/model-broker/config.json \
  --listen 127.0.0.1:0
```

CLI 用 config は provider の固定 upstream と header value reference を持つ。

```json
{
  "providers": {
    "openai": {
      "upstreamBaseUrl": "https://api.openai.com/v1",
      "headers": {
        "Authorization": {
          "env": "OPENAI_API_KEY",
          "prefix": "Bearer "
        }
      }
    },
    "anthropic": {
      "upstreamBaseUrl": "https://api.anthropic.com",
      "headers": {
        "x-api-key": {
          "env": "ANTHROPIC_API_KEY"
        }
      }
    }
  }
}
```

config file に secret literal を書く必要はない。
CLI は自身の environment で reference を解決し、pi process へ継承しない。

listen 完了後、CLI は stdout に readiness event を一行出す。
host は固定 port に依存せず、この event から URL を取得できる。

```json
{"event":"ready","url":"http://127.0.0.1:43127/","manifestVersion":1}
```

通常 log は stderr へ出す。
SIGTERM と SIGINT を受けたら新規 request を停止し、処理中 request の終了を一定時間待って exit する。

### Forward proxy

Broker の upstream HTTP client は optional な forward proxy 設定を受け取る。
library mode では dispatcher または proxy URL を option として渡し、CLI mode では config の env reference で渡す。

forward proxy credential は Broker process だけが解決する。
pi に渡す `HTTP_PROXY` と同じ値を自動利用せず、Broker 用設定を明示する。

## Deployment Modes

### Embedded in pi-chat-runner

初期実装は `startModelBroker()` を pi-chat-runner process 内で呼ぶ。
runner は元から boot config と credential を扱う trusted process なので、Broker を同居させても新しい secret exposure は増えない。

pi subprocess は runner と別 UID で起動し、runner の environment、memory、credential file を読めない状態にする。
この UID 分離が満たせない環境では、Broker package を同梱しても API key の秘匿は保証できない。

pi-chat-runner は既に `PI_AGENT_UID` と `PI_AGENT_GID`、または `agent.runtime.uid` と `agent.runtime.gid` を使って pi subprocess の UID/GID を落とせる。
したがって初期構成は、trusted な runner process に Broker library を埋め込み、pi だけを agent UID で起動する形にできる。

### Separate process and UID

より明確な分離が必要な deployment は `pi-model-broker serve` を別 UID で起動する。
supervisor または container runtime が Broker UID にだけ credential environment と config file の read permission を与える。

pi-chat-runner は readiness event から Broker URL だけを受け取り、その URL を pi へ渡す。
CLI 自身は `setuid`、sudo、user 作成を行わない。
process と UID の構成は host の責任とする。

### Sidecar

sidecar は pi-chat-runner と network namespace を共有できる環境で利用する。
Broker は共有 loopback に bind し、credential は sidecar だけへ渡す。

network namespace を共有しない container 間で Broker port を公開すると、同じ network の別 process も利用できる。
version 1 は Broker token を持たないため、その構成は採用しない。

### Extension auto-start

extension factory から Broker を自動起動する mode は設けない。
その構成では Broker credential を pi process へ渡す必要があり、元の目的を満たさない。

同じ package に server CLI が含まれることと、extension が server を起動することは別の判断である。
前者は配布と version 管理を簡単にし、後者は credential の信頼境界を壊す。

## Configuration Interface

extension が読む設定は `PI_MODEL_BROKER_URL` 一つだけである。

```text
PI_MODEL_BROKER_URL=http://127.0.0.1:43127/
```

この URL は provider API の `baseUrl` ではなく、manifest を公開する Broker root である。
version 1 では次を要求する。

- absolute `http:` または `https:` URL である。
- pathname は `/` である。
- username、password、query、fragment を持たない。
- `http:` は `127.0.0.0/8`、`::1`、`localhost` にだけ許可する。
- trailing slash を canonical form とする。

環境変数がなければ extension load を失敗させる。
extension が読み込まれたのに routing だけが無効になる状態は作らない。

`PI_OFFLINE=1` でも、明示された loopback Broker の manifest は取得する。
`PI_OFFLINE` は pi の catalog refresh を抑止する設定であり、host が用意した local dependency を無効にする設定としては扱わない。

## Manifest Interface

extension は起動時に次の endpoint を一度取得する。

```http
GET /v1/providers
Accept: application/json
```

redirect は追従しない。
timeout は 3 秒、最大 response size は 1 MiB とする。

```json
{
  "version": 1,
  "providers": [
    {
      "mode": "override",
      "provider": "openai",
      "baseUrl": "http://127.0.0.1:43127/providers/openai/v1"
    },
    {
      "mode": "override",
      "provider": "anthropic",
      "baseUrl": "http://127.0.0.1:43127/providers/anthropic"
    },
    {
      "mode": "custom",
      "provider": "acme-ai",
      "baseUrl": "http://127.0.0.1:43127/providers/acme-ai/v1",
      "api": "openai-completions",
      "models": [
        {
          "id": "acme-chat",
          "name": "Acme Chat",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 16384,
          "cost": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0
          }
        }
      ]
    }
  ]
}
```

### Built-in provider override

`mode: "override"` は pi が既に知っている provider の routing だけを変更する。
extension は `models` と `api` を指定しない。

```typescript
pi.registerProvider(entry.provider, {
  baseUrl: entry.baseUrl,
  apiKey: "pi-model-broker-placeholder",
});
```

dummy key は pi の認証済み判定と provider SDK の必須値を満たすために使う。
secret ではなく、Broker は upstream request を作る前にこの認証 header を削除する。

### Custom provider registration

`mode: "custom"` は pi が知らない provider と model を登録する。
`provider`、`baseUrl`、`api`、一つ以上の `models` を必須にする。

version 1 で許可する `api` は次の四つである。

- `openai-completions`
- `openai-responses`
- `anthropic-messages`
- `google-generative-ai`

extension は検証済みの `api` と `models` を `registerProvider()` へ渡す。
upstream URL、credential、認証 header は manifest に含めない。

### Manifest validation

extension は manifest 全体を検証してから provider を登録する。
一件でも不正なら `registerProvider()` を一度も呼ばない。

次の manifest は拒否する。

- `version` が `1` ではない。
- provider entry が空、または provider 名が重複している。
- provider 名が `^[a-z0-9][a-z0-9._-]*$` に一致しない。
- `baseUrl` が Broker root と同一 origin ではない。
- `baseUrl` が `/providers/<provider>` 配下ではない。
- `baseUrl` に username、password、query、fragment がある。
- `mode` に必要な field が不足している。
- schema にない field がある。
- custom model の ID が重複している。

同一 origin 制約により、manifest の設定ミスで pi が外部 provider へ直接接続することを防ぐ。

## Startup Behavior

async extension factory は次の順序で動く。

1. Broker URL を読み、検証する。
2. manifest を redirect 無効、3 秒 timeout で取得する。
3. status、content type、response size、JSON schema を検証する。
4. 全 entry を provider registration へ変換する。
5. provider を順番に登録する。

extension は retry しない。
Broker の readiness は host が pi の起動前に保証する。

extension は timer、socket、child process、file watcher を残さない。
manifest は session 中に再取得しない。
変更は pi の再起動または `/reload` で反映する。

startup error は原因と修正対象だけを示す。
manifest 全文と response body は log に出さない。

```text
pi-model-broker: PI_MODEL_BROKER_URL is not set
pi-model-broker: broker manifest request timed out after 3000 ms
pi-model-broker: unsupported manifest version 2
pi-model-broker: provider "openai" baseUrl must stay under the broker origin
```

error 時は pi の起動も失敗させる。
通常 provider への fallback mode は設けない。

## Host Contract

extension は credential を受け取らないが、pi の既存 credential を消すこともできない。
host は Broker 対象 provider について次を保証する。

- 実 credential を `--api-key` に指定しない。
- credential 環境変数を pi へ渡さない。
- pi が利用する `auth.json` に credential を置かない。
- Broker URL に secret を含めない。

extension API は active auth storage を公開しない。
extension が特定 path の `auth.json` を直接検査すると、SDK embedding や将来の storage 実装では誤った判定になるため採用しない。

この境界は README に目立つ形で記載する。
pi-chat-runner では専用 HOME、env allowlist、起動時 validation、end-to-end test で保証する。

## Security

### manifest が外部 URL を返す

Scenario: 誤設定された manifest が upstream provider URL を `baseUrl` として返し、pi が Broker を迂回する。

Mitigations:

- `baseUrl` を Broker と同一 origin に限定する。
- `/providers/<provider>` prefix を検証する。
- HTTP redirect を追従しない。
- invalid manifest では provider を一件も登録しない。

### manifest に credential が混入する

Scenario: Broker が誤って token や認証 header を manifest に含める。

Mitigations:

- manifest を allowlist schema で検証し、unknown field を拒否する。
- manifest 全文を log に残さない。
- extension entrypoint の設定面を Broker URL 一つに限定する。

### 既存 credential が dummy key を上書きする

Scenario: `auth.json` や process environment に credential があり、pi がその値を Broker request に設定する。

Mitigations:

- host contract で credential-free な pi process を要求する。
- integration test で Broker が dummy key 以外を受信しないことを確認する。
- credential precedence の characterization test を残し、pi update による挙動変化を検出する。

### pi が Broker process の credential を読む

Scenario: Broker と pi が同じ UID で動き、pi が `/proc`、debug interface、共有 file を通じて Broker の credential を読む。

Mitigations:

- production では pi を runner または Broker と別 UID で起動する。
- credential file は Broker UID だけが読める permission にする。
- Broker credential を command line argument に入れない。
- package source が両 UID から読めることは許容する。package source に credential を含めないためである。

## Test Plan

### Unit tests

Broker URL parser は次を検証する。

- loopback HTTP と remote HTTPS を受理する。
- remote HTTP、userinfo、path、query、fragment を拒否する。
- canonical form を安定して生成する。

manifest parser は次を検証する。

- valid な `override` と `custom` entry を受理する。
- version、duplicate、unknown field、invalid API、invalid model を拒否する。
- cross-origin と provider path mismatch を拒否する。
- response size 上限を超えた body を拒否する。

registration tests は fake `ExtensionAPI` を使う。

- `override` が `baseUrl` と dummy key だけを登録する。
- `custom` が `api` と `models` を登録する。
- invalid entry が一つでもあれば provider を登録しない。

Broker server tests は mock upstream を使う。

- local route と upstream base URL を正しく結合する。
- incoming の認証 header と hop-by-hop header を削除する。
- provider 設定の header を最後に設定する。
- request body と response body を buffer せず中継する。
- redirect を追従しない。
- request から任意の upstream host を選べない。
- manifest に upstream URL と header を含めない。

CLI tests は child process を起動する。

- env reference を CLI process 内で解決する。
- readiness event を stdout に一度だけ出す。
- log と error を stderr に出し、credential を含めない。
- SIGTERM で listener と処理中 request を終了する。

### pi integration tests

test process は package の Broker server と mock upstream を起動し、受信した method、path、header を記録する。
実 provider API は呼ばない。

CI は固定した最小対応 pi version と最新 pi version で次を実行する。

1. 空の `PI_CODING_AGENT_DIR` と `PI_OFFLINE=1` で extension を読み込む。
2. `--list-models openai` が built-in OpenAI models を列挙することを確認する。
3. OpenAI model の request が Broker を通り、mock upstream の OpenAI path に届くことを確認する。
4. Anthropic model の request path に `/v1/messages` が含まれることを確認する。
5. OpenRouter model が OpenAI-compatible route を使うことを確認する。
6. custom provider を `--list-models` と `--model` で解決できることを確認する。
7. timeout、invalid JSON、unknown version、redirect で pi が非 0 終了することを確認する。
8. Broker が incoming dummy key を除去し、sentinel upstream credential を挿入することを確認する。

`OPENAI_API_KEY=REAL_SHOULD_NOT_LEAK` を与える characterization test も用意する。
stock pi が dummy key より環境変数を優先することを確認し、host contract が必要な理由を固定する。

### Streaming smoke test

mock Broker は二つの SSE event を間隔を空けて返す。
pi の JSON または RPC output が response 完了前に最初の delta を出すことを確認する。

extension 自身は stream を処理しない。
この test は provider registration を経由しても pi と Broker の streaming が維持されることを確認する。

### Package tests

release candidate は次の三経路で検証する。

```sh
npm pack --dry-run
pi -e ./ --list-models openai
pi -e npm:@scope/pi-model-broker@<version> --list-models openai
```

git tag からの `pi install` も release 前に一度確認する。

## Manual Verification

開発者は一時 pi directory と mock Broker を用意する。

```sh
export PI_CODING_AGENT_DIR=/tmp/pi-model-broker-test-agent
export PI_MODEL_BROKER_URL=http://127.0.0.1:43127/
export PI_OFFLINE=1

pi -e ./ --list-models openai
pi -e ./ \
  --provider openai \
  --model gpt-4 \
  --no-tools \
  --no-session \
  --print test
```

mock Broker の記録で次を確認する。

- manifest を一回取得している。
- model request が OpenAI route に届いている。
- incoming Authorization header が dummy value である。
- manifest と extension log に upstream credential がない。

次に manifest version を未知の値へ変更し、model request 前に pi が終了することを確認する。

## Compatibility Policy

manifest protocol と npm package は別々に versioning する。

- manifest の `version` は wire contract の breaking change で増やす。
- npm package は semantic versioning に従う。
- extension は理解できない manifest version を拒否する。

extension は pi の public extension API だけを利用する。
`ModelRegistry`、`AuthStorage`、pi の内部 file layout は import しない。

CI は最小対応 pi と最新 pi を検査する。
pi update で integration test が失敗した場合は、対応する extension release まで pi-chat-runner の依存更新を止める。

## pi-chat-runner Integration

pi-chat-runner は Broker と extension の source を複製せず、package の exact version を dependency として固定する。

runner は Broker の listen 完了後に pi を起動する。

```text
PI_MODEL_BROKER_URL=http://127.0.0.1:<port>/
--extension <resolved-package-path>/dist/extension.js
```

runner は起動前に次を検証する。

- Broker 対象 provider の credential が `agent.env` にない。
- Broker 対象 provider の credential が pi 用 `auth.json` にない。
- Broker mode の provider に実 `--api-key` を指定していない。

end-to-end test では runner に sentinel credential を与え、pi の env、argument、HOME、workdir、Broker incoming request に sentinel が現れないことを確認する。
Broker が upstream request を組み立てる時点でだけ sentinel が現れることを確認する。

package 更新時は pi version、extension version、manifest version の組み合わせを同じ integration suite で検証する。

## Milestones

### Milestone 1: Broker and contract

- Broker server、共有 contract、manifest parser を実装する。
- mock upstream を使う proxy tests を通す。
- library API と CLI の両方で起動できるようにする。

### Milestone 2: pi integration

- async extension factory を実装する。
- built-in provider、custom provider、credential injection、streaming の integration tests を通す。
- 最小対応 pi version を決める。

### Milestone 3: Package release

- README、LICENSE、CHANGELOG を整備する。
- npm package と git tag の install smoke test を通す。
- `0.1.0` を publish する。

### Milestone 4: pi-chat-runner adoption

- package version を固定して image に追加する。
- Broker URL と extension path を pi の spawn 設定へ追加する。
- credential scrub と sentinel end-to-end test を通す。

## Acceptance Criteria

- extension の設定が `PI_MODEL_BROKER_URL` 一つだけである。
- 同じ package から Broker library、Broker CLI、pi extension を利用できる。
- 一つの manifest から複数の built-in provider を登録できる。
- built-in model catalog と `provider/model-id` を維持する。
- custom provider を `--list-models` と `--model` で利用できる。
- invalid または unreachable な Broker では model request 前に pi が失敗する。
- package artifact、manifest、log に upstream credential が含まれない。
- 最小対応 pi と最新 pi の integration tests が通る。
- pi-chat-runner の sentinel test で長期 credential が pi 側へ現れない。

## Open Issues

### Package scope

問題：package 名の scope と publish 先が未決定である。

候補：個人 scope、組織 scope、unscoped package。

次の一手：publish 前に npm availability と保守主体を確認して決める。

### Minimum pi version

問題：0.79.9 で必要な動作を確認したが、support range は未決定である。

次の一手：Milestone 2 の version matrix を動かし、通過する最古 version を `0.1.0` の support floor にする。

## Related Documents

- [Model Broker](model-access-broker.md)
- [pi Providers](https://pi.dev/docs/latest/providers)
- [pi Custom Models](https://pi.dev/docs/latest/models)
- [pi Custom Providers](https://pi.dev/docs/latest/custom-provider)
- [pi Packages](https://pi.dev/docs/latest/packages)
