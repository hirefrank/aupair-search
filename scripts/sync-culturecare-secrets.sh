#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${ENV_FILE:-$PROJECT_DIR/.env}"
WRANGLER_CONFIG_FILE="${WRANGLER_CONFIG:-$PROJECT_DIR/wrangler.toml}"

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

write_env_value() {
  local key="$1"
  local value="$2"
  local file="$3"
  KEY="$key" VALUE="$value" FILE="$file" bun -e '
const key = process.env.KEY;
const value = process.env.VALUE ?? "";
const file = process.env.FILE;
if (!key || !file) process.exit(0);
let raw = "";
try {
  raw = await Bun.file(file).text();
} catch {}
const lines = raw ? raw.split(/\r?\n/) : [];
let replaced = false;
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i].trim();
  if (!line || line.startsWith("#")) continue;
  const idx = line.indexOf("=");
  if (idx <= 0) continue;
  if (line.slice(0, idx).trim() !== key) continue;
  lines[i] = `${key}=${value}`;
  replaced = true;
  break;
}
if (!replaced) lines.push(`${key}=${value}`);
const out = `${lines.filter((_, i) => i < lines.length - 1 || lines[i] !== "").join("\n")}\n`;
await Bun.write(file, out);
'
}

if [ -z "${CULTURECARE_BEARER:-}" ]; then
  CULTURECARE_BEARER="$(read_env_value "CULTURECARE_BEARER" "$ENV_FILE")"
fi
if [ -z "${CULTURECARE_REFRESH_TOKEN:-}" ]; then
  CULTURECARE_REFRESH_TOKEN="$(read_env_value "CULTURECARE_REFRESH_TOKEN" "$ENV_FILE")"
fi
if [ -z "${SLACK_WEBHOOK_URL:-}" ]; then
  SLACK_WEBHOOK_URL="$(read_env_value "SLACK_WEBHOOK_URL" "$ENV_FILE")"
fi
if [ -z "${SLACK_ENABLE_DETAILS_MODAL:-}" ]; then
  SLACK_ENABLE_DETAILS_MODAL="$(read_env_value "SLACK_ENABLE_DETAILS_MODAL" "$ENV_FILE")"
fi
if [ -z "${MANUAL_TRIGGER_TOKEN:-}" ]; then
  MANUAL_TRIGGER_TOKEN="$(read_env_value "MANUAL_TRIGGER_TOKEN" "$ENV_FILE")"
fi
if [ -z "${SLACK_BOT_TOKEN:-}" ]; then
  SLACK_BOT_TOKEN="$(read_env_value "SLACK_BOT_TOKEN" "$ENV_FILE")"
fi
if [ -z "${SLACK_SIGNING_SECRET:-}" ]; then
  SLACK_SIGNING_SECRET="$(read_env_value "SLACK_SIGNING_SECRET" "$ENV_FILE")"
fi
if [ -z "${SLACK_ACTION_TOKEN:-}" ]; then
  SLACK_ACTION_TOKEN="$(read_env_value "SLACK_ACTION_TOKEN" "$ENV_FILE")"
fi
if [ -z "${CULTURECARE_HOST_FAMILY_ID:-}" ]; then
  CULTURECARE_HOST_FAMILY_ID="$(read_env_value "CULTURECARE_HOST_FAMILY_ID" "$ENV_FILE")"
fi
if [ -z "${APIA_URL:-}" ]; then
  APIA_URL="$(read_env_value "APIA_URL" "$ENV_FILE")"
fi
if [ -z "${APIA_COOKIE:-}" ]; then
  APIA_COOKIE="$(read_env_value "APIA_COOKIE" "$ENV_FILE")"
fi
if [ -z "${APIA_URL_OVERRIDE:-}" ]; then
  APIA_URL_OVERRIDE="$(read_env_value "APIA_URL_OVERRIDE" "$ENV_FILE")"
fi
if [ -z "${APIA_COOKIE_OVERRIDE:-}" ]; then
  APIA_COOKIE_OVERRIDE="$(read_env_value "APIA_COOKIE_OVERRIDE" "$ENV_FILE")"
fi
if [ -z "${APIA_USER_AGENT:-}" ]; then
  APIA_USER_AGENT="$(read_env_value "APIA_USER_AGENT" "$ENV_FILE")"
fi

