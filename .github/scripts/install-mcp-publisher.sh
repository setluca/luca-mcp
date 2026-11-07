#!/usr/bin/env bash
# Installs the MCP registry's CLI, checksum verified, into the working directory. The
# post-merge validation and the release publish share it, so a server.json that
# validates is checked by the same version that later publishes it.
set -euo pipefail

version="v1.8.0"
sha256="1370446bbe74d562608e8005a6ccce02d146a661fbd78674e11cc70b9618d6cf"

curl -fsSL -o mcp-publisher.tar.gz \
  "https://github.com/modelcontextprotocol/registry/releases/download/${version}/mcp-publisher_linux_amd64.tar.gz"
echo "${sha256}  mcp-publisher.tar.gz" | sha256sum --check --strict
tar xzf mcp-publisher.tar.gz mcp-publisher
rm mcp-publisher.tar.gz
