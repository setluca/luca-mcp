# Maintenance

Run these checks when the public API, generated docs, dependencies, or server
identity changes.

## Drift checks

The server depends on Luca's public API contract.

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
itself. It carries the name and version plus the title, description, website,
and icons the 2026-07-28 revision added, and a client renders those in its
server list instead of the bare package name. The Worker's
`/.well-known/mcp/server-card.json` body is built from the same constant, so a
client that reads the card and a client that connects cannot be told two
different things. Changing the wording means changing it once, and both test
suites assert against the constant rather than a copied literal.

That well-known card is not replaced by `server/discover`. The card is an
unauthenticated HTTP GET that anything crawling the domain can read, and the
website and the A2A catalog both link to it. `server/discover` is a JSON-RPC
method on `/mcp` behind bearer auth. Different audiences, so both stay.

`LUCA_CACHE_HINTS` (also `src/server.ts`) tells a client how long it may reuse
the static lists: one hour on `tools/list`, `prompts/list`, `resources/list`,
`resources/templates/list`, and `server/discover`. The tool list is 203
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
2. Commit the Luca API change, then run
   `bun run contracts:sync --repo /path/to/luca --ref origin/master --write`
   here. Use the source commit's ref when it is not yet on `origin/master`.
3. Run `bun run openapi:generate` and `bun run docs:generate` here.
4. Commit the contract snapshots and regenerated MCP files together in this repo.
5. Add a `CHANGELOG.md` entry under `Unreleased` for anything a client can see.

## Future work

- Add broader live integration fixtures once Luca test credentials and
  disposable workspaces exist.