# Optional extractor command: must print JSON like
# {"bearer":"...","refreshToken":"..."}
if [ -z "${CULTURECARE_TOKEN_COMMAND:-}" ]; then
  CULTURECARE_TOKEN_COMMAND="bun \"$PROJECT_DIR/scripts/extract-culturecare-token-from-browser.mjs\""
fi

if [ -n "${CULTURECARE_TOKEN_COMMAND:-}" ]; then
  if TOKEN_JSON=$(bash -lc "$CULTURECARE_TOKEN_COMMAND" 2>/dev/null); then
  if [ -n "$TOKEN_JSON" ]; then
    CULTURECARE_BEARER_FROM_CMD=$(printf "%s" "$TOKEN_JSON" | bun -e "const d=JSON.parse(await Bun.stdin.text());process.stdout.write(typeof d.bearer==='string'?d.bearer:'')")
    CULTURECARE_REFRESH_FROM_CMD=$(printf "%s" "$TOKEN_JSON" | bun -e "const d=JSON.parse(await Bun.stdin.text());process.stdout.write(typeof d.refreshToken==='string'?d.refreshToken:'')")
    if [ -n "$CULTURECARE_BEARER_FROM_CMD" ]; then
      export CULTURECARE_BEARER="$CULTURECARE_BEARER_FROM_CMD"
    fi
    if [ -n "$CULTURECARE_REFRESH_FROM_CMD" ]; then
      export CULTURECARE_REFRESH_TOKEN="$CULTURECARE_REFRESH_FROM_CMD"
    fi
  fi
  else
    echo "Warning: browser token extraction command failed; continuing with existing env values"
  fi
fi

if [ -z "${APIA_COOKIE_COMMAND:-}" ]; then
  APIA_COOKIE_COMMAND="bun \"$PROJECT_DIR/scripts/extract-apia-cookie-from-browser.mjs\""
fi

if [ -n "${APIA_COOKIE_COMMAND:-}" ]; then
  if COOKIE_JSON=$(bash -lc "$APIA_COOKIE_COMMAND" 2>/dev/null); then
    if [ -n "$COOKIE_JSON" ]; then
      APIA_URL_FROM_CMD=$(printf "%s" "$COOKIE_JSON" | bun -e "const d=JSON.parse(await Bun.stdin.text());process.stdout.write(typeof d.url==='string'?d.url:'')")
      APIA_COOKIE_FROM_CMD=$(printf "%s" "$COOKIE_JSON" | bun -e "const d=JSON.parse(await Bun.stdin.text());process.stdout.write(typeof d.cookie==='string'?d.cookie:'')")
      if [ -n "$APIA_URL_FROM_CMD" ]; then
        export APIA_URL="$APIA_URL_FROM_CMD"
        export APIA_URL_OVERRIDE="$APIA_URL_FROM_CMD"
        write_env_value "APIA_URL" "$APIA_URL_FROM_CMD" "$ENV_FILE"
        write_env_value "APIA_URL_OVERRIDE" "$APIA_URL_FROM_CMD" "$ENV_FILE"
      fi
      if [ -n "$APIA_COOKIE_FROM_CMD" ]; then
        export APIA_COOKIE="$APIA_COOKIE_FROM_CMD"
        export APIA_COOKIE_OVERRIDE="$APIA_COOKIE_FROM_CMD"
        write_env_value "APIA_COOKIE" "$APIA_COOKIE_FROM_CMD" "$ENV_FILE"
        write_env_value "APIA_COOKIE_OVERRIDE" "$APIA_COOKIE_FROM_CMD" "$ENV_FILE"
      fi
    fi
  else
    echo "Warning: APIA browser cookie extraction command failed; continuing with existing env values"
  fi
fi

if [ -z "${CULTURECARE_BEARER:-}" ] && [ -z "${CULTURECARE_REFRESH_TOKEN:-}" ]; then
  echo "Error: no CULTURECARE_BEARER or CULTURECARE_REFRESH_TOKEN available"
  echo "Set values in $ENV_FILE or provide CULTURECARE_TOKEN_COMMAND"
  exit 1
fi

if [ ! -f "$WRANGLER_CONFIG_FILE" ]; then
  echo "Error: wrangler config not found: $WRANGLER_CONFIG_FILE"
  exit 1
fi

echo "Syncing Culture Care secrets using $WRANGLER_CONFIG_FILE"

