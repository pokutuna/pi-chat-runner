#!/usr/bin/env bash
# ローカル検証用のサブコマンド式ランチャー。
#
# 使い方:
#   develop/local.sh build [--base-only]   # base (pi-chat-runner:local) をビルドし、
#                                           # 続けて Dockerfile.dev-agent で
#                                           # pi-chat-runner-dev:local をビルドする。
#                                           # --base-only で base のみ
#   develop/local.sh tui [channelId]       # コンテナ内 TUI (既定チャンネル: local)
#   develop/local.sh socket                # 同 compose を up (Socket Mode)
#   develop/local.sh down [args...]        # 同 compose を down (残り引数をそのまま渡す)
set -euo pipefail

# このスクリプトの場所からリポジトリルートを解決する (どこから呼んでも動く)。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

BASE_IMAGE="pi-chat-runner:local"
DEV_IMAGE="pi-chat-runner-dev:local"
COMPOSE_FILE="${SCRIPT_DIR}/compose.local-container.yaml"

usage() {
  cat <<EOF
Usage: develop/local.sh <command> [args...]

Commands:
  build [--base-only]   base (${BASE_IMAGE}) をビルドし、続けて Dockerfile.dev-agent で
                         ${DEV_IMAGE} をビルドする。--base-only で base のみ
  tui [channelId]        コンテナ内 TUI (既定チャンネル: local)
  socket                 コンテナで Socket Mode を起動 (compose up)
  down [args...]         compose を down (残り引数をそのまま渡す。-v で volume も消す)
EOF
}

cmd_build() {
  cd "${ROOT_DIR}"

  echo ">>> building base image: ${BASE_IMAGE}"
  docker build -t "${BASE_IMAGE}" .

  if [[ "${1:-}" == "--base-only" ]]; then
    echo ">>> --base-only のため dev イメージはスキップ"
    echo ">>> done: ${BASE_IMAGE}"
    return 0
  fi

  echo ">>> building dev image: ${DEV_IMAGE} (base: ${BASE_IMAGE})"
  docker build \
    --build-arg "BASE_IMAGE=${BASE_IMAGE}" \
    -t "${DEV_IMAGE}" \
    -f develop/Dockerfile.dev-agent \
    .

  echo ">>> done: ${BASE_IMAGE}, ${DEV_IMAGE}"
}

cmd_tui() {
  local channel_id="${1:-local}"
  docker compose -f "${COMPOSE_FILE}" --env-file "${ROOT_DIR}/.env.socket" run --rm \
    pi-chat-runner node /app/dist/server.mjs local "${channel_id}"
}

cmd_socket() {
  docker compose -f "${COMPOSE_FILE}" --env-file "${ROOT_DIR}/.env.socket" up
}

cmd_down() {
  docker compose -f "${COMPOSE_FILE}" --env-file "${ROOT_DIR}/.env.socket" down "$@"
}

if [[ $# -eq 0 ]]; then
  usage
  exit 1
fi

subcommand="$1"
shift

case "${subcommand}" in
  build)
    cmd_build "$@"
    ;;
  tui)
    cmd_tui "$@"
    ;;
  socket)
    cmd_socket "$@"
    ;;
  down)
    cmd_down "$@"
    ;;
  *)
    usage
    exit 1
    ;;
esac
