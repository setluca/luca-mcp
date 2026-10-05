# ADR 0006: MCP remote transport and OAuth 2.1

This decision was written before the MCP moved out of Luca's `apps/mcp`.
Paths below describe the original location; current code lives in this repo.

Date: 2026-07-09

## Status

Accepted (transport shipped; OAuth authorization server implemented behind `OAUTH_AS_ENABLED`, production enablement security-review-gated)

## Context

`apps/mcp` is stdio-only. Hosted MCP clients (Claude, ChatGPT, Cursor
connectors) only reach **remote** Streamable HTTP servers, and the high-value
ones require **OAuth 2.1**. This ADR adds a remote transport alongside stdio,
without loosening the public-API trust boundary or the review-queue invariant.

The `@modelcontextprotocol/sdk` (1.29.0) ships a **Web Standard** Streamable
HTTP transport (`server/webStandardStreamableHttp.js`, `Request`→`Response`,
Workers-compatible) plus OAuth data types and handler logic. Its OAuth _router_
is Express-only, so it cannot mount in a Hono/Workers app as-is.

## Decisions

### D1 — Transport: stateless Web Standard Streamable HTTP, in `apps/mcp`

The remote handler lives in `apps/mcp/src/remote.ts` as a
`(request: Request) => Promise<Response>` fetch handler using
`WebStandardStreamableHTTPServerTransport` in **stateless** mode
(`sessionIdGenerator: undefined`): each request builds a fresh server +
transport, handles one request, tears down. Stateless suits Workers (no session
affinity) and keeps the MCP server what it already is — an API-key client — now
reachable over HTTP too. stdio (`src/index.ts`) is unchanged.

Amended after protocol revision 2026-07-28: the handler is now built by
`createMcpHandler` from `@modelcontextprotocol/server`, which owns the
transport itself, so the explicit `WebStandardStreamableHTTPServerTransport`
and its `sessionIdGenerator: undefined` no longer appear in
`apps/mcp/src/remote.ts`. The decision this ADR records is unchanged and is now
what the protocol assumes: the revision carries protocol version, client
identity, and capabilities on every request instead of a session, so a fresh
server per request is the ordinary shape rather than an opt-out. Clients on the
2025 revision keep working through `createMcpHandler`'s default
`legacy: 'stateless'` lane.

Rejected: mounting inside `apps/api`. It would force `apps/api` to import the
MCP server internals or refactor tools to call route handlers in-process. Keeping
the transport in `apps/mcp` preserves the leaf-app boundary and lets the same
package serve stdio and HTTP. `apps/api` still owns the one thing it must — the
OAuth authorization server (D3), because that needs Better Auth and Postgres.

### D2 — Auth resolution via a `TokenResolver` seam

The transport never hardcodes how a bearer token becomes a coach. It takes a
`TokenResolver`: `(token: string) => Promise<ResolvedIdentity | null>` returning
the coach-scoped `LucaConfig` (api key/base url/workspace) and the granted
scopes. Two implementations:

- **`apiKeyResolver`** (shipped): the bearer token **is** a Luca developer API
  key. Zero new privilege surface — the token maps to exactly the coach scope
  that key already grants, resolved server-side. This makes remote MCP work
  today for clients that support bearer/custom-header remote servers.
- **`oauthResolver`** (design-locked, D3): the bearer token is an
  OAuth-issued access token that the authorization server maps to a coach's
  stored API-key reference. Same `LucaConfig` shape out — the transport is
  identical either way. **The transport never changes `what` a call may do;
  it only changes `how` the call arrives.**

Missing/invalid token → `401` with a `WWW-Authenticate: Bearer` challenge and,
once D3 ships, the `resource_metadata` pointer per the MCP auth spec.

### D3 — OAuth 2.1 authorization server: in `apps/api`, Postgres-backed (gated)

The AS (authorize / token / register / revoke / metadata endpoints, PKCE
mandatory, dynamic client registration) is implemented in `apps/api` (Hono),
because it needs:

