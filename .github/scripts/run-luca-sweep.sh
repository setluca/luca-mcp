#!/usr/bin/env bash
# Starts the tool sweep in setluca/luca for one MCP ref, then waits for its verdict.
set -euo pipefail

ref="$1"

if [ -z "${GH_TOKEN:-}" ]; then
  echo "::warning::LUCA_REPO_TOKEN is not set, so this release was not swept. See scripts/setup-drift-checks.sh."
  exit 0
fi

# The sweep reseeds the production database with Luca's own code, so it has to
# run the commit production runs. Luca's master can be ahead of production with a
# migration that hasn't run yet, and its seed then fails on a missing column. Luca
# tags each release, so dispatch on the tag of the deployed commit.
deployed="$(curl -fsS https://api.setluca.com/health | jq -r '.version.tag // empty')"
if [ -z "$deployed" ]; then
  echo "::error::Luca production's /health did not report a commit."
  exit 1
fi
luca_ref="$(gh api "repos/setluca/luca/tags" --paginate \
  --jq ".[] | select(.commit.sha == \"$deployed\") | .name" | head -n 1)"
if [ -z "$luca_ref" ]; then
  echo "::error::No setluca/luca tag points at the deployed commit $deployed."
  exit 1
fi
echo "Sweeping with setluca/luca $luca_ref, the deployed commit $deployed."

started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
gh workflow run mcp-sweep.yml --repo setluca/luca --ref "$luca_ref" -f mcp_ref="$ref"

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
