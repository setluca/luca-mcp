#!/usr/bin/env bash
# Opens a pull request with the contracts Luca production now serves. Luca's deploy
# workflow runs this from a checkout of this repository, passing its own checkout.
set -euo pipefail

luca_checkout="$1"

bun install --frozen-lockfile
bun run contracts:sync --repo "$luca_checkout" --deployed --write
bun run openapi:generate

if git diff --quiet; then
  echo "The contracts already match production."
  exit 0
fi

# A removed route stops the catalog loading until its tool goes, which a person
# has to do, so the pull request still opens with what could be generated.
regenerated=true
if ! { bun run docs:generate && bun run build && bun run surface:generate; }; then
  regenerated=false
fi

body="$(mktemp)"
report_exit=0
report="$(bun scripts/contract-report.ts --exit-code)" || report_exit=$?

case "$report_exit" in
  0) routes_changed=false ;;
  2) routes_changed=true ;;
  *) echo "::error::The contract report failed."; exit "$report_exit" ;;
esac

surface_changed=false
git diff --quiet -- tool-surface.json || surface_changed=true

{
  echo "Luca production moved, so this moves the pin. Merge it before the next MCP release."
  echo
  if [ "$regenerated" = "false" ]; then
    echo "**The tools have to change before this can pass \`verify\`.** Regenerating failed, most likely because a route a tool calls is gone. Follow the report below, then run \`bun run docs:generate\`, \`bun run build\`, and \`bun run surface:generate\`."
    echo
  fi
  echo "$report"
} > "$body"

commit="$(jq -r .commit contracts/source.json)"
short="${commit:0:10}"
branch="contracts/luca-$short"
title="chore: sync contracts with Luca $short"

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git switch --create "$branch"
git add -A
git commit --quiet --message "$title"

gh auth setup-git
git push --force origin "$branch"

# A newer sync replaces an older one still waiting for review.
gh pr list --state open --search "head:contracts/luca-" --json number,headRefName \
  --jq ".[] | select(.headRefName != \"$branch\") | .number" |
  while read -r older; do
    gh pr close "$older" --delete-branch --comment "Replaced by the sync for Luca $short."
  done

if gh pr view "$branch" --json number >/dev/null 2>&1; then
  gh pr edit "$branch" --body-file "$body"
else
  gh pr create --base main --head "$branch" --title "$title" --body-file "$body"
fi

if [ "$regenerated" = "true" ] && [ "$routes_changed" = "false" ] && [ "$surface_changed" = "false" ]; then
  gh pr merge "$branch" --auto --merge || echo "::notice::Auto-merge is off, so this waits for a person."
fi
