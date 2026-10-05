# Connect your assistant

Choose the path your assistant supports. A hosted connection uses your Luca
sign-in. A local connection runs the published package on your computer and
uses a developer API key from Luca.

## Hosted connection

In a client that supports custom connectors, such as Claude or ChatGPT, add:

```text
https://mcp.setluca.com/mcp
```

Sign in to Luca in the browser and choose what the assistant may do. You do
not need an API key for this path. Manage or revoke the connection in
**Luca → Settings → Connected agents**.

## Local connection

1. Create an API key in **Luca → Settings → Developer API keys**.
2. Add Luca to your client's MCP configuration. For Claude Desktop or Cursor,
   the entry looks like this:

   ```json
   {
     "mcpServers": {
       "luca": {
         "command": "npx",
         "args": ["-y", "@setluca/mcp"],
         "env": { "LUCA_API_KEY": "luca_..." }
       }
     }
   }
   ```

3. Ask your assistant, "What's in my Luca review queue?"

The published package needs Node.js 20 or newer. For Claude Code, run
`claude mcp add luca --env LUCA_API_KEY=<your-key> -- npx -y @setluca/mcp`.
Keep the key out of prompts, screenshots, and committed files. If your key
can reach more than one workspace, set `LUCA_WORKSPACE_SLUG` to choose one.

If the connection lists tools but a call fails, check the key and its scopes.
The [error guide](./errors.md) explains the response. The
[configuration guide](./configuration.md) lists every setting.

## Let your assistant guide the setup

You can paste this into an assistant if you would like it to walk you through
the choice:

```text
Help me connect my Luca workspace. First, check whether this client supports
custom web connectors. If it does, guide me to add
https://mcp.setluca.com/mcp and let me sign in to Luca myself.

If this client uses local MCP servers, guide me to install @setluca/mcp with
npx and add my LUCA_API_KEY to the client configuration. Ask me to create the
key in Luca Settings > Developer API keys. Do not ask me to paste the key into
this chat or print it back to me.

After setup, call luca_capabilities_get and tell me what my connection can do.
If the connection fails, use the error message to help me fix it.
```

## Develop against a local build

Use this section when changing the code in this repository. Normal users can
use the hosted connection or published package above.

Build first, from the repo root:

```bash
bun install
bun run build
```

### Run the built server

```bash
LUCA_API_KEY="luca_..." bun dist/index.js
```

The server speaks MCP over stdio. Do not put it behind an HTTP proxy. The
remote transport is a separate entry point, covered in [remote.md](./remote.md).

### MCP client JSON

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

### Workspace selection

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

### Confirm it works

```bash
bun run test:stdio
```

That starts the built server over a real stdio transport and asserts MCP
discovery. From a client, the equivalent check is to list tools, confirm
`luca_capabilities_get` is present alongside the `luca://operations` resource,
and call it.

Every environment variable is listed in [configuration.md](./configuration.md).