if [ -n "${CULTURECARE_BEARER:-}" ]; then
  printf "%s" "$CULTURECARE_BEARER" | bunx wrangler secret put CULTURECARE_BEARER --config "$WRANGLER_CONFIG_FILE"
  echo "Updated CULTURECARE_BEARER"
fi

if [ -n "${CULTURECARE_REFRESH_TOKEN:-}" ]; then
  printf "%s" "$CULTURECARE_REFRESH_TOKEN" | bunx wrangler secret put CULTURECARE_REFRESH_TOKEN --config "$WRANGLER_CONFIG_FILE"
  echo "Updated CULTURECARE_REFRESH_TOKEN"
fi

if [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
  printf "%s" "$SLACK_WEBHOOK_URL" | bunx wrangler secret put SLACK_WEBHOOK_URL --config "$WRANGLER_CONFIG_FILE"
  echo "Updated SLACK_WEBHOOK_URL"
fi

if [ -n "${SLACK_ENABLE_DETAILS_MODAL:-}" ]; then
  printf "%s" "$SLACK_ENABLE_DETAILS_MODAL" | bunx wrangler secret put SLACK_ENABLE_DETAILS_MODAL --config "$WRANGLER_CONFIG_FILE"
  echo "Updated SLACK_ENABLE_DETAILS_MODAL"
fi

if [ -n "${MANUAL_TRIGGER_TOKEN:-}" ]; then
  printf "%s" "$MANUAL_TRIGGER_TOKEN" | bunx wrangler secret put MANUAL_TRIGGER_TOKEN --config "$WRANGLER_CONFIG_FILE"
  echo "Updated MANUAL_TRIGGER_TOKEN"
fi

if [ -n "${SLACK_BOT_TOKEN:-}" ]; then
  printf "%s" "$SLACK_BOT_TOKEN" | bunx wrangler secret put SLACK_BOT_TOKEN --config "$WRANGLER_CONFIG_FILE"
  echo "Updated SLACK_BOT_TOKEN"
fi

if [ -n "${SLACK_SIGNING_SECRET:-}" ]; then
  printf "%s" "$SLACK_SIGNING_SECRET" | bunx wrangler secret put SLACK_SIGNING_SECRET --config "$WRANGLER_CONFIG_FILE"
  echo "Updated SLACK_SIGNING_SECRET"
fi

if [ -n "${SLACK_ACTION_TOKEN:-}" ]; then
  printf "%s" "$SLACK_ACTION_TOKEN" | bunx wrangler secret put SLACK_ACTION_TOKEN --config "$WRANGLER_CONFIG_FILE"
  echo "Updated SLACK_ACTION_TOKEN"
fi

if [ -n "${CULTURECARE_HOST_FAMILY_ID:-}" ]; then
  printf "%s" "$CULTURECARE_HOST_FAMILY_ID" | bunx wrangler secret put CULTURECARE_HOST_FAMILY_ID --config "$WRANGLER_CONFIG_FILE"
  echo "Updated CULTURECARE_HOST_FAMILY_ID"
fi

if [ -n "${APIA_URL:-}" ]; then
  printf "%s" "$APIA_URL" | bunx wrangler secret put APIA_URL --config "$WRANGLER_CONFIG_FILE"
  echo "Updated APIA_URL"
fi

if [ -n "${APIA_COOKIE:-}" ]; then
  printf "%s" "$APIA_COOKIE" | bunx wrangler secret put APIA_COOKIE --config "$WRANGLER_CONFIG_FILE"
  echo "Updated APIA_COOKIE"
fi

if [ -n "${APIA_URL_OVERRIDE:-}" ]; then
  printf "%s" "$APIA_URL_OVERRIDE" | bunx wrangler secret put APIA_URL_OVERRIDE --config "$WRANGLER_CONFIG_FILE"
  echo "Updated APIA_URL_OVERRIDE"
fi

if [ -n "${APIA_COOKIE_OVERRIDE:-}" ]; then
  printf "%s" "$APIA_COOKIE_OVERRIDE" | bunx wrangler secret put APIA_COOKIE_OVERRIDE --config "$WRANGLER_CONFIG_FILE"
  echo "Updated APIA_COOKIE_OVERRIDE"
fi

if [ -n "${APIA_USER_AGENT:-}" ]; then
  printf "%s" "$APIA_USER_AGENT" | bunx wrangler secret put APIA_USER_AGENT --config "$WRANGLER_CONFIG_FILE"
  echo "Updated APIA_USER_AGENT"
fi

echo "Secret sync complete"
