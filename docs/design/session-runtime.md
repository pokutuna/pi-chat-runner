# セッション実行の仕様 — pi の kick・設定の受け渡し・最小イメージ

セッション開始からターン終了までに Runner が pi 子プロセスをどう起動し、
何をどの経路で渡すかの具体仕様。関連: [architecture.md](architecture.md) §6 (起動と steering)、
[config.md](config.md) §4 (コンテナへの与え方)。

## §1 「Image を実行する」の意味 — コンテナは起動しない

単一 Cloud Run サービスでは Runner (app) と pi が同一コンテナに同居している。
「セッションで Image を実行」とは、コンテナを新たに起動することではなく、
**Runner が pi を子プロセスとして spawn すること**。

コンテナ (インスタンス) の起動は Cloud Run のオートスケールに任せており、
セッションとコンテナの対応は M:N。lease ([session-model.md](session-model.md) §4) が「どのインスタンスが
どのセッションを処理するか」を決める。

将来チャンネル特化イメージを導入する場合も、別 Cloud Run サービスへの
HTTP 委譲であり、そのサービスの中では同じ「Runner が pi を spawn」構造が
繰り返される。

インタフェース (擬似コード):

```typescript
// lease 取得済みの前提で呼ばれる。同一セッションはインスタンス内でも直列
interface SessionRuntime {
  run(session: SessionRef, channel: ChannelDoc): Promise<TurnOutcome>;
}
```

kick シーケンス全体:

1. **workdir 準備**: `/tmp/sessions/<threadTs>/` (tmpfs) を作成
2. **restore**: `/data` (GCS FUSE) から transcript と `workspace/` をコピー (無ければ新規セッション)
3. **spawn**: pi を子プロセス起動 (§2 の引数と env)
4. **prompt**: 束ねた入力 (inbox drain 済み) を stdin に JSONL で投入
5. **イベントループ**: stdout の RPC イベントを購読 (reply → Slack 投稿、agent_end → idle 判定)。並行して inbox ポーリング (§4)
6. **flush**: ターン終了時に transcript/workspace を `/data` へ書き戻し → 処理済み inbox doc を削除
7. **linger**: 60-120s、2-3s 間隔で inbox ポーリング。追撃が来たら同じ workdir で再 spawn (プロセスは使い捨て)
8. **release**: lease 解放、workdir 破棄

## §2 pi への設定の渡し方 — 3 経路と env の掃除

渡す経路は 3 つだけ。中間の設定ファイル生成はしない:

1. **spawn 引数** — モデル、システムプロンプト、パス類。ChannelDoc の内容はすべてここ
2. **env (明示的に足すものだけ)** — ADC が使う `GOOGLE_CLOUD_PROJECT` 等と `PATH`/`HOME`、
   および agent.yaml の `agent.env` に列挙したものだけを渡す (process.env 丸ごとの継承はしない)
3. **ファイル** — workdir 内の transcript (restore 済み)、`$AGENT_HOME/.pi/agent/skills/` (イメージ焼き込み)

spawn の擬似コード:

```typescript
const nodeFlags = permissionMode
  ? [
      "--permission",
      "--allow-fs-read=...",
      "--allow-fs-write=...",
      "--allow-child-process",
      "--allow-net",
    ]
  : [];
const pi = spawn("node", [
  ...nodeFlags,
  resolvePiPaths().entrypoint,
  "--mode", "rpc",
  "--session", `${workdir}/session.jsonl`,
  "--model", channel.model,   // "provider/model-id[:thinking]" 形式 (config.md §2.3)。未指定なら渡さない (pi 既定)
                              // google-vertex のときだけ --api-key gcp-vertex-credentials を併せて渡す (ADC marker)
  "--append-system-prompt", buildPrompt(channel),  // app 共通 + ChannelDoc.systemPrompt
  "--extension", "/app/extensions/reply.ts",
  "--extension", "/app/extensions/export.ts",
], {
  cwd: workdir,
  env: {                       // 全継承しない。allowlist で掃除
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
    PI_EXPORT_ENTRYPOINT: resolvePiPaths().entrypoint,  // export extension が孫プロセス起動に使う (§2.1)
    // SLACK_BOT_TOKEN 等は渡さない (下記)
  },
});
```

