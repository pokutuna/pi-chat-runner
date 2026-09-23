# Runtime — Agent の実行環境

Runtime は Workdir、環境変数、Channel の設定に応じた Skill やツールを Agent から利用
できる状態にし、Agent を子プロセスとして起動する。Agent 自体は作らず、pi に渡す引数と
ファイルシステムを整えることだけを行う。

関連: [state.md](state.md) (Agent State の archive と staging)、
[message-dispatch.md](message-dispatch.md) (Turn 境界の制御)、
[config.md](config.md) (Agent Config の項目)。

## 1. 責務の範囲

Runtime が行うのは次の 4 つに限る。

1. Workdir と Shared staging を Agent State から復元し、Agent が書ける状態にする
2. Agent Config からシステムプロンプト・Skill・ツール・環境変数を組み立てる
3. Agent を別 UID の子プロセスとして起動し、読み書きできるパスを制限する
4. 子プロセスとの RPC を仲介し、reply とイベントを Runner 側へ渡す

Runtime は Control State を読み書きしない。明示的な新規 Session 要求のマーカーのような
Control State 上の値は Dispatcher が読み、クリアも Dispatcher が行う。Runtime はその
結果 (Transcript を世代交代させるかどうか) を引数として受け取る。

Agent プロセスは使い捨てである。Session の再開に専用のフローはなく、同じ Workdir の
同じ Transcript ファイルを指して起動し直すだけで pi が文脈を導出する。

## 2. 起動準備の順序

副作用の順序に意味があるため、次の順で行う。

1. **mkdir** — Workdir を作る
2. **Workdir restore** — archive から Transcript と作業ファイルを復元する ([state.md](state.md))
3. **Shared restore** — `<staging>/skills/` を mkdir してから archive を復元する。skills/ は
   空でも常に作る — pi の `--skill` は空ディレクトリを黙って無視するので無条件に配線
   でき、Agent は mkdir なしで skill を置ける
4. **Transcript の世代交代** — 下記の優先順位で最大 1 回
5. **chown / chmod** — UID 分離が有効なら Workdir と staging を Agent 所有 0700 にする
6. **agentHome** — 存在しなければ作る。Runner が新規作成したときだけ chown / chmod する
7. **realpath** — Workdir・agentHome・staging を正規化する

### 2.1 Transcript の世代交代

Transcript を `session.jsonl` から `session-<epoch ms>.jsonl` へ rename する。pi は
Transcript が無ければ新規の会話として開始するため、これが「同じ Workdir で新しい
Session を始める」操作になる。Workdir の他のファイルは残す。

| 優先度 | 契機 | 条件 |
|---|---|---|
| 1 | 明示的な要求 (`rotateRequestedAt`) | Session のモードに依存せず常に効く |
| 2 | idle 超過 | Channel 全体を 1 つの Session にするモードのみ |
| 3 | Transcript のサイズ超過 | 同上 |

明示的な要求だけがモードに依存しないのは、ユーザーの意図が明示されているためである。
idle とサイズは Thread ごとに Session を作る場合には Thread の切れ目が自然な区切りに
なるため評価しない。

chown より前に世代交代するのは、rename されたファイルの所有権も chown で揃うためである。

### 2.2 realpath 正規化

pi は cwd を canonicalize してから trust probe と migration の存在チェックを行う。
macOS では `/tmp` が `/private/tmp` への symlink のため、allow パス・cwd・HOME を
realpath で正規化して渡さないと Permission Model の判定と食い違い、pi が起動直後に
落ちる。Linux では通常 no-op になる。

## 3. pi の起動引数

中間の設定ファイルは生成しない。Agent Config の内容はすべて起動引数で渡す。

```
node [<permission flags>] <pi entrypoint>
  --mode rpc
  --session <workdir>/session.jsonl
  --offline
  --extension <path>          … 複数回
  [--model <provider/model-id[:thinking]>]
  [--api-key <ADC marker>]
  [--append-system-prompt <text>]
  [--skill <path>]            … 複数回
  [--tools <csv>]
  [--exclude-tools <csv>]
```

