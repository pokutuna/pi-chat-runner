# pi のビルトインツール・sandbox 機構の調査

調査用途 (GCP アラート調査など) で pi を動かすために何が要るかの調査。
対象: earendil-works/pi (2026-07-05 時点の main)。

## ビルトインツール

`packages/coding-agent/src/core/tools/` に 7 つ:
**bash / read / edit / write / grep / find / ls**。

- WebFetch / WebSearch に相当するものは**無い**
- ツールの取捨は CLI フラグで可能 (`src/main.ts`):
  - `--tools, -t <names>` — allowlist
  - `--exclude-tools, -xt <names>` — 除外
  - `--no-builtin-tools, -nbt` — ビルトイン全部無効 (extension ツールは残す)
- extension から `pi.registerTool()` でカスタムツールを追加できる
  (`examples/extensions/dynamic-tools.ts`)

## GCP アラート調査に必要な要素

「Cloud Logging + ソースコード + アプリと GCP の知識」で完結させる場合:

| 要素 | 実現手段 | 備考 |
|---|---|---|
| Cloud Logging / Monitoring の読み取り | 拡張イメージに `google-cloud-cli` を追加し bash から `gcloud logging read` 等 | [build-plan.md](../build-plan.md) の拡張 Dockerfile 例に既にある。認証は ADC がそのまま通る — SA に viewer 系ロール (logging.viewer, monitoring.viewer) を追加するだけ |
| ソースコード | workdir に git clone。`GH_TOKEN` を `PI_ENV_PASSTHROUGH` で pi に渡す | [session-runtime.md](../design/session-runtime.md) §2 の機構がそのまま使える。読み取り専用 token にする |
| アプリ・GCP の知識 | skill (`/app/skills/`) に調査手順を書く | Logging クエリのレシピ、アラートポリシー→メトリクス→ログ→コードの手順など。ChannelDoc の systemPrompt / context でチャンネル固有の前提を足す |
| jq / ripgrep / fd | base image に同梱済み | |

extra の WebFetch / WebSearch:

- **WebFetch 相当は bash + curl で事実上足りる** (base に curl あり)。専用ツール化は急がない
- **WebSearch は bash では代替できない**ので、必要になったら extension ツールとして追加
  (`registerTool` で検索 API を叩く)。/app/extensions/ の固定パス規約に乗る。初期版スコープ外でよい

## sandbox / セキュリティの手 (pi 側で使えるもの)

pi 公式の隔離パターンは 2 系統 (`docs/containerization.md`):

1. **pi プロセス全体を隔離環境で走らせる** — Plain Docker / OpenShell。
   本設計が採っているのはこの系統 (Cloud Run コンテナ + UID 分離、[session-runtime.md](../design/session-runtime.md) §6)
2. **pi はホストに置き、ツール実行だけ隔離環境へルーティング** — Gondolin extension
   (`examples/extensions/gondolin/`)。read/write/edit/bash/grep/find/ls を micro-VM に委譲し、
   ホスト cwd を /workspace としてマウント。**§6 の将来パス (b) はこの extension が
   そのまま部品になる** — Runner と pi の同居を保ったままツール実行だけ VM に出せる
   (ただし要 QEMU で、Cloud Run 上では動かない。実行専用 VM ホストが要る)

より細かい制御の seam が 3 つ:

- **`tool_call` イベントでの block** (`examples/extensions/permission-gate.ts`):
  extension が tool 実行前に `{ block: true, reason }` を返せる。危険コマンドの
  パターンブロックを reply extension と並ぶ常時注入 extension として足せる。
  非対話モード (`ctx.hasUI === false`) では block by default にする書き方も例にある
- **BashSpawnHook** (`src/core/tools/bash.ts:133-143`): bash の spawn 直前に
  command / cwd / env を書き換えられる。コマンドを sandbox ラッパーで包む、
  env をさらに絞る、cwd を workdir 外に出さない等に使える
- **ツール allowlist**: `--exclude-tools write,edit` で調査専用 (読み取り + bash) の
  プロファイルを作れる。ただし bash が残る限り書き込みは可能なので、
  事故防止 (誤編集の抑止) の効果に留まる

## bash tool の挙動とコマンド allowlist

bash tool の実装 (`src/core/tools/bash.ts`):

- 入力スキーマは `{ command: string, timeout?: number }` (timeout は秒、**既定なし**)
- shell (`shellPath` 設定、既定はシステムの bash/sh) 経由で spawn。cwd は pi の cwd、
  env は shell env + BashSpawnHook の書き換え結果
