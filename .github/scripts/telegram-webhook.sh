#!/usr/bin/env bash
# Point the Telegram bot at the site's webhook so its buttons and commands work.
# The secret is HMAC-SHA256(bot token, "telegram-webhook"), the same value the
# site computes in site/server/telegram.ts. Safe to run on every deploy.
set -u
if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then echo "Telegram not configured; skipping."; exit 0; fi
url="${SITE_URL%/}/api/telegram/webhook"
secret=$(printf '%s' 'telegram-webhook' | openssl dgst -sha256 -hmac "$TELEGRAM_BOT_TOKEN" | awk '{print $NF}')
api="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"
body=$(jq -n --arg u "$url" --arg s "$secret" \
  '{url: $u, secret_token: $s, allowed_updates: ["message", "callback_query"], drop_pending_updates: false}')
desc=$(curl -sS --max-time 20 -H 'Content-Type: application/json' -d "$body" "$api/setWebhook" | jq -r '.description // "no response"')
echo "setWebhook: $desc"
cmds='{"commands":[{"command":"pending","description":"What is waiting for approval"},{"command":"approve","description":"Approve everything pending"},{"command":"help","description":"How this bot works"}]}'
curl -sS --max-time 20 -o /dev/null -H 'Content-Type: application/json' -d "$cmds" "$api/setMyCommands" || true
exit 0