- `--offline` は常に付ける。pi は起動時にバージョンチェックと install telemetry の外部
  通信を行うが、メッセージごとに起動する構成ではその都度の通信が無駄でコールドスタート
  の遅延になる。LLM 呼び出しには影響しない。
- `--model` は `provider/model-id[:thinking-level]` の shorthand をそのまま渡す。
  provider の推論と thinking level のパースは pi に委ねる。未指定なら渡さず pi の設定に
  従う。
- ADC で認証する provider (google-vertex) のときだけ `--api-key` に marker 文字列を
  添える。pi の認証可否判定が「ADC ファイルの存在チェック」であるため、ファイルを作らない
  メタデータサーバー ADC ではこの marker が必要になる。marker は provider 側で捨てられ、
  実認証は ADC 経路で行われる。secret ではない。
- **reply は常に tools に含め、exclude から外す**。`--tools` は extension のツールにも
  効くため、allowlist を指定する Channel でも reply が落ちると返信経路そのものが壊れる。
  `--tools` に reply が無ければ黙って補い、`--exclude-tools` に reply が書かれていても
  無視する。`--tools` が未指定または空なら、フラグ自体を渡さない (全ツール有効)。

## 4. Extension と Skill

### 4.1 組み込み extension

常に注入する 3 つ。プラットフォームに依存しないため Runtime 自身が解決する。

| extension | 役割 |
|---|---|
| `reply` | `reply(thread_key, text, files?)` ツールを登録する。execute は引数を result に詰めて返すだけで、チャットには触らない |
| `permission-gate` | bash tool の `tool_call` を denylist に照らして block する事故防止層 |
| `export` | `export_session` ツールを登録し、現在の Transcript を HTML 化して絶対パスを返す |

**reply に接続設定は要らない**。実際の送信は同一プロセス内の Runner が
`tool_execution_end` を拾って行い、認証情報と送信先の解決はすべて Runner 側にある。
つまり Agent の子プロセスには秘匿値が 1 つも渡らない。

`permission-gate` の判定は素朴な正規表現なので、シェルの合成や置換による回避は防げない。
弾きたいのは悪意ある入力ではなく「Agent が素直に打ってしまうコマンド」— 実行時の
パッケージインストール、ルート直下の削除、Runner プロセスへの kill — であり、事故防止層
として位置づける。

`export` は Runner を経由せず execute の中で完結する。pi の extension コンテキストからは
セッションのエクスポートを直接呼べないため、`pi --export` を孫プロセスとして起動して
完了を待つ。この孫プロセスは Permission Model の外側で動くので、**パラメータを空に保ち、
読み書きするパスを常に cwd 由来に固定する**ことが安全の根拠になる。Agent 入力由来の
パスを 1 つでも受け取ると任意ファイル読み書きの穴になる。

### 4.2 自動で拾う extension

`$AGENT_HOME/.pi/agent/extensions/` 直下の `.ts` / `.js` を列挙して `--extension` に
足す。pi の `--extension` はディレクトリを受け付けないため、個別のファイルとして渡す。
ディレクトリが無ければ何も足さない。利用者が拡張イメージに焼き込んだ全 Channel 共通の
extension の口である。

### 4.3 Skill の 3 経路

| 経路 | 場所 | 有効範囲 |
|---|---|---|
| イメージ焼き込み (共通) | `$AGENT_HOME/.pi/agent/skills/` | 全 Channel。pi の HOME 自動発見に乗る |
| イメージ焼き込み (Channel 別) | Agent Config の `skills` が指すパス | 指定した Channel のみ |
| Agent が書いた skill | `../shared/skills/` | その Channel のみ。次の Session から自動でロードされる |

Channel 別の skill / extension のパスは、絶対パスか設定ファイルからの `./` `../` 相対で
書く。相対は設定の読み込み時に絶対化する。実在しないパスは設定ミスとして起動を落とす —
黙って無効のまま動くと「skill が効かない」の調査が難しくなる。extension は `--extension`
がディレクトリを受けないため、拡張子が JS モジュールであることも確認する。