- timeout 超過で kill、出力は行数/バイト数上限で truncate
- **コマンドの allowlist / denylist / 確認プロンプトはビルトインに無い**。
  `docs/security.md` が「No Built-in Sandbox」を明言: 部分的な in-process sandbox は
  誤解を招くので意図的に持たず、隔離は OS / コンテナ境界でやれ、という立場

deny-all + ホワイトリスト許可の実現手段は 2 段階ある:

1. **bash を残して tool_call でフィルタ** — extension の `tool_call` イベントは
   `{ block: true, reason }` で拒否でき、さらに `event.input` は **mutable** なので
   コマンドの書き換え (sandbox ラッパーで包む等) もできる。permission-gate 例の
   逆 (許可パターン以外を全 block) を書けばホワイトリストになる。
   **ただしシェル文字列の許可判定は本質的に穴が出る** (`;` / `&&` / `|` /
   `$(...)` / バッククォート / `xargs` / `sh -c` 等の合成・置換)。
   事故防止には有効だが、敵対的入力への境界にはならない
2. **bash 自体を外して専用ツールに置換** — `--exclude-tools bash,write,edit` で消し、
   `registerTool` で狭いツール (例: `gcloud_logging_read(query, period)`) を提供する。
   引数レベルで制約できるので、これが厳密な意味でのホワイトリスト。
   その代わり調査の自由度は大きく下がる

補助の seam: BashSpawnHook (spawn 直前の command/cwd/env 書き換え) と
settings の `shellCommandPrefix` (全コマンドへの前置) はラッパー注入に使える。

## リーズナブルな sandbox レイヤ案 (bridge の spawn 点に差し込むもの)

bridge は pi を subprocess で spawn するため、spawn の一点が sandbox の
差し込み口になる。「多少の漏れは許容」前提で Cloud Run 内で積めるレイヤ:

| 案 | 効く範囲 | 漏れ | コスト / 検証 |
|---|---|---|---|
| Node Permission Model (`node --permission --allow-fs-read=<workdir>,... --allow-fs-write=<workdir> --allow-child-process` で pi を起動) | JS 実装ツール (read/write/edit/grep) の fs アクセス | bash の子プロセスには効かない (uid/perms が受ける) | spawn 引数のみ。確実に動く |
| Landlock ランチャー (landrun 等で fs ルールを課して exec) | **子プロセス含む全 fs アクセス** (bash にも強制継承)。unprivileged で CAP 不要 | ルールの粒度はパス単位。network 制限 (port 単位) は ADC が metadata:80 を使うため単純には使えない | Cloud Run gen2 カーネルの Landlock LSM 有効性が**要検証** (Step 6 候補) |
| アプリ層の網 (tool_call denylist + BashSpawnHook で cwd 固定・env 再スクラブ) | bash コマンドのパターン | シェル文字列パースの穴は残る (事故防止用) | extension 1 ファイル |

namespace 系 (bubblewrap / nsjail / unshare / chroot) は CAP_SYS_ADMIN や
unprivileged userns が無い Cloud Run では動かない見込み。ローカル開発や
将来の VM ホストでは有効なので、そちら向けの選択肢として温存する。

推奨の積み方: 初期版 = 既設計 (uid 分離 + 0700 + env allowlist) +
Node Permission Model + アプリ層の網。Landlock は Step 6 で検証し、
通ればランチャーを挟むだけなので後付けする。

## SDK (ライブラリ利用)

`docs/sdk.md`: pi は SDK として組み込める。`createAgentSession()` →
`session.prompt()` / `steer()` / `followUp()` / `subscribe()` が型付きで使え、
`SessionManager.inMemory()` でファイル無しのセッションも作れる。
ツールは Operations インタフェース (`createBashTool(operations)` 等,
`src/core/tools/index.ts`) の差し替えで実行先を変えられる — Gondolin extension は
この機構でツールだけ micro-VM に委譲している。

ただし in-process 化は隔離にならない: Node の vm / ShadowRealm は安全境界でなく、
Permission Model はプロセス全体に効くため「pi のコードだけ絞る」ことは不可。
bash はどのみち OS サブプロセスなので、境界はプロセスレベルに置くしかない
(bridge の spawn 維持の判断は [design/README.md](../design/README.md) の
Alternatives Considered を参照)。SDK はテストと将来の
「SDK ループ + リモート Operations」構成の部品として有用。

## 設計への含意

- 初期版は追加実装なし: gcloud 入り拡張イメージ + viewer ロール + 調査 skill で
  GCP アラート調査ユースケースが成立する
- WebSearch extension・tool_call ブロック・調査専用ツールプロファイルは
  いずれも既存の拡張点 (/app/extensions/, spawn 引数) に乗るため後付けできる