**reply tool に接続設定は要らない** (これがこの結線の要点)。reply の execute は
引数を result に詰めて返すだけで Slack を叩かない ([chat-model.md](chat-model.md) §5.6)。Slack への実投稿は
同一プロセス内のホスト (Runner) が `tool_execution_end` イベントを拾って行い、
WebClient・token・thread_key→thread_ts の Map はすべてホスト側にある。つまり
**pi 子プロセスには秘匿値がひとつも渡らない**。

**env を allowlist にする理由**: pi の bash ツールでエージェントは `env` を
実行できる。process.env を丸ごと継承すると SLACK_BOT_TOKEN や signing secret が
エージェント (とその会話ログ) から見えてしまう。LLM 認証は ADC (メタデータサーバー)
なのでキーは env にすら存在しない。

代替案の比較表 (検討して不要になったもの):

| 案 | 判断 | 理由 |
|---|---|---|
| secret をファイルに書いて workdir にマウント | 不要 | pi 側に秘匿値を要するコンポーネントが無い。ファイルは bash ツールから読める点で env と同じ露出 |
| env を丸ごと継承 | しない | 上記の通りエージェントから見える |
| token を spawn 引数で渡す | しない | ps や /proc から見える。そもそも渡す必要が無い |
| 将来 extension が外部 API キーを要する場合 | その時に | Cloud Run `--set-secrets` で受け、allowlist に**そのキーだけ**明示的に足す (per-key の判断を強制する) |

### ユーザー CLI のための env 追加 (agent.env)

利用者が拡張イメージに CLI を追加すると token が必要になる場合がある
(例: gh に GH_TOKEN)。宣言的な穴あけとして: agent.yaml ([config.md](config.md) §6) の
`agent.env` に**名前=値**で明示列挙したものだけを、コード既定 (gcpEnv 等) に
足す形で pi へ渡す (足し算モデル)。値には `${env.X}` / `${env.X:-default}` で
デプロイ時に `--set-secrets` 等で渡した環境変数を参照できる (例: `agent.env` に
`GH_TOKEN: ${env.GH_TOKEN}`)。

旧 allowlist (env に値を載せ、agent.yaml に列挙された名前だけを process.env
から選んで継承する引き算モデル) は廃止した。ここに明示しない限り漏れないため、
`SLACK_` / `BRIDGE_` など bridge 予約 prefix の拒否や env 側 override
(`PI_ENV_PASSTHROUGH` 等) の仕組みは無い。

secret の値そのものは Secret Manager にのみ存在し、service.yaml に書かれるのは
参照、agent.yaml に書かれるのは名前と `${env.X}` 参照だけ。ChannelDoc には
一切置かない ([config.md](config.md) §5)。穴あけの名前リストが git レビュー対象の
設定リポジトリに載るため、「いつ誰がどの env を pi に通したか」は git 履歴で追える。

### §2.1 export tool — 孫プロセス起動でセッションを HTML 化する

`extensions/export.ts` は `export_session` ツールを登録する。reply と違い
Slack には触らないため、reply のような「ホストが RPC イベントを拾って
代行する」結線にする理由が無い: **execute がそのまま同期的に完了して
結果 (HTML の絶対パス) を返す**。エージェントはそのパスをどう使うかを
自分で選べる (reply の `files` に添付する、workdir に残すだけにする等)。
reply の `files` は workdir 相対パスを想定しているが、解決側
(`SessionRunner.resolveReplyFiles`) は `path.resolve(workdirReal, file)` を使うため、
workdir 内の絶対パスを渡しても同じ結果になり、そのまま渡して問題ない。