### 4.4 組み込み memory skill

Channel の記憶を Shared に蓄積・想起するための組み込み skill。Shared が有効かつ Agent
Config で無効化されていないときに `--skill` へ足す。Shared が無効なら書き先の
`../shared/` が無いため配線しない。

この skill はパッケージ直下の `builtin-skills/memory/` に置き、`$AGENT_HOME/.pi/agent/
skills/` には**置かない** — あちらは pi の HOME 自動発見で全 Channel に常時ロードされる
口なので、置くと Channel ごとの opt-out が効かなくなる。

索引 `MEMORY.md` はシステムプロンプトに注入し (§6)、本文ファイルは skill の判断で
オンデマンドに読ませる。索引の注入も skill の配線と同じ条件で on / off する。

## 5. Agent の隔離

Agent は bash tool で任意のコマンドを実行できる。Runner と同一のコンテナに同居する以上、
「何が見えるか」を経路ごとに設計する。

| 守る対象 | 漏れる経路 | 対策 |
|---|---|---|
| Runner の環境変数 (チャットのトークン等) | 子プロセスへの env 継承、同一 UID なら `/proc/<pid>/environ` | env allowlist (§5.3) + UID 分離 |
| Agent State の archive (全 Channel・全 Session 分) | マウントはコンテナ全体から見える | archive を Runner の UID・0700 で持ち、Agent には traverse させない。Agent が触るのは staging のコピーだけ |
| 同一インスタンス上の他 Session の Workdir | 並行実行で同居する | Workdir を Session ごとに 0700 |
| Runner のコード | 読める | 秘密が無いので読めてよい。書き換えは所有権で防ぐ |
| 外部ネットワーク (データ持ち出し・許可外 API) | bash tool から任意の宛先へ接続できる | srt の netns + FQDN allowlist (§5.5)。opt-in |

### 5.1 UID 分離

コンテナは root で起動し、Runner が spawn 時に Agent 用の UID / GID へ落とす。UID / GID は
指定されたときだけ spawn オプションに渡す — キーを渡して値を undefined にすると Node は
継承ではなく「明示的に変更なし」として別に扱うためである。

Workdir と Shared staging は Runner (root) が作成・復元するので root 所有のまま残る。
Agent が書けるよう、restore の後に再帰的に chown して 0700 にする。この再帰 chown は
**symlink を辿らずスキップする** — Agent が Workdir 内に archive などへのリンクを仕込み、次の
restore で root の Runner がリンク先を chown して所有権を奪われる経路を防ぐ。

agentHome は「Runner が作ったものだけ chown する」規則にする。`mkdir(recursive)` は新規
作成したときだけ作成したパスを返すので、それを使って新規作成時のみ chown / chmod する。
既存の home には一切触れない — 配下に読み取り専用のマウントがあっても衝突しない。

Turn にはタイムアウトを設け、超過したらプロセスを kill する。プロセスは使い捨てなので
kill してよい。

### 5.2 Node Permission Model

`node --permission` 経由で pi 本体を起動し、pi の JS 実装ツール (read / write / edit /
grep) のファイルアクセスを制限する。bash の子プロセスには効かない (そこは UID 分離と、
有効なら srt (§5.5) が担う) が、多層防御の一層として機能する。既定で有効。srt を重ねた
ときも外さない — srt の filesystem 制限は bind mount (bash の子にも効く) で粒度が粗く、
Permission Model は pi 自身の JS ツールに細かく効く。役割が違うので両方置く。

```
node --permission
     --allow-fs-read=<path>   … パスごとに 1 フラグ
     --allow-fs-write=<path>  … パスごとに 1 フラグ
     --allow-child-process
     --allow-net
     [--allow-addons]
     <pi entrypoint> <pi の引数...>
```

read / write ともに 1 パス 1 フラグで組み立てる。Node 26 でカンマ区切りは deprecated
warning になり機能しない。

