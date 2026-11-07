#!/usr/bin/env bash
# Installs the tarball npm would publish into an empty project, then starts it under
# whichever Node is on PATH. Our other startup test runs dist/ under Bun, so it can't
# see a missing dependency, a file left out of `files`, or a broken bin.
set -euo pipefail

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

npm pack --ignore-scripts --silent --pack-destination "$workdir" > /dev/null
tarball="$(echo "$workdir"/*.tgz)"

mkdir "$workdir/project"
(
  cd "$workdir/project"
  npm init -y > /dev/null
  npm install --silent --no-audit --no-fund "$tarball"
)

echo "Node $(node --version)"
bun run package:check "$workdir/project/node_modules/.bin/luca-mcp"
