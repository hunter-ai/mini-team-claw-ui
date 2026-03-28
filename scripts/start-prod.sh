#!/bin/sh

set -eu

max_attempts="${DB_START_MAX_ATTEMPTS:-30}"
sleep_seconds="${DB_START_SLEEP_SECONDS:-2}"
attempt=1

echo "Waiting for database and applying schema..."

while [ "$attempt" -le "$max_attempts" ]; do
  echo "Database bootstrap attempt ${attempt}/${max_attempts}"

  if npx prisma db push; then
    echo "Database schema is ready."
    break
  fi

  if [ "$attempt" -eq "$max_attempts" ]; then
    echo "Database bootstrap failed after ${max_attempts} attempts."
    exit 1
  fi

  attempt=$((attempt + 1))
  sleep "$sleep_seconds"
done

echo "Running seed step..."
npm run db:seed

echo "Starting web server..."
exec npm run start
