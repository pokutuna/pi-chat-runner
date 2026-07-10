# pi-chat-runner base image
#
# 設計の正: docs/design/session-runtime.md §5 (最小コンテナイメージ)、
# docs/design/architecture.md §1 (Cloud Run 構成) / §4 (GCS FUSE)。
#
# 方針: 「pi の bash ツールから使う調査の基本セットだけ」を runtime に入れ、
# 言語ランタイムやビルドツールは持たない (§5)。イメージが小さいほど
# min-instances=0 からのコールドスタートが速い。
#
# 依存の扱い (実測で決定): tsdown/rolldown は node platform ビルドで
# node_modules の依存を bundle せず external のままにする (dist/server.mjs は
# @google-cloud/firestore 等を import 文のまま残す)。そのため runtime には
# production 依存の node_modules が必要。better-sqlite3 は native module なので、
# runtime と同じ Node ABI で builder 内 (= 同じベースイメージ) でビルドし、
# そのまま COPY する。

# ---- builder: pnpm install + tsdown build ----
FROM node:26-slim AS builder

# node:26-slim は corepack を同梱しないため、package.json の packageManager
# に合わせて npm でバージョン固定インストールする
RUN npm install -g pnpm@10.30.3

WORKDIR /app

# 依存解決とビルドに必要な最小構成のみ先にコピーしキャッシュを効かせる
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsdown.config.ts ./
COPY src ./src
RUN pnpm run build

# 本番用 node_modules を作る (production 依存のみ、better-sqlite3 は
# このステージ = runtime と同じ node:26-slim ベースでネイティブビルドされる)。
# pi 本体 (@earendil-works/pi-coding-agent) も dependencies なのでここに入り、
# その transitive 依存も pnpm が一元管理する (npm 別 install で衝突する問題を回避)。
# server.ts の resolvePiPaths が import.meta.resolve() で /app/node_modules から
# pi の entrypoint を自動検出する (config.md §6)
RUN pnpm install --frozen-lockfile --prod

# ---- runtime ----
FROM node:26-slim

# pi の bash ツールから使う調査の基本セットだけ (git/curl/jq/ripgrep/fd)。
# fd-find は Debian では fdfind としてインストールされるため fd に symlink する
RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates jq ripgrep fd-find \
  &&  rm -rf /var/lib/apt/lists/* \
  &&  ln -s "$(command -v fdfind)" /usr/local/bin/fd

# UID 分離用の agent ユーザー (session-runtime.md §6)。コンテナ自体は root で
# 起動し続け (Runner が root)、Runner が pi を spawn するときに { uid, gid } を
# 落として agent として実行する。/home/agent は agent 所有で書き込み可能にし、
# pi が ~/.pi 等を作れるようにする。/app は root 所有のまま (下記 WORKDIR 以降)
# で agent に書き込み権限を与えない — Runner コード自体を書き換えさせない
RUN groupadd --gid 1001 agent \
  && useradd --uid 1001 --gid 1001 --create-home --shell /usr/sbin/nologin agent

# 既定 settings.json の焼き込み (session-runtime.md §2)。
# steeringMode/followUpMode/compaction.enabled/enableInstallTelemetry など
# runner の設計が依存する挙動だけをピン留めした最小構成。利用者は
# FROM このイメージ 1 段で COPY --chown=1001:1001 <自分の settings.json>
# /home/agent/.pi/agent/settings.json と上書きできる
COPY --chown=1001:1001 home/ /home/agent/

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

# reply extension は pi が --extension で TS ソースを直接ロードするため
# ビルド対象外。ソースのままコピーする
COPY extensions ./extensions

# skill は pi の既定探索パス $AGENT_HOME/.pi/agent/skills/ に置けば pi が自動で
# 読む (Runner 側に --skill 等の配線は不要。config.md §6)。現状 skills/ は
# .gitkeep のみで空だが、利用者は FROM このイメージ 1 段で
# COPY --chown=1001:1001 skills/ /home/agent/.pi/agent/skills/ と上書きできる
COPY --chown=1001:1001 skills/ /home/agent/.pi/agent/skills/

# CONFIG_PATH の既定 (server.ts) は相対パス "examples/config/agent.yaml"。
# WORKDIR /app からの相対で解決できるようにここへ同梱する
COPY examples/config ./examples/config

CMD ["node", "/app/dist/server.mjs"]
