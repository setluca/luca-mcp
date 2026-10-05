# ADR 0033: Effect-first `apps/mcp`

## Status

Accepted. Supersedes [ADR 0002](./0002-effect-ts-boundaries.md) for
`apps/mcp`.

## Context

`apps/mcp` exposes the Luca public API to MCP clients over stdio and over a
Cloudflare Worker. It was written to ADR 0002, so Effect appeared only at a
few IO calls. Everything around them was async code with `try`/`catch`,
hand-written retries, `console.log`, and zod schemas. Failures lost their type
between modules, and tests stubbed `fetch` and the module system to replace a
dependency. One bug came straight from this: the logger wrote to stdout, which
the stdio transport also uses for JSON-RPC, so every tool call put a stray
line on the protocol stream.

Effect 4 ships an MCP server in `effect/unstable/ai` (`McpServer`,
`McpSchema`, `Tool`, `Toolkit`). At 4.0.0-rc.115 it cannot replace the
official SDK here:

- It does not speak protocol 2026-07-28, which the SDK's stateless handler
  does.
- Its HTTP layer keeps sessions in an in-memory map. A Worker isolate cannot
  keep that map between requests.
- It has no bearer-token hook and always writes tool output with
  `JSON.stringify`.

## Decision

`apps/mcp` is Effect-first, with the official MCP SDK kept only at the
transport edge.

- `@modelcontextprotocol/server` owns the transport: `createMcpHandler` for
  the Worker and `serveStdio` for the local binary. Tool, prompt, resource,
  and completion callbacks are the seam. Each callback runs one Effect program
  with the request's abort signal.
- Every module that performs IO exposes `Effect.Effect<A, E, R>`. Named
  operations use `Effect.fn("<module>.<operation>")`.
- Expected failures are `Schema.TaggedError` classes. One table maps them to
  MCP tool errors and HTTP statuses.
- Configuration is read with `Config`. The API key is `Config.redacted`.
- Calls to the Luca API go through `HttpClient`. Retries use `Schedule`.
  Timers use `Effect.sleep` and `Effect.timeout`. The abort signal reaches
  `fetch`.
- Dependencies a test would replace (the Luca API client, the token resolver,
  the rate limiter, the clock) are `Context.Service`s with a production
  `Layer`.
- Programs log with Effect's logger. The stdio entry point installs a JSON
  logger that writes to stderr and never to stdout.
- Effect Schema is the only schema library. Tool input and output schemas
  reach the SDK as Standard Schema with JSON Schema
  (`Schema.toStandardSchemaV1` and `Schema.toStandardJSONSchemaV1`). Untrusted
  input (JSON text, URLs, tokens, cursors) is decoded with Schema, not
  wrapped in `try`/`catch`. zod is removed from `apps/mcp`.
- `Effect.runPromise` and its variants appear only in the SDK callbacks, the
  Worker `fetch` export, and script entry points.
- There is no process-wide `ManagedRuntime`, for the same reason as
  [ADR 0028](./0028-effect-first-api-lib-modules.md): Worker bindings arrive
  per request.
- Scripts under `apps/mcp/scripts` are Effect programs that use `FileSystem`,
  `Path`, and `Console`. Tests use `@effect/vitest` and provide layers in place
  of module mocks.

We will revisit `effect/unstable/ai` for the transport when it supports
protocol 2026-07-28, stateless HTTP, and bearer auth.

## Consequences

- A failure keeps its type from the API call to the tool result, and one table
  decides what an MCP client sees.
- The stdio stream carries only JSON-RPC.
- Tests swap layers instead of patching `fetch`.
- Contributors to `apps/mcp` need to read Effect, as they already do for
  `apps/api` and `apps/worker`.
- Two MCP stacks sit in the dependency tree until Effect's server catches up.
  Only the SDK's handles the wire.
