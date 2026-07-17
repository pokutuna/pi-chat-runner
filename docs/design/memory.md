# memory — 組み込み skill によるチャンネル記憶

agent がチャンネルで学んだ恒久知識 (ユーザーの好み・環境の事実・繰り返し使う手順)
をセッションを越えて蓄積・想起する仕組み。実体は [shared.md](shared.md) の
共有ディレクトリに乗る**組み込み skill 1 つ**であり、専用のストアや注入機構は
持たない。[session-model.md](session-model.md) §8-6 (共有ハンドブック) の具体化。

## 0. 結論

| 項目 | 決定 |
|---|---|
| 実装 | 組み込み skill `builtin-skills/memory/SKILL.md` (リポジトリ / パッケージ直下) |
| 配線 | shared 有効 (env `SHARED_DIR` 設定) 時に `--skill` へ追加。既定 ON |
| opt-out | ChannelDoc の `memory: false` でチャンネル単位に外せる ([config.md](config.md) §2) |
| 置き場所 | `../shared/memory/MEMORY.md` (索引) + `memory/<slug>.md` (1 事実 1 ファイル) |
| 索引の想起 | MEMORY.md は Runner が毎ターン system prompt に注入。本文ファイルは skill 経由で agent がオンデマンドに read |

## 1. 規約 — MEMORY.md + 1 事実 1 ファイル

skill が agent に教える規約 (本文は builtin-skills/memory/SKILL.md が正):

- **Recall**: MEMORY.md は system prompt に既に含まれているため agent 自身が
  読む必要はない (§2)。関連しそうなときだけ `../shared/memory/` 配下の本文
  ファイルを read する (索引は常駐・本文はオンデマンド、の二層。
  [session-model.md](session-model.md) §8-1 と同じ構造)。
- **Save**: 恒久知識だけを `memory/<short-kebab-case-slug>.md` に 1 事実
  1 ファイルで書き、MEMORY.md に 1 行ポインタを追記する。保存前に既存エントリを
  確認し、重複は新規作成でなく更新。誤りと分かったものは削除。
- **手順の skill 化**: 繰り返す手順は memory でなく
  `../shared/skills/<name>/SKILL.md` として保存する — 次セッションから
  自動ロードされる ([shared.md](shared.md) §4)。

1 事実 1 ファイルにするのは、shared がロック無し last-write-wins
([shared.md](shared.md) §3) だから: 並行セッションが同時に学んでも、衝突面が
「同じ 1 事実を同時に書いた」場合に縮む。MEMORY.md だけは追記が競合しうるが、
負けても本文ファイルは残り、次に気づいたセッションが索引を直せる。

## 2. MEMORY.md は system prompt に注入、本文は skill でオンデマンド

索引 (MEMORY.md) と本文 (`memory/<slug>.md`) で想起の仕組みを分ける:

- **索引は system prompt に常時注入**: kick 時に Runner が
  `../shared/memory/MEMORY.md` を読み、存在すれば system prompt に丸ごと追記する
  (`buildSystemPrompt` の `memoryIndex` 引数、runner.ts)。存在しなければ
  (ENOENT) 何も追記しない。これは「agent が skill を自発的に read し忘れる」
  という実地検証で見つかった弱点への対処 — 索引だけは agent の自発性に
  依存させない。
- **本文は引き続き skill 経由でオンデマンド**: 索引に載った 1 行から
  「関連しそうか」を agent が判断し、必要な `memory/<slug>.md` だけを read する。
  索引の内容そのものを毎ターン埋め込むのは Runner の役目だが、本文ファイル群を
  読むかどうかの判断・実際の read は agent に委ねる (progressive disclosure は
  本文側にだけ残す)。
- **なぜ索引だけは特別扱いか**: 索引は「1 行 1 メモリ」の短い規約
  ([memory.md](memory.md) §1 の Save 手順) が前提のため、肥大化しても
  プロンプトの固定費は緩やかにしか増えない。本文まで全部埋め込むと
  progressive disclosure の利点 (記憶が増えてもプロンプト固定費が増えない) が
  失われるため、本文は skill 経由のままにしている。
- **Runner が持つ仕事**: kick ごとに MEMORY.md を 1 回読むだけ (サイズ管理や
  パースは行わない、生の Markdown をそのまま追記)。規約の変更
  (何を索引に書くか) は引き続き SKILL.md の編集で完結する。

## 3. 配線と opt-out

- 置き場所はリポジトリ直下 `builtin-skills/memory/` (Dockerfile が
  `/app/builtin-skills/` へ COPY)。**`skills/` (→ `$AGENT_HOME/.pi/agent/skills/`)
  には置かない** — あちらは pi の HOME 自動発見で全チャンネル常時ロードされる口
  なので、置くと `memory: false` の opt-out が効かなくなる。
- runner が boot 時に `resolveBuiltinMemorySkillPath()` でパス解決する
  (ソースツリー / バンドル後の両対応、見つからなければ fail-loud)。
- kick 時、shared 有効かつ `doc.memory !== false` なら `--skill` に追加する。
  shared 無効時は `memory: true` 相当でも配線されない — 書き先の `../shared/` が
  存在しないため。
- MEMORY.md の system prompt 注入 (§2) も同じ条件 (`memoryEnabled`) で
  on/off される — `memory: false` なら skill の配線だけでなく索引注入も止まる。