`--allow-child-process` は常に付ける。bash tool 自体は UID 分離が守る層なのでここで
止めても意味がなく、付けなければ bash tool の spawn がそもそも動かなくなる。
`--allow-net` も常に付ける。Node 26 の Permission Model はネットワークも既定で拒否し、
fetch が失敗して LLM 呼び出しが不可能になる。このレイヤの目的はファイルアクセスの制限
である。

**allow-fs-read の集合**

| パス | 理由 |
|---|---|
| `<nodeModulesDir>/*` | pi 本体と実行時依存 |
| `<workdir>/*` | cwd |
| `<agentHome>/*` | `~/.pi` の読み書き |
| `<workdir> の全祖先> × <trust probe ファイル名>` | 下記 |
| `/bin/bash`, `/bin/sh` | pi の bash tool がシェル解決で存在チェックする。許可しないとコマンド内容によらず bash tool が全滅する |
| Session 専用の TMPDIR とその配下 | bash の出力が 50KB を超えると pi が `os.tmpdir()` 配下 (`pi-bash-*`) へスピルする。許可しないと書き込みストリームの unhandled error で pi がツール実行中に落ちる。TMPDIR は Session ごとに `<workdirRoot>/<channelId>/tmp/<threadTs>` を作って env で渡す (§5.5) |
| extension 各ファイルの所在ディレクトリ | extension を読ませるため。write は与えない |
| Skill の各ディレクトリと配下 | pi がディレクトリごと再帰で読む。readdir にディレクトリ自体の read も要る |
| Shared staging とその配下 | ls に要る |
| 明示指定された追加パス | ローカルのユーザー ADC (`GOOGLE_APPLICATION_CREDENTIALS`) 等 |

**allow-fs-write の集合**: `<workdir>/*`、`<agentHome>/*`、Session 専用の TMPDIR、Shared
staging の配下、明示指定された追加パス。srt が有効なら、利用者ルールの
`filesystem.allowRead` / `allowWrite` も同じ規則で絶対化して両集合に足す (§5.5)。

**trust probe の直積**が要る理由: pi は起動時に cwd から `/` まで祖先ディレクトリを 1 段
ずつ遡り、プロジェクトの trust 判定と context ファイル探索のために固定のファイル名群を
存在チェックする。この probe は Workdir だけでなく**全ての中間ディレクトリ**で走るため、
祖先すべてについてファイル名との直積を read 許可へ展開する必要がある。1 つでも欠けると
存在チェックが拒否され pi が起動直後に落ちる。`/` や `/*` の一括許可は他ユーザーの
読めるファイルまで開けてしまうため使わない。probe するファイル名は pi のバージョンで
変わるので、pi を上げるときは実プロセスで確認する。

**`nodeModulesDir` は最外殻を採る**。pi の entrypoint は pi パッケージの実体を指すが、
許可すべきは pi の依存を実際に張っている平坦な node_modules ルートである。npm の平坦
構成では両者が一致するが pnpm では食い違い、pi パッケージの直上だけを許可すると pi が
spawn 時に読む依存が拒否されて落ちる。パス上で最も外側に現れる `node_modules` セグメント
までを採れば、どちらのレイアウトでも「全依存を含むルート」に一致する。

**`/app` 全体は読ませない**。extension を読ませるための包括許可は置かず、
`--extension` に渡すファイルの所在ディレクトリだけを個別に read 許可する。

**HOME の固定と ADC**: HOME を agentHome に固定するとローカルのユーザー ADC は HOME
経由で見えなくなる。`GOOGLE_APPLICATION_CREDENTIALS` で明示されたファイルだけを追加の
read 許可として渡す。

**native addon**: `.node` は syscall を直接叩けるため Permission Model 下では既定で
ロード自体が拒否される。native 依存を持つ extension を使うときだけ `--allow-addons` を
opt-in で足す。有効にすると native コードはこのレイヤのファイルチェックを素通りできる
ため、隔離は実質 UID 分離だけになる。

### 5.3 環境変数の allowlist

