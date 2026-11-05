#!/usr/bin/env bash
# Keeps one open issue for a failing drift check, so a red scheduled run reaches a
# person instead of waiting to be noticed, and closes it when the check recovers.
set -euo pipefail

title="$1"
status="$2"
fix="$3"
run_url="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"

existing="$(gh issue list --state open --search "\"$title\" in:title" --json number,title \
  --jq "map(select(.title == \"$title\")) | first | .number // empty")"

if [ "$status" = "success" ]; then
  if [ -n "$existing" ]; then
    gh issue close "$existing" --comment "The check passes again: $run_url"
  fi
  exit 0
fi

if [ -z "$existing" ]; then
  gh issue create --title "$title" --body "This scheduled check failed: $run_url

$fix

This issue closes itself when the check passes again."
fi