pi の extension サンドボックス (`ExtensionContext`) はセッションの読み取り
専用ビュー (`sessionManager`) しか持たず、`AgentSession.exportToHtml` を
直接呼べない (`AgentSession` インスタンス自体が extension に露出しない)。
そのため `pi.exec()` で `pi --export <session.jsonl> <out.html>` を孫プロセス
として起動し、その完了を `await` してから絶対パスを返す。呼び出し側 (agent)
から見れば tool 呼び出しは完全に同期的。

**この孫プロセスは Permission Model の外側で動く** (spawn する `pi` 本体プロセス
自身は `--permission ...` 下でも、`pi.exec` が起動する孫は素の node 実行)。
`export_session` が安全なのは **parameters を空 (`Type.Object({})`) に保ち、
読み書きするパス (`sessionPath`/`outPath`) を常に `ctx.cwd` (workdir) 由来に
固定している**ため — エージェント入力由来のパスをひとつでも受け取ると
任意ファイル読み書きの穴になる。将来パラメータを足す変更は、この不変条件を
崩さないか確認すること。

呼び出しに要る pi 本体のエントリポイント (`dist/cli.js` の絶対パス) は
`PI_EXPORT_ENTRYPOINT` env でホストから渡す (§2 の env allowlist の一部。
`server.ts` の `resolvePiPaths()` が Permission Model 用の値と共通で解決する)。

reply/permission-gate と同じく `extensionPaths` に常時注入するが、
安全上外せない reply/permission-gate とは性質が違う: export は標準機能
としての注入であり、将来チャンネル単位で有効/無効を選べるようにする
余地は残っている (現時点ではその設定経路は無い)。

### 既定 settings.json の焼き込み (home/)

pi の設定は `~/.pi/agent/settings.json` (global) と `.pi/settings.json`
(project) の 2 層 (docs/research/pi-config.md)。base image は
`home/.pi/agent/settings.json` を `/home/agent/.pi/agent/settings.json`
(pi の HOME、uid/gid 1001) に焼き込む。JSON にはコメントが書けないため
理由をここにまとめる。runner の設計が依存する挙動のピン留めだけの最小構成:

| キー | 値 | 理由 |
|---|---|---|
| `steeringMode` | `"one-at-a-time"` | pi の既定と同じ。inbox 配達 (§4) が steer/follow_up の 2 段キューの挙動に依存しているため、既定変更に備えて明示的にピン留めする |
| `followUpMode` | `"one-at-a-time"` | 同上 |
| `compaction.enabled` | `true` | pi の既定と同じ。auto-compaction に任せる設計 (docs/research/pi-config.md 含意 1) をそのまま反映する |
| `enableInstallTelemetry` | `false` | spawn 時に常時付与する `--offline` (src/session/runtime.ts) と二重の保険。`--offline` が外れても telemetry だけは黙らせる |

利用側は `FROM` 1 段でこのファイルを自由に上書きできる (skill/extension と同じ
「固定パスに置けば効く」規約、§5):

```dockerfile
FROM ghcr.io/<org>/<base-image>:latest
COPY --chown=1001:1001 my-settings.json /home/agent/.pi/agent/settings.json
```

COPY はファイル単位の置き換えなので、このファイルの既定と merge はされない —
残したいキーは自分の settings.json にも書き写すこと。

## §3 Store の受け渡しと再開 — tmpfs で走らせ、境界で flush

パス規約:

| パス | 実体 | 役割 |
|---|---|---|
| `<workdirRoot>/<channelId>/<threadTs>/` | tmpfs (インスタンスローカル) | workdir。pi の cwd。使い捨て (session.mode: thread) |
| `<workdirRoot>/<channelId>/channel/` | tmpfs (インスタンスローカル) | workdir。session.mode: channel の workdir はスレッドでなくチャンネル単位 ([session-model.md](session-model.md) §3) |
| `<workdirRoot>/<channelId>/shared/` | tmpfs (インスタンスローカル) | チャンネル共有ディレクトリの staging。agent からは cwd 相対 `../shared/` ([shared.md](shared.md)) |
| `<workdir>/session.jsonl` | tmpfs | `--session` で pi に渡す。ターン中はここに追記される |
| `<workdir>/workspace/` | tmpfs | 再開に必要な作業ファイル |
| `/data/channels/<ch>/<threadTs>/` | GCS FUSE | 保存棚。session-g\<N\>.jsonl / workspace/ / artifacts/ |
| `<SHARED_DIR>/<channelId>/` | GCS FUSE (本番) | shared の保存棚。SHARED_DIR 未設定なら shared 機能ごと無効 ([shared.md](shared.md)) |