`process.env` を丸ごと継承せず、`PATH` と `HOME` に明示的に足したものだけを渡す。
`HOME` は常に agentHome へ上書きし (Runner の HOME を継承しない)、`TMPDIR` は Session
専用ディレクトリ (§5.2、§5.5) へ向ける。

丸ごと継承しない理由は、Agent が bash tool で `env` を実行できることにある。継承すると
チャットのトークンや signing secret が Agent と会話ログから見えてしまう。

明示的に足すのは次の 3 種類で、後勝ちで重ねる。

1. LLM provider が読む環境変数 (`GOOGLE_CLOUD_PROJECT` 等)
2. `export` extension が孫プロセス起動に使う pi の entrypoint
3. Agent Config の `env` に名前と値で列挙したもの ([config.md](config.md))

3 は利用者が拡張イメージに追加した CLI のための宣言的な穴あけである。値には環境変数
参照を書けるので、秘密の値そのものは Secret Manager にだけ存在し、設定に載るのは名前と
参照だけになる。穴あけのリストがレビュー対象の設定に載るため、どの環境変数を Agent へ
通したかは履歴で追える。

### 5.4 reply の files の境界チェック

reply の `files` は Workdir 相対パスで受け取り、Runner 側で解決する。Agent は
semi-trusted なので、次の順に落とす。

1. Workdir 基準で解決した結果が Workdir の外に出るもの (`../` によるエスケープ、絶対パス)
2. `lstat` で symlink または通常ファイルでないもの
3. realpath した実体が Workdir の外にあるもの

2 と 3 は「Workdir 内に外部ファイルへの symlink を置いて添付させる」経路を塞ぐ。落とした
パスは warn に残す。全件落ちたらファイルなしの返信として扱う。Shared のファイルは添付
できない — 添付したければ Agent が Workdir へコピーしてから reply する。

### 5.5 srt によるネットワークとファイルシステムの隔離

UID 分離と Permission Model は「Runner のものを見せない」ためのもので、Agent が外へ何を
送るかは制限しない。bash tool から任意の宛先へ接続できる以上、データの持ち出しと許可外
API の利用を止める層が要る。これを srt (`@anthropic-ai/sandbox-runtime`) に任せる。
Linux では bubblewrap で network namespace を切り、外へ出る経路を srt の loopback proxy
だけにし、proxy が FQDN の allowlist で CONNECT を通す・拒む。IP 直打ちや `--noproxy` は
netns の外に出られないので、allowlist を迂回できない。自前の forward proxy や seccomp
ベースの実装は持たない — FQDN で絞るには netns と proxy の 2 層が必須で、それを Runner
に作り込む理由がない。

**opt-in で Channel 単位**。Agent Config の `sandbox` ([config.md](config.md) §1.3、§3.2)
に srt ネイティブ形式のルールを書いたときだけ有効になる。Runner は network に何も足さない
ので、LLM provider の到達先 (Vertex なら oauth2 / aiplatform / metadata server) も利用者の
ルールに書く。書き忘れれば pi 自身の LLM 呼び出しが 403 で落ちるが、それは「何を許したか
がルールファイルに全部載っている」ことの裏面で、Runner が暗黙に穴を開けるより良い。

**srt は CLI として Session ごとに立てる**。起動コマンド全体を
`node <srt>/dist/cli.js --settings <file> -- node --permission ... <pi>` の形で包む。
ライブラリとして Runner に組み込まない — srt の proxy と設定はプロセスグローバルで、
Channel ごとに違うルールを 1 プロセスで並行に持てない。Session ごとに proxy が 1 つ立つ
コストは pi 子プロセス 1 つに比べて無視できる。

**Runner が Session ごとに足すもの**。利用者ルールは Channel の追加分を union した完全形で
届き (config.md §3.2)、Runner はそこへ `filesystem.allowWrite` に書き込み先を足して
settings ファイルにする。

