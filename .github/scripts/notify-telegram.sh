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
# TG_KEYBOARD: optional inline keyboard as JSON (rows of buttons); replaces URL/LABEL.
if [ -n "${TG_KEYBOARD:-}" ]; then
  payload=$(jq -n --arg c "$TELEGRAM_CHAT_ID" --arg t "$text" --argjson k "$TG_KEYBOARD"     '{chat_id: $c, text: $t, disable_web_page_preview: true, reply_markup: {inline_keyboard: $k}}')
elif [ -n "$url" ]; then
  payload=$(jq -n --arg c "$TELEGRAM_CHAT_ID" --arg t "$text" --arg u "$url" --arg l "$label" \
    '{chat_id: $c, text: $t, disable_web_page_preview: true,
      reply_markup: {inline_keyboard: [[{text: $l, url: $u}]]}}')
else
  payload=$(jq -n --arg c "$TELEGRAM_CHAT_ID" --arg t "$text" \
    '{chat_id: $c, text: $t, disable_web_page_preview: true}')
fi
resp=$(curl -sS --max-time 20 -H 'Content-Type: application/json' -d "$payload"   "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" 2>&1)
if [ "$(printf '%s' "$resp" | jq -r '.ok' 2>/dev/null)" = "true" ]; then
  echo "Telegram notification sent."
else
  # Telegram's own error text (e.g. "Unauthorized", "Bad Request: chat not found");
  # it never contains the token. curl errors are scrubbed of the URL just in case.
  reason=$(printf '%s' "$resp" | jq -r '.description // empty' 2>/dev/null)
  [ -n "$reason" ] || reason=$(printf '%s' "$resp" | sed "s#${TELEGRAM_BOT_TOKEN}#***#g" | head -c 200)
  echo "::warning::Telegram notification failed: ${reason:-no response}"
fi
exit 0