**pi に FUSE パスを直接書かせない**。GCS FUSE は close 時にオブジェクト全体を
アップロードする一方、pi は追記型でファイルを頻繁に開閉するため、書き込み
増幅が起きる。tmpfs で走らせてターン境界で `/data` へ書き戻す ([architecture.md](architecture.md) §3 の
「1 ターン 1 フラッシュ」) が、pi の「プロセスは使い捨て、状態はファイル」
設計とも合う。

flush の順序が重要: transcript の書き戻し成功 → その後に処理済み inbox doc を
削除。逆にするとクラッシュ時に入力が消える。

**再開は専用フローを持たない**: 「sessions doc が既存で lease が無い」状態への
通常の kick シーケンスがそのまま再開。restore (手順 2) で前回の transcript が
workdir に戻り、pi が `--session` で JSONL を読んで文脈を導出する。compaction
による世代回転は session-g\<N\> のファイル名で表現 ([session-model.md](session-model.md) §2)。

クラッシュ時: flush 前に死んだターンの入力は inbox に残っている → 次の lease
保持者が同じ入力から再実行 (at-least-once)。その再実行で同じ reply が再度
呼ばれる可能性は残余リスクとして [architecture.md](architecture.md) §6 の通り。

## §4 追加メッセージの受け渡し — イベント駆動の push で配達

実装 (`SessionRunner.handle`) はポーリングではなく **push 型**: 新規イベントの
受信そのものが配達のきっかけになる。実行中セッションがあるレーンにイベントが
来たら、inbox に enqueue した上でその場で drain し、未 prompt の item を即座に
`process.steer()` で子プロセスの stdin へ書き込む。ホストが一定間隔で inbox を
見に行くタイマーは存在しない。

```typescript
// SessionRunner.handle (実行中セッションがあるレーン)
const fresh = await this.store.inbox.enqueue(sessionKey, item);
if (!fresh) return; // 重複 (dedupe)
if (existing.state === "running" && existing.process?.running) {
  const items = await this.store.inbox.drain(sessionKey);
  const pending = items.filter((i) => !existing.promptedIds.has(i.id));
  if (pending.length > 0) {
    for (const p of pending) existing.promptedIds.add(p.id);
    existing.process.steer(renderItems(pending));
  }
}
```

**注入タイミングは pi が管理する**: steer は「次の LLM 呼び出しの前」
(ステップ境界 = ツール実行の合間) に pi 内部の 2 段キューが処理する。ホストは
steer を呼ぶだけで、ステップ境界の検出は不要。

realtime リスナ (onSnapshot) を使わない判断 ([session-model.md](session-model.md) §4) は不変だが、その代替は
「一定間隔ポーリング」ではなく「イベント受信を起点にした即時 drain」である。
Firestore を「耐久キューとしてだけ使う」という位置づけは変わらない。

**プロセス跨ぎ・取りこぼしのカバレッジ**: enqueue した item は ack されるまで
inbox に残り続ける。即時配達に失敗しても (実行中セッションが無い・starting
中・プロセスがクラッシュした等)、次のいずれかの drain が拾い直す:

- `handle` 自身の次呼び出し (実行中セッションありレーンの steer パス)
- `kick` の初回 drain (starting 中に積まれた item を含めて束ねる)
- `onAgentEnd` の `promptPending` (ターン完了時の drain)
- `onAgentEnd` の linger 満了直前の再 drain (§3 の agent_end 後の追いメッセージ拾い直し)

処理済み inbox item の削除 (ack) はターンの flush 後 (§3)。drain 自体は
非破壊なので、重複除外は Runner のインメモリ `promptedIds` で行う。

