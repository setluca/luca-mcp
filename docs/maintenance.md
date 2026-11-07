# Maintenance

Run these checks when the public API, generated docs, dependencies, or server
identity changes.

## Drift checks

Each of these catches a different way for what we say to stop being true:

| Check                                     | Runs                                            | Fails when                                                                        |
| ----------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------- |
| `bun run schema:strict`                   | `verify`                                        | A tool schema is one a client would refuse or mangle                              |
| `bun run surface:check`                   | `verify`                                        | The build, in either protocol era, differs from `tool-surface.json`               |
| `test/openai-submission.test.ts`          | `verify`                                        | A hint differs from the submission, or text uses wording that contradicts a hint  |
| `bun run contracts:deployed:check`        | `verify`, daily, and before each deploy         | The Luca pin or OpenAPI snapshot differs from production                          |
| `bun run surface:live`                    | After each deploy, and daily                    | The hosted server, in either protocol era, differs from its release               |
| `bun run sweep`                           | Weekly and before each release, in setluca/luca | A tool does not do what the plan expects, or a read-only tool writes an audit row |
| [Handler audit](./runbooks/tool-audit.md) | Before each directory submission                | A hint or a claim does not match what the handler does                            |

None of the automatic checks can tell whether a hint is true of the handler,
because they compare what we wrote with other things we wrote. The sweep comes
closest, and only for audit rows. That is what the audit is for. Moving hints into
Luca's route policy, where a test can hold them to the route, is the fix for that.

A scheduled check that fails opens one GitHub issue, and closes it when it passes
again. `scripts/setup-drift-checks.sh` sets up the keys and tokens these need; run it
again to rotate one. Until then the checks that need one skip with a warning.

### The tool surface

`tool-surface.json` is what the server tells a client, as the MCP Inspector CLI
reads it: every tool's hints, title, and description, hashes of its schemas, and the
prompts, resources, and server instructions. A change to any of them shows up in the
pull request that makes it. After an intended change:

```bash
bun run build
bun run surface:generate
```

### The Luca contract

The server depends on Luca's public API contract.

`contracts/source.json` pins the exact commit reported by Luca production's
`/health` endpoint and records a digest for each copied contract file. CI and
the daily drift check compare that commit and the OpenAPI snapshot with the
deployed API, then check the local digests. The live OpenAPI and snapshot are
compared as JSON because their formatting differs. A Luca release can change
production without changing `master` at the same moment, and a rollback can
move it back.
Each production deploy of Luca opens a pull request here with the contracts it now
serves (`.github/workflows/mcp-contract-sync.yml` in setluca/luca). If nothing a tool
exposes changed, it merges itself once `verify` passes. Otherwise its body lists each
changed route next to its tool, and a person has to compare the route's new text with
the tool's hints and text, because a route can change what it does while only its
description says so.

To refresh by hand after a deployed release or rollback, use a local Luca checkout:

```bash
bun run contracts:sync --repo /path/to/luca --deployed --write
bun run openapi:generate
bun run docs:generate
bun run build
bun run surface:generate
bun run contracts:report
bun run verify
```

`--ref SHA` is available for preparing a future contract change, but the
release gate will pass only when the resulting pin matches production.

To verify every snapshot against the private Luca source tree as well, run
`bun run contracts:sync --repo /path/to/luca --deployed --check` with a local
Luca checkout. The GitHub check uses the deployed API and recorded digests;
the Luca repository does not permit read-only deploy keys for cross-repository
checkout.

The operation coverage check also works against the pinned snapshot:

```bash
bun run openapi:check
```

This verifies that every operation under `src/operations/groups/` still exists in the
`contracts/openapi.json` snapshot. Pass `--live` to check the deployed
`https://api.setluca.com/openapi.json` instead:

```bash
bun scripts/check-openapi.ts --live
```

Generated docs are checked separately:

```bash
bun run docs:check
```

## Dependency updates

Dependency versions are managed in this repo's `package.json`. After updating, run:

