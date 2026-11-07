# Working on Luca MCP

## Before changing code

- This repository owns the MCP server. Luca's deployed API owns the contracts in
  `contracts/`, so pin the Luca production commit, not a branch tip.
- The stdio entry is `src/index.ts`; the Cloudflare Worker entry is
  `src/worker.ts`. Both use the same tool catalog under `src/operations/`.
- Use Effect Schema for first-party validation. Zod stays out of our imports and
  dependencies, though the MCP SDK may still depend on it internally.
- Keep secrets out of logs and stdout. Stdout belongs to the stdio protocol.
- Treat `src/generated/`, `tool-surface.json`, and the three generated docs as
  outputs. Run the generators instead of editing them by hand.

## Check a change

```bash
bun install --frozen-lockfile
bun run verify
```

`verify` runs every check CI runs except the Worker and npm dry runs. Its last step
reads Luca production, so it needs network access. For a focused test, use
`bun run test -- test/name.test.ts`.

## Read the page for your task

- Add or change a tool: [development](./docs/development.md#add-a-luca-tool).
- Change a tool's hints, or review a contract sync that lists route changes:
  [tool audit](./docs/runbooks/tool-audit.md).
- Update contracts or dependencies: [maintenance](./docs/maintenance.md).
- Change deployment or publishing: [release](./docs/release.md).
- Run every tool against a live workspace, only on `support@setluca.com`:
  [sweep](./docs/inspector.md#sweep-every-tool).
- Anything else: the [documentation index](./docs/README.md).
