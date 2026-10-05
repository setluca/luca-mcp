# Working on Luca MCP

Start with [docs/README.md](./docs/README.md). It points to the architecture,
development guide, contract pin, security boundary, and release steps.

## Before changing code

- This repository owns the MCP server. Luca's deployed API owns the contracts in
  `contracts/`. Read [docs/maintenance.md](./docs/maintenance.md) before updating
  a contract snapshot. Pin the Luca production commit, not a branch tip.
- The stdio entry is `src/index.ts`; the Cloudflare Worker entry is
  `src/worker.ts`. Both use the same tool catalog under `src/operations/`.
- Use Effect Schema for first-party validation. Do not add a direct Zod import
  or dependency. The MCP SDK may still depend on Zod internally.
- Keep secrets out of logs and stdout. Stdout belongs to the stdio protocol.
- Treat generated files under `src/generated/` and the three generated docs as
  outputs. Run the generators instead of editing them by hand.

## Check a change

```bash
bun install --frozen-lockfile
bun run verify
```

`verify` runs formatting, lint with warnings denied, Knip, Fallow, generated
file checks, TypeScript, coverage, the build, stdio discovery, and the Luca
production contract check. The last check needs network access. For a focused
test, use `bun run test -- test/name.test.ts`.

Read [docs/development.md](./docs/development.md) for the tool and test workflow,
and [docs/release.md](./docs/release.md) before changing deployment or publishing.
