# MCP Inspector

Use MCP Inspector for local protocol debugging. It starts Luca MCP over stdio,
lists tools, resources, and prompts, and lets you run calls interactively.

## UI mode

```bash
export LUCA_API_KEY="luca_..."
bun run inspect
```

The script builds `dist/index.js` and starts Inspector with:

```bash
mcp-inspector --transport stdio bun dist/index.js
```

## CLI mode

```bash
export LUCA_API_KEY="luca_..."
bun run inspect:cli
```

CLI mode is what to use in a terminal-only environment.

## Workspace and base URL

Inspector inherits the same environment variables as the server:

```bash
export LUCA_API_BASE_URL="https://api.setluca.com"
export LUCA_WORKSPACE_SLUG="my-workspace"
bun run inspect
```

## Safe first checks

After connecting:

1. List tools and confirm `luca_capabilities_get` is present.
2. Read the `luca://operations` resource.
3. Call `luca_capabilities_get`.
4. For write tools, pass a stable `idempotencyKey` when retrying.

Do not use a production workspace for exploratory write testing. Confirm-gated
tools reach real leads, and Inspector will happily send `confirm: true` for you.