| 足すもの | |
|---|---|
| Workdir | cwd。Session の作業領域 |
| Session 専用の TMPDIR | `<workdirRoot>/<channelId>/tmp/<threadTs>`。起動ごとに作り直し、UID 分離時は Agent 所有 0700。bash tool のスピル先 (§5.2) と srt 自身の mux ソケットがここに入る |
| agentHome | `~/.pi` の読み書き |
| Shared staging | 有効なとき |

srt は sandbox 内の `TMPDIR` を自分の env の `CLAUDE_CODE_TMPDIR` (既定 `/tmp/claude`) で
上書きするので、Runner は `TMPDIR` と `CLAUDE_CODE_TMPDIR` の両方に同じディレクトリを渡す。
両方が揃っていないと pi のスピルが Permission Model の allow 外へ向いて落ちる。srt は
host 側の Unix socket (`srt-mux-*.sock`) もこの TMPDIR に置くため、パス長が Unix socket の
上限 (Linux 108 byte、macOS 104 byte) を超えると srt が `listen EINVAL` で起動できない。
workdirRoot は既定の `/tmp/pi-chat-runner/sessions` のように短く保つ。

settings ファイルは `<workdirRoot>/srt/<sessionKey>.json` — Workdir の外、Runner 所有で、
Agent は読めるが書き換えられない (bind mount が read-only)。Session 終了時に消す。
利用者ルールの `filesystem.allowRead` / `allowWrite` は Permission Model の allow 集合にも
同じ規則 (`~` は HOME、相対は cwd 基準) で写す。srt の read は既定で全許可なので、
「別ディレクトリを読みたい」を実際に満たすのは Permission Model 側であり、fs ポリシーの
書き場所を sandbox ルール 1 箇所にするために両層へ同じ集合を渡す。

**fail-closed**。sandbox が有効な Channel で srt が使えない (対応 OS でない、パッケージが
無い、srt が要求する OS 側の依存や namespace が無い) ときは Session の起動を失敗させ、
sandbox なしで走らせない。Runner は boot 時に全 Channel を解いて sandbox 有効なものが
あれば、srt の所在を確かめた上で最小の settings で trivial なコマンドを 1 回 srt に包ませ、
失敗すれば srt の stderr を出して exit 1 する — 最初のメッセージが来てから気づくより先に
落とす。srt が何を要求するか (Linux なら bubblewrap / socat / ripgrep) の一覧は Runner
には持たせず、srt 自身の検査結果だけを見る。

**対応 OS**。srt は Linux (bubblewrap + network namespace) と macOS (sandbox-exec /
Seatbelt) で動く。本番は Linux で、上記の遮断特性はそちらで検証している。macOS 経路は
手元で実 pi + 実 LLM を sandbox 越しに動かす開発用で、pid namespace が無いなど bwrap と
挙動が違うため、遮断の保証は Linux 側にだけ置く。

**プロセスの後始末**。srt で包むと Runner の直接の子は srt (node) で、その下に `sh -c` →
bwrap → (pid namespace 内の) pi と続く。srt だけを SIGKILL すると `sh` が生き残り、bwrap の
`--die-with-parent` が発火せず pi とその子が残留する。そのため pi 子プロセスは独自の
プロセスグループで spawn し、kill はグループごと SIGKILL する。graceful stop の SIGTERM
は直接の子にだけ送る (srt が自分の子へ転送する)。

**env は境界ではない**。Runner の env allowlist (§5.3) は「Agent に見せる env」を決めるが、
srt の `credentials.envVars` deny は Channel ごとに、allowlist を通った値を sandbox 内で
隠す。用途が違うので両方残す。

**Cloud Run**。bubblewrap は user namespace と `/proc` の mount を要するため、gen1 (gVisor)
では動かず gen2 が要る。ローカルの Docker では `--cap-add SYS_ADMIN` と
`--security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt systempaths=unconfined`
が要る ([local-dev.md](local-dev.md) §1 の `test:e2e:sandbox`)。

## 6. システムプロンプトの組み立て

`--append-system-prompt` に次の順で連結して渡す。

