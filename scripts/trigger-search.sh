#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${ENV_FILE:-$PROJECT_DIR/.env}"

read_env_value() {
  local key="$1"
  local file="$2"
  if [ ! -f "$file" ]; then
    return 0
  fi
  KEY="$key" FILE="$file" bun -e '
const key = process.env.KEY;
const file = process.env.FILE;
if (!key || !file) process.exit(0);
const raw = await Bun.file(file).text();
for (const line of raw.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const idx = trimmed.indexOf("=");
  if (idx <= 0) continue;
  const k = trimmed.slice(0, idx).trim();
  if (k !== key) continue;
  let value = trimmed.slice(idx + 1).trim();
  const singleQuote = String.fromCharCode(39);
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith(singleQuote) && value.endsWith(singleQuote))) {
    value = value.slice(1, -1);
  }
  process.stdout.write(value);
  break;
}
'
}

WORKER_URL="${WORKER_URL:-}"
if [ -z "$WORKER_URL" ]; then
  echo "Error: set WORKER_URL (for example https://aupair-search.<subdomain>.workers.dev)"
  exit 1
fi

MANUAL_TRIGGER_TOKEN="${MANUAL_TRIGGER_TOKEN:-}"
if [ -z "$MANUAL_TRIGGER_TOKEN" ]; then
  MANUAL_TRIGGER_TOKEN="$(read_env_value "MANUAL_TRIGGER_TOKEN" "$ENV_FILE")"
fi
if [ -z "$MANUAL_TRIGGER_TOKEN" ]; then
  echo "Error: set MANUAL_TRIGGER_TOKEN in environment or .env"
  exit 1
fi

curl -sS -X POST "$WORKER_URL/api/run-search" \
  -H "Authorization: Bearer $MANUAL_TRIGGER_TOKEN" \
  -H "Content-Type: application/json"

echo
