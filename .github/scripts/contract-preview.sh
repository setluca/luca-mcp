#!/usr/bin/env bash
# Says which MCP tools a merge to Luca's master will change once it deploys. Luca's
# preview workflow runs this from a checkout of this repository, passing its own
# checkout and commit. It compares with what this repository pins, which is what's in
# production, so it includes anything else merged since the last deploy.
set -euo pipefail

luca_checkout="$1"
ref="$2"

bun install --frozen-lockfile
bun run contracts:sync --repo "$luca_checkout" --ref "$ref" --write
bun run openapi:generate

report_exit=0
report="$(bun scripts/contract-report.ts --exit-code)" || report_exit=$?

case "$report_exit" in
  0) changed=false ;;
  2) changed=true ;;
  *) echo "::error::The contract report failed."; exit "$report_exit" ;;
esac

echo "$report"

{
  echo "### MCP tools this will change once it deploys"
  echo
  echo "$report"
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

# A pull request comment holds 65,536 characters.
delimiter="$(openssl rand -hex 16)"
{
  echo "changed=$changed"
  echo "report<<$delimiter"
  echo "${report:0:60000}"
  echo "$delimiter"
} >> "${GITHUB_OUTPUT:-/dev/null}"