```bash
bun run verify
```

The server runtime is `@modelcontextprotocol/server`, the 2.0 package family
implementing protocol revision 2026-07-28. Tests drive it through
`@modelcontextprotocol/client`. When updating either, check the SDK docs for
changes to `McpServer`, `serveStdio`, `createMcpHandler`, tool schemas,
resource registration, and prompt registration.

Two behaviors of that runtime are load-bearing here. `createMcpHandler`
defaults to `legacy: 'stateless'`, which keeps a client still speaking the 2025
revision working against the same server factory. Dropping it would strand those
clients. And `responseMode` defaults to `'auto'`, so a request
whose `Accept` includes `text/event-stream` comes back as SSE framing rather
than a plain JSON body.

Tool and prompt schemas are Effect schemas. `src/standard-schema.ts` hands them
to the SDK as Standard Schema: Effect validates the arguments, and the JSON
Schema a client reads is generated from the same Effect schema, keeping the
`x-luca-*` annotations. Don't register raw Zod shapes, and don't add Zod back.
[ADR 0033](./adr/0033-effect-first-mcp.md) records why.

## Server identity and cache hints

`LUCA_SERVER_INFO` in `src/server.ts` is the one place this server describes
itself. It carries the name and version plus the title, description, and
website the 2026-07-28 revision added, and a client renders those in its
server list instead of the bare package name. The Worker's
`/.well-known/mcp/server-card.json` body is built from the same constant, so a
client that reads the card and a client that connects cannot be told two
different things. Changing the wording means changing it once, and both test
suites assert against the constant rather than a copied literal.

The icons are `LUCA_SERVER_ICONS`, and only the server card carries them.
claude.ai abandons a session whose `initialize` answer has `serverInfo.icons`
([anthropics/claude-ai-mcp#474](https://github.com/anthropics/claude-ai-mcp/issues/474)),
so the handshake leaves them out until that is fixed.

That well-known card is not replaced by `server/discover`. The card is an
unauthenticated HTTP GET that anything crawling the domain can read, and the
website and the A2A catalog both link to it. `server/discover` is a JSON-RPC
method on `/mcp` behind bearer auth. Different audiences, so both stay.

`LUCA_CACHE_HINTS` (also `src/server.ts`) tells a client how long it may reuse
the static lists: one hour on `tools/list`, `prompts/list`, `resources/list`,
`resources/templates/list`, and `server/discover`. The tool list is 225
descriptions that change only on redeploy, so re-sending it per connection is
waste. An hour bounds how long a redeploy stays invisible, and a client calling
a tool the list no longer names gets an ordinary error rather than a wrong
answer. The scope is `private` throughout because the tool list varies with the
`?toolset=` query param. `resources/read` is left out on purpose. It returns
live coach data and keeps the SDK's conservative no-caching default. The hint
rides a symbol-keyed property that is never serialized, so a 2025-revision
client's responses are unchanged.

## Pre-PR checklist

1. `bun run docs:generate`. It writes three files: `docs/tools.md`,
   `docs/prompts-and-resources.md`, and `docs/scopes.md`. `docs:check`, inside
   `verify`, names each one that is stale.
2. `bun run verify`
3. `bun run typecheck` and `bun run lint`.
4. Check `README.md` and `docs/` for changed behavior.

## Changing the public API

When an `apps/api` change touches a public route:

1. `bun --cwd apps/api run openapi:snapshot`
2. After the Luca release deploys, run
   `bun run contracts:sync --repo /path/to/luca --deployed --write` here.
   Use `--ref SHA` to prepare an MCP change before Luca deploys, then refresh
   from production before merging or releasing it.
3. Run `bun run openapi:generate` and `bun run docs:generate` here.
4. Commit the contract snapshots and regenerated MCP files together in this repo.
5. Add a `CHANGELOG.md` entry under `Unreleased` for anything a client can see.

## Future work

- Add broader live integration fixtures once Luca test credentials and
  disposable workspaces exist.
