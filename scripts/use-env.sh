#!/usr/bin/env sh
set -eu

MODE="${1:-}"

case "$MODE" in
  dev)
    cp .env.dev .env
    echo "Switched .env -> .env.dev"
    ;;
  docker)
    cp .env.docker .env
    echo "Switched .env -> .env.docker"
    ;;
  *)
    echo "Usage: ./scripts/use-env.sh [dev|docker]" >&2
    exit 1
    ;;
esac
