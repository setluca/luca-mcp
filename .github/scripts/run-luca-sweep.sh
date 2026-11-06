#!/usr/bin/env bash
# Starts the tool sweep in setluca/luca for one MCP ref, then waits for its verdict.
set -euo pipefail

ref="$1"

if [ -z "${GH_TOKEN:-}" ]; then
  echo "::warning::LUCA_REPO_TOKEN is not set, so this release was not swept. See scripts/setup-drift-checks.sh."
  exit 0
fi

started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
gh workflow run mcp-sweep.yml --repo setluca/luca --ref master -f mcp_ref="$ref"

run=""
for _ in $(seq 1 30); do
  sleep 10
  run="$(gh run list --repo setluca/luca --workflow mcp-sweep.yml --event workflow_dispatch --limit 5 \
    --json databaseId,createdAt \
    --jq "map(select(.createdAt >= \"$started\")) | last | .databaseId // empty")"
  [ -z "$run" ] || break
done

if [ -z "$run" ]; then
  echo "::error::The sweep in setluca/luca did not start within five minutes."
  exit 1
fi

echo "Sweep run: https://github.com/setluca/luca/actions/runs/$run"
gh run watch "$run" --repo setluca/luca --exit-status --interval 30
