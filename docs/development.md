# Development

Run commands from this repository's root.

```bash
bun install --frozen-lockfile
bun run docs:generate
bun run verify
```

## Quality gates

`bun run verify` chains the whole local gate in the order below. Run it before
opening a PR.

| Script                             | What it checks                                                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `bun run quality`                  | formatting, Oxlint including anti-slop and Effect rules, Knip, and Fallow dead code, duplication, security, and health gates |
| `bun run docs:check`               | `docs/tools.md` matches the catalog                                                                                          |
| `bun run catalog:check`            | `src/generated/route-catalog.ts` matches the OpenAPI snapshot                                                                |
| `bun run openapi:inputs:check`     | `src/generated/openapi-inputs.ts`, with its Effect Schema input fields, matches the snapshot                                 |
| `bun run openapi:outputs:check`    | `src/generated/openapi-outputs.ts`, with its redacted-field lists, matches the snapshot                                      |
| `bun run openapi:check`            | every registered operation still exists in the snapshot (`--live` checks the deployed document)                              |
| `bun run registry:check`           | `server.json` version, tool count, and env vars match the code                                                               |
| `bun run typecheck`                | strict TypeScript via `tsc --noEmit`                                                                                         |
| `bun run coverage`                 | Vitest tests with 90% line, statement, and function coverage and 85% branch coverage                                         |
| `bun run build`                    | emits `dist/` with `tsc`                                                                                                     |
| `bun run test:stdio`               | starts the built stdio server and checks MCP discovery                                                                       |
| `bun run contracts:deployed:check` | pinned Luca commit and OpenAPI match the current production API                                                              |

Outside that chain:

- `bun run lint`: Oxlint with errors and warnings treated as failures.
- `bun run test:mutation`: Stryker, for the modules a change touches.
- `bun run test:integration`: opt-in live Luca API tests. See
  [integration-testing.md](./integration-testing.md).
- `bun run inspect`: MCP Inspector against the built stdio server.

CI runs this same verification gate for pushes and pull requests.

## Remote transport (Cloudflare Worker)

The stdio server deliberately has no `dev` script. The remote transport is a
separate Cloudflare Worker entry (`src/worker.ts`, deployed as `setluca-mcp` at
`mcp.setluca.com`) that wrangler bundles straight from source.
`tsconfig.build.json` excludes it, so the npm stdio package is unaffected.

- `bun run dev:remote`: wrangler dev server for the remote transport.
- `bun run deploy`: deploy the Worker (`wrangler deploy --env production`).
- `bun run deploy:dry-run`: bundle the production Worker and check its Wrangler
  configuration without changing Cloudflare.

Do not deploy by hand for a release. The `mcp-v*` tag deploys the Worker
alongside the npm publish, which is what keeps the two transports on the same
version. See [release.md](./release.md).

Bearer auth accepts a developer API key or an OAuth access token. OAuth tokens
resolve through the Luca API's `POST /oauth/resolve`. See
[the authorization server runbook](./runbooks/mcp-oauth-authorization-server.md).

## Add a Luca tool

1. Confirm the endpoint is API-key-allowed in Luca's public route policy
   (`apps/api/src/lib/public-route-policy.ts` in the Luca repo).
2. Confirm the endpoint appears in Luca's `apps/api/openapi.json`. Regenerate
   that snapshot in Luca if the route is new, commit the API change, then copy
   its contracts here:

   ```bash
   bun run contracts:sync --repo /path/to/luca --deployed --write
   ```

3. Add the operation to its group file under `src/operations/groups/`.
4. Give it exact scopes, a hand-written `title`, and whether it requires
   idempotency or a confirmation.
5. Add or update tests when request mapping changes.
6. Run:

```bash
bun run openapi:generate
bun run docs:generate
bun run verify
```

A new tool inherits the connector-directory checklist too. See
[connector-directory.md](./connector-directory.md).

## Code style

- Keep tool registration data-driven from the catalog.
- Keep HTTP behavior in `src/http.ts` and retry behavior in
  `src/resilience.ts`.
- Use typed Effect errors for expected failures.
- Do not log secrets.
- Do not write anything to stdout outside the MCP transport. The stdio
  transport owns that stream, and a stray `console.log` corrupts the protocol.
