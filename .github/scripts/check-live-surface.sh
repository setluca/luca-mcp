#!/usr/bin/env bash
# Compares the hosted server with the tool surface a git ref records. A missing key
# or an older ref skips the check with a warning, so this can ship before the secret
# exists. It says so in the step's output, because a check that did not run has no
# verdict to report.
set -euo pipefail

ref="$1"

skip() {
  echo "$1"
  echo "skipped=true" >> "${GITHUB_OUTPUT:-/dev/null}"
  exit 0
}

if [ -z "${LUCA_MCP_LIVE_KEY:-}" ]; then
  skip "::warning::LUCA_MCP_LIVE_KEY is not set, so the live check did not run. See scripts/setup-drift-checks.sh."
fi

if [ -z "$ref" ]; then
  skip "::notice::There is no release to compare with yet."
fi

expected="$(mktemp)"

if ! git show "$ref:tool-surface.json" > "$expected" 2>/dev/null; then
  skip "::notice::$ref has no tool-surface.json yet, so there is nothing to compare."
fi

bun run surface:live --expected "$expected"