1. **app 共通の指示** — 「応答はチャットのスレッドに届く」「返信は reply tool を通して
   のみ届き、素の assistant テキストは配送されない」「返信が不要なら reply を呼ばない」
2. **mention の記法** — ユーザーは `name (USER_ID)` として現れること、メンションの書き方。
   記法はプラットフォームごとに異なるため Egress 側から渡された関数の出力例を埋め込む
3. **Shared の説明** — Shared が有効なときだけ。`../shared/` が Channel 共有の永続
   ディレクトリであること、`../shared/skills/` に置いた skill が次の Session で自動
   ロードされること。使い方の規約は memory skill 側が持ち、ここではディレクトリの存在と
   性質だけを知らせる
4. **memory の索引** — memory が有効かつ `MEMORY.md` が存在するときだけ、前置きを付けて
   丸ごと注入する。ファイルが無ければ何も足さない
5. **Channel のシステムプロンプト** — Agent Config の `systemPrompt`
6. **Thread Key の選択指示** — 各入力メッセージには Thread Key が注記されていること、
   reply では返信対象のメッセージの Thread Key を使うこと、この Session の fallback
   Thread Key

索引だけをプロンプトへ常時注入するのは、Agent が skill を自発的に読まないことがあるため
である。索引は「1 行 1 メモリ」の短い規約が前提なので、増えてもプロンプトの固定費は
緩やかにしか伸びない。本文まで埋め込むと「記憶が増えてもプロンプトの固定費が増えない」
という利点が失われるため、本文は skill 経由のままにする。

Agent Config の `context` は**最初の prompt の本文にだけ**前置きする。システムプロンプト
ではなくユーザーメッセージ側に乗せるため、Turn を重ねても再送されない。

## 7. RPC

pi を `--mode rpc` で起動し、stdin / stdout の JSONL で対話する。区切りは LF のみとし、
末尾の CR は落とす。行の振り分けは「`type === "response"` なら応答、それ以外はすべて
イベント」という規約に従う。

**送るコマンド**

| コマンド | 用途 |
|---|---|
| `prompt` | Turn を開始する。`streamingBehavior` で steer / followUp を選べる |
| `steer` | 実行中の Turn に追加入力する。次の pi turn 境界 (次の LLM 呼び出し前) で注入される |
| `follow_up` | 現 Turn の完了後に処理させる |
| `abort` | 実行を中断する |

