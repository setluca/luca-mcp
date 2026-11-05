#!/usr/bin/env bash
# Compares the hosted server with the tool surface a git ref records. A missing
# key or an older ref is a warning, not a failure, so this can ship before the
# secret exists.
set -euo pipefail

ref="$1"

if [ -z "${LUCA_MCP_LIVE_KEY:-}" ]; then
  echo "::warning::LUCA_MCP_LIVE_KEY is not set, so the live check did not run. See scripts/setup-drift-checks.sh."
  exit 0
fi

expected="$(mktemp)"

if ! git show "$ref:tool-surface.json" > "$expected" 2>/dev/null; then
  echo "::notice::$ref has no tool-surface.json yet, so there is nothing to compare."
  exit 0
fi

bun run surface:live --expected "$expected"
