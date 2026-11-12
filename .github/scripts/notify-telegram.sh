#!/usr/bin/env bash
# Send a Telegram message to the admins: notify-telegram.sh TEXT [URL] [BUTTON_LABEL]
# Needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID; without them it does nothing.
# Never fails the job: a missed notification must not break a workflow.
set -u
if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
  echo "Telegram not configured; skipping notification."
  exit 0
fi
text="$1"
url="${2:-}"
label="${3:-Open}"
if [ -n "$url" ]; then
  payload=$(jq -n --arg c "$TELEGRAM_CHAT_ID" --arg t "$text" --arg u "$url" --arg l "$label" \
    '{chat_id: $c, text: $t, disable_web_page_preview: true,
      reply_markup: {inline_keyboard: [[{text: $l, url: $u}]]}}')
else
  payload=$(jq -n --arg c "$TELEGRAM_CHAT_ID" --arg t "$text" \
    '{chat_id: $c, text: $t, disable_web_page_preview: true}')
fi
if curl -sS --max-time 10 -o /dev/null -w '%{http_code}' \
  -H 'Content-Type: application/json' -d "$payload" \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" | grep -q '^200$'; then
  echo "Telegram notification sent."
else
  echo "::warning::Telegram notification failed."
fi
exit 0