idle 判定: agent_end 受信 + inbox 空 + バックグラウンド作業なし → linger へ。

## §5 最小コンテナイメージ

base イメージ (この基盤 npm パッケージが公開する):

```dockerfile
FROM node:26-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates jq ripgrep fd-find \
  &&  rm -rf /var/lib/apt/lists/* \
  &&  ln -s "$(command -v fdfind)" /usr/local/bin/fd
RUN npm install -g @earendil-works/pi-coding-agent
COPY dist/ /app/                     # Runner 本体 + reply extension
CMD ["node", "/app/server.js"]
```

選定基準: **pi の bash ツールから使う「調査の基本セット」だけ** (git / curl / jq /
ripgrep / fd)。言語ランタイムやビルドツールは入れない — 必要なチャンネルが
現れたら利用側の拡張 (下記) で足す。イメージが小さいほどコールドスタート
(min-instances=0) が速い。

**そのまま動くものを同梱**: この npm パッケージのリポジトリに、上記
Dockerfile・サンプル skill・サンプル channels/*.yaml を含め、`docker build` +
デプロイだけで #ask-ai 相当 (mention 起動の汎用アシスタント) が動く状態を
初期版のゴールにする。

**利用者の拡張は FROM 1 段だけ**。フックポイントは Dockerfile の慣行に乗る:

```dockerfile
FROM ghcr.io/<org>/<base-image>:latest
# 1. 追加パッケージ (このチャンネル群に要る CLI)
RUN apt-get update && apt-get install -y kubectl google-cloud-cli \
  && rm -rf /var/lib/apt/lists/*
# 2. 共通 skill (pi 既定パス規約: $AGENT_HOME/.pi/agent/skills/。全チャンネルで有効)
COPY --chown=1001:1001 skills/ /home/agent/.pi/agent/skills/
# 3. 共通 extension ($AGENT_HOME/.pi/agent/extensions/ 直下の .ts/.js を Runner が注入)
COPY --chown=1001:1001 extensions/ /home/agent/.pi/agent/extensions/
# 4. チャンネル別 skill / extension: 自動発見されないパス (例 /app/skills/) に焼き、
#    agent.yaml の channels (skills / extensions) からパスで参照する (config.md §2)
COPY --chown=1001:1001 channel-skills/ /app/skills/
```

規約は「`$AGENT_HOME/.pi/agent/skills|extensions/` に置けば全チャンネル共通で有効
(config.md §3)」「チャンネル別はそれ以外の場所に焼いて channels の `skills` /
`extensions` でパス参照 (config.md §2)」の 2 つだけ。これらに加え、SHARED_DIR
有効時は agent 自身が書ける第 3 の skill 経路として `../shared/skills/` が
`--skill` に自動配線される (イメージ焼き込みではなく実行時の蓄積。[shared.md](shared.md) §4)。ONBUILD や独自のビルドステージ機構は導入しない —
暗黙の動作は Dockerfile を読んでも分からず、デバッグを難しくする。
`npx <cli> init` が上記テンプレート Dockerfile と channels/ の雛形を生成する
(scaffold) ことで「書き方が分からない」問題の方を解決する。

## §6 pi の隔離 — 同居コンテナ内の境界

前提: pi の bash ツールでエージェントは任意コマンドを実行できる。Runner と
pi が同一コンテナに同居する以上、「何が見えるか」を経路ごとに設計する。

| 守る対象 | 漏れる経路 | 対策 |
|---|---|---|
| Runner の env (SLACK_BOT_TOKEN 等) | 子プロセスへの env 継承、同一 UID なら /proc/<pid>/environ | env allowlist (§2) に加えて **UID 分離**: pi を別ユーザー (agent, uid 1001) で spawn。別 UID の environ は読めない |
| /data 全体 (全チャンネル・全セッションの transcript / artifacts) | GCS FUSE マウントはコンテナ全体から見える | **pi に /data を見せない**: FUSE を uid=runner, dir-mode=0700 でマウントし agent uid は traverse 不可。pi が触るのは workdir へのコピーだけ (restore/flush はホストの仕事) — §3 の tmpfs 設計がそのまま隔離境界になる |
| 同一インスタンス上の他セッションの workdir | concurrency>1 で同居 | workdir をセッションごと 0700。初期版は全 pi が同一 agent uid のため同 uid 間は読める (**残余リスク**)。問題化したら per-session uid (uid = base + hash(threadTs)) か concurrency=1 |
| メタデータサーバー (実行 SA のトークン) | curl metadata.google.internal | **コンテナ内では防げない** (ネットワーク名前空間の分離は Cloud Run では不可)。SA のロールを最小化 (Vertex AI + 必要最小の Firestore/GCS) して影響半径を絞る。エージェントが SA トークンで Firestore/GCS に直接触れる可能性は**明記して受容** |
| Runner のコード /app | 読める | 秘密が無いので read-only で問題なし。書き換えは root 所有 + agent に書き込み権限なしで防ぐ |

実装の要点:

- コンテナは root で起動し、Runner が spawn 時に { uid: 1001, gid: 1001 } へ落とす (Node の spawn オプション)。workdir は agent 所有 0700 で作成
- ターンにタイムアウトを設け、超過したら pi を kill (プロセス使い捨て設計なので kill してよい。inbox の入力は残るため再実行可能)
- ulimit (プロセス数・ファイルディスクリプタ) を spawn 時に設定
- Node Permission Model (`PI_PERMISSION_MODE=1` で opt-in) を有効化すると、pi 本体を `node --permission --allow-fs-read=... --allow-fs-write=... --allow-child-process <pi の cli.js>` 経由で起動し、pi の JS 実装ツール (read/write/edit/grep) の fs アクセスを workdir・agent HOME・node_modules・/app に制限する (pi-tools-and-sandbox.md 「リーズナブルな sandbox レイヤ案」)。bash の子プロセスの fs アクセスには効かない (そこは上記の uid 分離が担う) が、多層防御の一層として機能する
  - native addon (.node) は syscall を直接叩けるため Permission Model 下では既定でロード自体が拒否される。native 依存を持つ npm extension (例: pi-smart-fetch の wreq-js) を使うときだけ `agent.runtime.allowAddons: true` (env `PI_ALLOW_ADDONS`) で `--allow-addons` を足す opt-in。有効化すると native code はこのレイヤの fs チェックを素通りできるため、そのぶん隔離が弱まる (uid 分離は残る) ことを踏まえて必要な場合のみ使う (config.md §6)
- `extensions/permission-gate.ts` を reply extension と同様に常時注入し、bash tool の `tool_call` を denylist (apt/npm -g/pip install 等のパッケージ変更、`rm -rf /`、workdir 外の chmod/chown、`kill -9 1`) に照らして block する。素朴な正規表現判定なのでシェル合成・置換による回避は防げず、事故防止層と位置づける (pi-tools-and-sandbox.md)

初期版の隔離は「悪意あるプロンプトインジェクションへの完全なサンドボックス」
ではなく「**事故と覗き見の防止 + 影響半径の最小化**」。メタデータサーバー
経路が示す通り、同居構成の隔離には上限がある。

ハード隔離が要る運用になったときの将来パスは 2 つ: (a) 実行専用 Cloud Run
サービスへの委譲 (別 SA・別バケットで権限を断つ)、(b) pi-chat と同じ
microVM (Gondolin) 方式。どちらも「必要になったら昇格」([architecture.md](architecture.md) §9 の復元パス
の思想) に従う。

昇格時の差し替え点は §1 の kick (SessionRuntime): 「同一コンテナ内 spawn」を
「別の agent 実行コンテナの起動 + stdin/stdout RPC 相当のブリッジ」に
差し替えても、Runner 側の制御フロー (lease → restore → prompt → イベント
ループ → flush) と inbox / reply の配線は変わらない。初期版でこの境界を
インタフェースとして保っておくことが昇格の準備になる。
