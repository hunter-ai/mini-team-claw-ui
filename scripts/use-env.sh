#!/usr/bin/env sh
set -eu

MODE="${1:-}"

case "$MODE" in
  dev)
    SOURCE=".env.dev.example"
    ;;
  docker)
    SOURCE=".env.docker.example"
    ;;
  *)
    echo "Usage: ./scripts/use-env.sh [dev|docker]" >&2
    exit 1
    ;;
esac

if [ ! -f "$SOURCE" ]; then
  echo "Missing template $SOURCE" >&2
  exit 1
fi

cp "$SOURCE" .env
echo "Switched .env -> $SOURCE"