注入のタイミングは pi が管理する。Runner は steer を呼ぶだけで、pi turn 境界の検出は
要らない (pi turn の定義は [session-model.md §7](session-model.md#7-turn))。

**読むイベント**

| イベント | 読み取る情報 |
|---|---|
| `tool_execution_start` | 進捗通知に使うツール名 |
| `tool_execution_end` | reply の引数 (`thread_key` / `text` / `files`)。reply 以外・エラーは無視 |
| `agent_end` | Turn の終端。`willRetry` が true ならこれは終端ではなく、リトライ後にもう一度来る |

`agent_end` の `messages` は毎回全履歴を返すため、usage の集計はターン単位の増分では
なく Session の累計になる。

**Turn の成否は最終 assistant メッセージの `stopReason` の whitelist で判定する。**
`stopReason` は必ず付く 5 値 (stop / length / toolUse / error / aborted) で、`stop` だけ
を ok、それ以外を error とする。LLM 呼び出しが失敗しても pi はそれを
`stopReason: "error"` の assistant メッセージとして「正常に」完走させ `agent_end` を
返すため、whitelist にしないと失敗が ok に紛れ、「成功の印は付くが返信が無い」という
症状だけが残る。assistant メッセージが無い Turn (沈黙の正常終了) は ok とする。

停止は graceful に行う。stdin を閉じ、10s 以内に終わらなければ SIGTERM、そこから 5s
以内にも終わらなければ SIGKILL。

## 8. pi に委ねるもの

Runner で再定義せず pi の機能をそのまま使う ([design.md](../design.md) Portability)。

| 項目 | 扱い |
|---|---|
| モデルと thinking level の解釈 | `--model` の shorthand を渡すだけ。provider の推論もパースも pi |
| compaction | pi の auto-compaction に任せる。Runner は Transcript の世代交代 (§2.1) だけを行い、圧縮は行わない |
| retry | pi の自動リトライに任せる。`agent_end.willRetry` を見てターン終端の判定だけを合わせる |
| steering / follow-up のキュー | pi の 2 段キューに任せる。Runner はコマンドを送るだけ |

Channel や Agent ごとに変えたい項目は Agent Config で宣言し、Runtime が起動時に pi へ
渡す形にする。pi 側の設定ファイル (`~/.pi/agent/settings.json`) はイメージに焼き込み、
利用者が `FROM` 1 段で上書きできる。

## 9. 実装対応

| 設計上の名前 | 現在の実装 |
|---|---|
| Runtime (レイヤ) | `src/runtime/` (`prepare.ts` / `pi-process.ts` / `pi-args.ts` / `sandbox.ts` / `prompt.ts` / `rpc.ts` / `pi-events.ts` / `reply-files.ts` / `config.ts` / `resolve.ts` / `session-file.ts`) |
| 起動準備 (§2) | `prepareWorkdir` / `buildSpawnOptions` / `rotateTranscript` / `chownRecursive` (`src/runtime/prepare.ts`) |
| 組み込み extension / memory skill の解決 | `resolveBuiltinExtensionPaths` / `resolveBuiltinMemorySkillPath` / `resolveChannelResourcePaths` (同上) |
| memory 索引の読み込み | `loadMemoryIndex` (同上) |
| Runtime の静的設定 | `RuntimeConfig` / `PiPermissionConfig` (`src/runtime/config.ts`)、組み立ては `createRuntimeConfig` (`src/runtime/resolve.ts`) を `src/server.ts` が呼ぶ |
| 起動引数の組み立て | `buildPiArgs` / `buildSpawnCommand` (`src/runtime/pi-args.ts`) |
| Permission Model | `buildPiPermissionOptions` / `ancestorDirs` (`src/runtime/pi-args.ts`)、`PiPermissionConfig` (`src/runtime/config.ts`)、`buildPiPermissionConfig` / `resolvePiPaths` / `outermostNodeModules` (`src/runtime/resolve.ts`) |
| env allowlist | `buildPiEnv` (`src/runtime/pi-args.ts`)、`collectGcpEnv` (`src/runtime/resolve.ts`) |
| srt (§5.5) の settings 合成 | `buildSandboxSettings` / `sandboxSettingsPath` / `probeSandboxRuntime` (`src/runtime/sandbox.ts`)、書き出しと削除は `Session` (`src/session/session.ts`)、boot 時の検査は `checkSandboxPrerequisites` (`src/server.ts`) |
| srt で包む起動コマンド | `wrapWithSrt` (`src/runtime/pi-args.ts`)、`PiProcess` の `sandbox` オプション、srt の所在は `resolveSrtPath` (`src/runtime/resolve.ts`) |
| Session 専用 TMPDIR | `sessionTmpDir` / `prepareWorkdir` (`src/runtime/prepare.ts`)、env への配線は `Dispatcher` (`src/dispatch/dispatcher.ts`) |
| 子プロセスのラッパ | `PiProcess` (`src/runtime/pi-process.ts`) |
| システムプロンプト | `buildSystemPrompt` / `prependContext` (`src/runtime/prompt.ts`) |
| RPC プロトコル | `src/runtime/rpc.ts` (`RpcCommand` / `PiEvent` / `JsonlDecoder`) |
| イベントの読み取り | `extractReply` / `turnStatusFromAgentEnd` / `extractUsageTotals` (`src/runtime/pi-events.ts`) |
| reply の files の境界チェック | `resolveReplyFiles` (`src/runtime/reply-files.ts`)。呼び出しは `Session` (`src/session/session.ts`) |
| 組み込み extension | `extensions/reply.ts` / `permission-gate.ts` / `export.ts` |
| 組み込み memory skill | `builtin-skills/memory/SKILL.md` |
