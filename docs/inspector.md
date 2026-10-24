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

CLI mode is what to use in a terminal-only environment. The target comes
right after `--cli`: `mcp-inspector --cli bun dist/index.js --method tools/list`.
With the Inspector version this repo locks, putting `--transport stdio` in front
of the target fails with "Target is required".

## Schema gate

`bun run schema:strict` runs `tools/list --strict` against the built server and
fails when a tool schema has an error-severity portability problem, the kind
that makes a client refuse or mangle the tool. `verify` runs it after `build`,
so CI catches a broken schema before release. Warnings print a one-line count
and don't fail the build; run the command without `> /dev/null` to see them.

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

## Sweep every tool

`bun run sweep` calls every tool, resource, and prompt on the hosted server
through the Inspector CLI and reports each one against the outcome
`scripts/sweep/plan.ts` expects. It is how we prove the server works tool by
tool before a directory reviewer tests it (LUC-515). Run it only against the
**sweep workspace**: a production workspace seeded with synthetic records and
no connected channel, calendar, or CRM. Never run it against a coach's
workspace or the reviewer workspaces, because write tools change what they
touch.

1. Sign in once. Start the web Inspector (`bunx mcp-inspector`), connect to
   `https://mcp.setluca.com/mcp` over Streamable HTTP, sign in as the sweep
   account, and tick every permission, including full content. The token lands
   in the Inspector's shared store, and every sweep call reuses it.
2. `bun run sweep -- --dry-run` prints the plan without calling anything.
3. `bun run sweep` runs it. Calls go one at a time, because each run of the
   stored refresh token rotates it. The first call refreshes the token, which
   proves the sign-in outlives its first access token.

The report goes to `sweep-reports/` (git-ignored, since it holds workspace record
IDs), as JSON and as a Markdown table. Each check is one of:

| Verdict | Meaning                                                                       |
| ------- | ----------------------------------------------------------------------------- |
| pass    | The call did what the plan expects.                                           |
| fail    | It didn't, it took over 30 seconds, or the server answered an internal error. |
| blocked | A record the step needs isn't there: the seed has to add it.                  |
| pending | The step needs an outside system the sweep workspace doesn't connect yet.     |
| skipped | `--scope-check` couldn't reach the step without a write.                      |

The command exits non-zero when anything fails or is blocked.

What the plan checks beyond "it answered":

- **Confirmation.** A tool that takes `confirm: true` is called once without it
  and has to refuse, then once with it.
- **Retries.** A few create tools are called twice with the same idempotency
  key and have to return the same record.
- **Refusals.** Sends answer the documented "channel not connected" refusal,
  because the sample channel is disconnected, and CRM calls are refused for lack
  of credentials. Nothing reaches a real lead or an outside account.
- **Listings.** `tools/list`, `prompts/list`, `resources/list`, and
  `resources/templates/list` have to list exactly what the registry declares.

Other options: `--only luca_leads_get,luca_leads_explain` runs just those tools
(discovery always runs), `--webhook-url` changes where webhook steps deliver
(the default is a SetLuca-owned URL), and `--scope-check` runs a session signed
in with a read-only grant, where every write has to be refused.

`test/sweep-plan.test.ts` keeps the plan covering every tool the server lists,
marks exactly the confirm-gated tools as gated, and checks that every record a
step needs is provided by an earlier step. A new tool fails that test until it
has a step.
