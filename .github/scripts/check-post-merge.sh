#!/usr/bin/env bash
# Refuses to release a commit whose post-merge checks did not pass. A failed run can't
# undo the merge that caused it, so this is where it gets to stop something. A tag
# pushed right after a merge can arrive before those checks finish, so this waits.
set -euo pipefail

sha="$1"
run=""

# The run can take a moment to appear after a merge.
for _ in $(seq 1 12); do
  run="$(gh run list --repo "$GITHUB_REPOSITORY" --workflow post-merge.yml --commit "$sha" \
    --limit 1 --json databaseId --jq 'first | .databaseId // empty')"
  if [ -n "$run" ]; then
    break
  fi
  sleep 5
done

if [ -z "$run" ]; then
  echo "::error::$sha has no post-merge run. Merge it to main through a pull request, or start one on main: gh workflow run post-merge.yml --ref main"
  exit 1
fi

if ! gh run watch "$run" --repo "$GITHUB_REPOSITORY" --interval 15 --exit-status > /dev/null; then
  echo "::error::The post-merge checks for $sha did not pass: $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$run. Fix them, or re-run them if one was flaky, then re-run this workflow."
  exit 1
fi

echo "The post-merge checks for $sha passed."
