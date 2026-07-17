# Extends the pi-chat-runner base image with a single `FROM` step, adding the
# pi-smart-fetch extension (URL fetch + summarize) as a per-channel, opt-in
# capability rather than a common one — see README.md for why.
ARG BASE_IMAGE=ghcr.io/pokutuna/pi-chat-runner:latest
FROM ${BASE_IMAGE}

# node:26-slim (the base image's runtime stage) doesn't ship corepack, so pin
# pnpm the same way the base image's own builder stage does: the standalone
# installer, since node:26-slim's bundled npm (11.17.0) crashes on
# `npm install -g` (arborist packument-cache init bug).
ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN curl -fsSL https://get.pnpm.io/install.sh | env PNPM_VERSION=10.30.3 SHELL=/bin/sh ENV=/dev/null sh -

# Install pi-smart-fetch into /app/node_modules (the base image's existing
# production node_modules root). This keeps the extension's file under a path
# the base image's Permission Model config already allows reading — no extra
# --allow-fs-read wiring beyond what the runner already adds for the
# channel's `extensions:` entry (its dirname, i.e. .../pi-smart-fetch/dist/).
WORKDIR /app
RUN pnpm add pi-smart-fetch
