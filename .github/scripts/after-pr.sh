#!/usr/bin/env bash
# After a pipeline or add-library run: merge or ask for approval, and tell the admins.
#   LOG           the run's output (looks for "Opened <PR url>")
#   KIND          "evidence refresh" or "new library"
#   JOB_STATUS    ${{ job.status }}
#   AUTOMERGE     "true" when an admin already approved the work (request or admin page)
#   CAN_AUTOMERGE "true" when PIPELINE_TOKEN is set (its PRs run CI, so auto-merge can wait for it)
# PRs that only move last_verified ("Re-verified … (no changes)") merge without asking.
set -u
notify() { bash .github/scripts/notify-telegram.sh "$@"; }
run_url="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"

if [ "${JOB_STATUS:-}" != "success" ]; then
  notify "⚠️ PQC Deps: the ${KIND} run failed." "$run_url" "Open run"
  exit 0
fi
pr=$(grep -oE 'Opened https://[^ ]+' "$LOG" 2>/dev/null | tail -1 | cut -d' ' -f2 || true)
[ -n "$pr" ] || exit 0
num="${pr##*/}"
title=$(gh pr view "$pr" --json title --jq .title 2>/dev/null || echo "PR #$num")
date_only=false
case "$title" in "Re-verified "*) date_only=true ;; esac

if [ "${CAN_AUTOMERGE:-}" = "true" ] && { [ "${AUTOMERGE:-}" = "true" ] || $date_only; }; then
  if gh pr merge "$pr" --auto --merge; then
    echo "Auto-merge enabled for $pr."
    if ! $date_only; then
      TG_KEYBOARD=$(jq -cn --arg n "$num" --arg u "$pr" \
        '[[{text: "❌ Stop and close", callback_data: ("x:p:" + $n)}, {text: "View", url: $u}]]') \
        notify "🤖 PQC Deps: ${title}
Approved already, so it merges by itself once the checks pass."
    fi
    exit 0
  fi
  echo "::warning::Could not enable auto-merge; asking for approval instead."
fi

summary=$(gh pr view "$pr" --json body --jq .body 2>/dev/null | head -c 1500)
TG_KEYBOARD=$(jq -cn --arg n "$num" --arg u "$pr" \
  '[[{text: "✅ Merge", callback_data: ("a:p:" + $n)}, {text: "❌ Close", callback_data: ("x:p:" + $n)}], [{text: "Review PR", url: $u}]]') \
  notify "📝 PQC Deps: ${KIND} PR #${num} is waiting for your approval.
${title}

${summary}"
exit 0
