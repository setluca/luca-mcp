# Client setup

Install the published package for normal use. The README covers hosted and
local installation. Use this page when you need to run a local build against
an MCP client.

Build first, from the repo root:

```bash
bun install
bun run build
```

## Run the built server

```bash
LUCA_API_KEY="luca_..." bun dist/index.js
```

The server speaks MCP over stdio. Do not put it behind an HTTP proxy. The
remote transport is a separate entry point, covered in [remote.md](./remote.md).

## MCP client JSON

```json
{
  "mcpServers": {
    "luca": {
      "command": "bun",
      "args": ["/absolute/path/to/luca-mcp/dist/index.js"],
      "env": {
        "LUCA_API_KEY": "luca_...",
        "LUCA_API_BASE_URL": "https://api.setluca.com"
      }
    }
  }
}
```

Point `LUCA_API_BASE_URL` at a local `apps/api` to develop against it.

## Workspace selection

Set a default workspace in the environment:

```json
{
  "env": {
    "LUCA_API_KEY": "luca_...",
    "LUCA_WORKSPACE_SLUG": "my-workspace"
  }
}
```

Override it for one call with a tool argument:

```json
{
  "workspaceSlug": "my-workspace",
  "query": {
    "limit": 25
  }
}
```

## Confirm it works

```bash
bun run test:stdio
```

That starts the built server over a real stdio transport and asserts MCP
discovery. From a client, the equivalent check is to list tools, confirm
`luca_capabilities_get` is present alongside the `luca://operations` resource,
and call it.

Every environment variable is listed in [configuration.md](./configuration.md).
