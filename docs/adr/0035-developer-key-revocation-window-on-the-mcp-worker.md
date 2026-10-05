# ADR 0035: Developer key revocation reaches the MCP Worker within 60 seconds

This decision was written before the MCP moved out of Luca's `apps/mcp`.
The resolver it refers to now lives in this repository's `src/resolvers.ts`.

## Status

Accepted.

## Context

The hosted MCP server at `mcp.setluca.com` accepts a developer API key as a
bearer token. Before it builds a server for a request, `apiKeyResolver` checks
the key with one `GET /api/capabilities` against the Luca API. A key that
passes is remembered per Worker isolate, under a hash of the key, for
`KEY_CHECK_TTL_MS` (60 seconds), in a cache bounded at 10,000 entries. Only
acceptances are cached. A refusal, a 429, a timeout, or a network error is
never stored.

A coach who revokes a key in settings expects it to stop working. The API
refuses a revoked key on its next check, but an isolate that has already
accepted the key keeps answering from its cache until the entry expires.
Isolates do not share memory, so there is no single place to evict from.

## Decision

Accept a revocation window of up to 60 seconds on the MCP Worker for
developer keys. After that, every isolate checks the key against the API
again and gets the 401.

- The window is the cache lifetime, `KEY_CHECK_TTL_MS` in
  `apps/mcp/src/resolvers.ts`. Raising it widens the window, so a change needs
  a new decision.
- Keys vended through OAuth are not affected. Revoking a connection sets
  `revoked_at`, and `/oauth/resolve` checks it on every call (see
  [the authorization server runbook](../runbooks/mcp-oauth-authorization-server.md)).
- Requests to `apps/api` itself check the key on every call and see a
  revocation at once. Only the Worker's pre-check is delayed, and each tool
  call it lets through still reaches the API with the revoked key. The API
  refuses those calls, so the window lets a request pass the pre-check but not
  read or change data.

## Consequences

- A revoked key stops reaching tool results within one minute, and usually
  sooner, because the API refuses each tool call as soon as the key is
  revoked.
- The Worker avoids one API round trip per request for a busy key, and the
  API avoids that load.
- The cache is per isolate and holds hashes only. It never stores the key.
- Shortening the window costs one extra `GET /api/capabilities` per key per
  isolate per interval. Sharing the cache across isolates would need a
  binding such as KV, which adds a dependency with its own propagation delay.
