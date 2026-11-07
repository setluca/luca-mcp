# SetLuca MCP server

[SetLuca](https://setluca.com) runs DM sales for coaches, creators, and experts. This MCP server connects your SetLuca workspace to an AI assistant such as Claude, ChatGPT, or Cursor, so you can ask it what needs attention and get help with the work waiting there.

Once you're connected, try asking:

- "What needs my attention this morning?"
- "Show me the review queue and recommend what to approve."
- "Pull up everything about this lead before my call."
- "Draft a short, warm reply for this lead."
- "How is my broadcast performing?"

## Connect your assistant

There are two ways to connect. The [connection guide](https://setluca.com/connect) helps you pick the one your assistant supports.

### Sign in with SetLuca

If your assistant supports custom connectors, as Claude and ChatGPT do, add this URL:

```text
https://mcp.setluca.com/mcp
```

Then sign in to SetLuca and choose what the assistant may do. You don't need an API key.

### Use an API key

If your assistant runs MCP servers on your computer, you need Node.js 20 or newer.

1. Create a key in **SetLuca → Settings → Developer API keys**.
2. Add this to your assistant's MCP configuration:

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

Keep the key out of prompts, screenshots, and committed files. If it can reach more than one workspace, set `LUCA_WORKSPACE_SLUG` to choose one. [Client setup](./docs/client-setup.md) has more on this path, including the Claude Code command.

## What your assistant can do

- **Read and draft, unless you allow more.** A sign-in connection starts with read and draft access, and you choose anything beyond that when you sign in. An API key can do what its scopes allow.
- **Reach a lead only with your approval.** A tool that sends a message, launches a broadcast, or books a call refuses to run without a confirmation. Your assistant is told to confirm only after you approve that exact action.
- **Leave drafts for you to review.** A reply your assistant drafts waits in your SetLuca review queue until you approve it.

## Your data

Your assistant only sees what your access allows. This server keeps no copy of your workspace data: it passes each request to SetLuca and returns the result. It logs a tool's name, whether it succeeded, and how long it took, and leaves out API keys, message text, tool arguments, and drafted replies.

Your assistant's provider handles those results under its own privacy policy, so read that before connecting a live workspace. [SetLuca's privacy policy](https://setluca.com/privacy) covers how SetLuca handles your data.

## Manage your connection

- Disconnect an assistant in **SetLuca → Settings → Connected agents**.
- Revoke an API key in **SetLuca → Settings → Developer API keys**.
- If a connection stops working, check the [connection guide](https://setluca.com/connect) and the [error guide](./docs/errors.md).
- For anything else, email [support@setluca.com](mailto:support@setluca.com).

## For developers

| To                                      | Read                                                                                           |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Browse every tool, prompt, and resource | [Tools](./docs/tools.md), [Prompts and resources](./docs/prompts-and-resources.md)             |
| See what each permission allows         | [Scopes](./docs/scopes.md)                                                                     |
| Call SetLuca without MCP                | [SetLuca API docs](https://api.setluca.com/docs)                                               |
| Work on this server                     | [Documentation index](./docs/README.md), and [AGENTS.md](./AGENTS.md) if you're a coding agent |
| See what changed in a version           | [Changelog](./CHANGELOG.md), which also lists renamed tools that may affect saved prompts      |

To run every check from a clone:

```bash
bun install --frozen-lockfile
bun run verify
```

Licensed under the [Apache License 2.0](./LICENSE).