- **Consent identity from Better Auth**: the coach is already authenticated in
  the Luca app; the `/authorize` consent screen mints a code bound to _that_
  coach — no API keys pasted into a third party.
- **Persistence in Postgres via `@luca/db`**: new scoped tables for registered
  OAuth clients and issued/refresh tokens. Access tokens are opaque and stored
  hashed; they resolve server-side to a coach's API-key reference. Rejected: a
  KV-only store (tokens are security state that belongs with the system of
  record and must be revocable/auditable per tenant).

Invariants the AS must uphold (and the security review must verify):

- PKCE is mandatory (OAuth 2.1), never optional.
- Dynamic client registration can never grant scopes broader than the
  underlying API key. Scope is the **intersection** of requested scopes and the
  coach's key scopes.
- Authorization codes are single-use (replay-rejected); tokens are
  revocable and refreshable; refresh failure forces re-consent, never a silent
  scope widening.
- Every write tool still flows through `public-route-policy.ts` scopes and the
  review-queue gate. Remote exposure does not bypass the `confirm:true` gate
  or auto-send rules.

Because the AS is new attack surface adjacent to a payments system, it ships
**only after a security-focused review**. The SDK's OAuth _logic_
(PKCE verification, metadata shape, error types from
`server/auth/*`) is reused; only the Express router is reimplemented as Hono
handlers.

### D4 — Deployment

`apps/mcp` gains an HTTP entrypoint deployable as its own Cloudflare Worker
(`fetch` handler exporting the remote transport). Config (`LUCA_API_BASE_URL`,
signing keys once D3 lands) comes from the Worker env. stdio distribution
(via npm) is unaffected.

### D3 implementation note (2026-07-09)

D3 shipped via `@better-auth/oauth-provider@1.6.23` + the better-auth `jwt`
plugin inside the existing Better Auth instance (`packages/auth`), not as
hand-rolled Hono handlers — the maintained plugin already implements PKCE,
single-use codes, DCR with public-client downgrade, scope-narrowing consent,
and refresh rotation, all verified by the full-flow PGlite harness
(`apps/api/test/oauth-flow.test.ts`). Two deltas against the text above:

- **Access tokens are JWTs, not opaque**: token requests carry an RFC 8707
  `resource` (validated against `OAUTH_VALID_AUDIENCES`, the resource servers
  this issuer may mint for) and receive an audience-bound JWT; requests
  without `resource` fall back to opaque tokens that Luca's resolver rejects.
  Minting and accepting are separate: `/oauth/resolve` pins the single
  audience in `MCP_RESOURCE_AUDIENCE`, so a token minted for one resource
  server cannot be replayed against another. Revocation immediacy is
  preserved because `POST /oauth/resolve` checks the `oauth_connections` row
  (revoked → 401) and revocation deletes the vended key at the API layer.
- **Scope intersection is enforced by vending**: consent mints a hidden
  coach-scoped API key whose permissions come from
  `apiKeyScopesForCapabilityTier(consented tier)`; the public API enforces
  exactly as it does for developer keys. See
  `docs/runbooks/mcp-oauth-authorization-server.md` for the full design and its
  adversarial-review record.

The rest of D3 stands: PKCE mandatory, single-use codes, per-tenant
revocation/audit in Postgres, `confirm:true` and review-queue invariants
untouched, and **production enablement gated on the security review**
(`docs/runbooks/oauth-security-review.md`).

## Consequences

- Remote reachability with bearer-token auth is available now and fully tested;
  the OAuth hosted-connector path is unblocked by the resolver seam and the
  locked AS design, pending the mandated security review.
- New secrets (OAuth signing keys, client-secret storage) are introduced only
  when D3 is implemented — called out here so they are not a surprise.
- Observability: remote requests log auth outcome (resolved / 401) distinctly
  from stdio; once D3 lands, OAuth grant/refresh/failure are logged separately
  and repeated PKCE/registration failures alert as an abuse signal.
