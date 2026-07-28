# pi-chat-runner base image
#
# Design docs: session-runtime.md §5 (minimal image), architecture.md §1/§4.
#
# Runtime ships only the basic investigation CLIs used from pi's bash tool —
# no language runtimes or build tools (§5). Smaller image, faster cold start
# from min-instances=0.
#
# tsdown (node platform) keeps node_modules imports external, so the runtime
# needs production node_modules. better-sqlite3 is a native module: install it
# on the same base image (= same Node ABI) and COPY as-is.

# ---- base: node + pnpm, shared by build stages ----
FROM node:26-slim AS base

# node:26-slim has no corepack, so install pnpm pinned to package.json's
# packageManager. Use the standalone installer: the bundled npm (11.17.0) has
# a known `npm install -g` crash in arborist's packument-cache init.
ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://get.pnpm.io/install.sh | env PNPM_VERSION=10.30.3 SHELL=/bin/sh ENV=/dev/null sh -

WORKDIR /app
COPY package.json pnpm-lock.yaml ./

# ---- builder: full install + tsdown build ----
FROM base AS builder

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --store-dir /pnpm/store

COPY tsconfig.json tsdown.config.ts ./
COPY src ./src
RUN pnpm run build

# ---- prod-deps: production-only install in a clean stage ----
# Re-running `pnpm install --prod` inside builder leaves dev deps
# (typescript/rolldown/oxlint etc.) in the virtual store (.pnpm), leaking
# ~150MB into the runtime. A from-scratch --prod install avoids that.
# pi (@earendil-works/pi-coding-agent) is a regular dependency, so it and its
# transitive deps land here too, managed by pnpm alone (a separate npm install
# would conflict). server.ts resolvePiPaths finds pi's entrypoint in
# /app/node_modules via import.meta.resolve() (config.md §6).
FROM base AS prod-deps

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --prod --store-dir /pnpm/store

# ---- runtime ----
FROM node:26-slim

ENV NODE_ENV=production

# Basic investigation set for pi's bash tool (git/curl/jq/ripgrep/fd) only.
# Debian installs fd-find as fdfind; symlink it to fd.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates jq ripgrep fd-find \
  &&  rm -rf /var/lib/apt/lists/* \
  &&  ln -s "$(command -v fdfind)" /usr/local/bin/fd

# agent user for UID separation (session-runtime.md §6). The container keeps
# running as root (the Runner); the Runner drops to { uid, gid } when spawning
# pi. /home/agent is agent-owned so pi can create ~/.pi etc. /app stays
# root-owned with no agent write access — the agent must not be able to
# rewrite the Runner's own code.
RUN groupadd --gid 1001 agent \
  && useradd --uid 1001 --gid 1001 --create-home --shell /usr/sbin/nologin agent

# Baked default settings.json (session-runtime.md §2): pins only the behavior
# the runner depends on (steeringMode/followUpMode/compaction.enabled/
# enableInstallTelemetry). Downstream images can overwrite it with a single
# COPY --chown=1001:1001 <own settings.json> /home/agent/.pi/agent/settings.json
COPY --chown=1001:1001 home/ /home/agent/

WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

# The reply extension is excluded from the build: pi loads the TS source
# directly via --extension. Copy as source.
COPY extensions ./extensions

# Built-in skills (memory). Wired by the Runner via --skill when SHARED_DIR is
# enabled (docs/design/memory.md). Distinct from skills/ below — that one is
# always loaded for all channels, this one is opt-out via ChannelDoc.memory.
COPY builtin-skills ./builtin-skills

# Skills under pi's default search path $AGENT_HOME/.pi/agent/skills/ are
# auto-discovered (no --skill wiring needed, config.md §6). Currently empty
# (.gitkeep only); downstream images can overwrite with a single
# COPY --chown=1001:1001 skills/ /home/agent/.pi/agent/skills/
COPY --chown=1001:1001 skills/ /home/agent/.pi/agent/skills/

# CONFIG_PATH defaults to the relative path "examples/config/agent.yaml"
# (server.ts); bundle it so it resolves from WORKDIR /app.
COPY examples/config ./examples/config

# Subcommands (local / dump) pass through docker run args:
#   docker run -it ... <image> local
# No args = server mode (how Cloud Run starts it).
ENTRYPOINT ["node", "/app/dist/server.mjs"]
