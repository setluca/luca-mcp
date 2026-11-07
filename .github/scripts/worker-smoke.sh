#!/usr/bin/env bash
# Boots the Worker with its production config in Cloudflare's local runtime and runs
# the check a deploy runs. The tests import the Worker under Node and the dry run only
# bundles it, so this is the one check before a deploy that actually runs it on workerd.
# It stays on this machine: nothing here holds Cloudflare credentials.
set -euo pipefail

port=8799
log="$(mktemp)"

WRANGLER_SEND_METRICS=false bunx wrangler dev --env production --port "$port" --log-level warn > "$log" 2>&1 &
wrangler=$!
trap 'kill "$wrangler" 2> /dev/null || true; pkill -f workerd || true' EXIT

for _ in $(seq 1 60); do
  if curl -s -o /dev/null -m 2 "http://localhost:$port/"; then
    break
  fi
  sleep 1
done

if ! bun scripts/check-deployed-worker.ts "$(bun -p "require('./package.json').version")" "http://localhost:$port"; then
  cat "$log"
  exit 1
fi
