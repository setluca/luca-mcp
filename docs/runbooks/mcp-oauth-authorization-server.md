# MCP OAuth 2.1 authorization server design

Current migration: [Better Auth 1.7 rollout](better-auth-1.7.md). It supersedes
the 1.6 package versions, forced-public registration behavior, audience options,
and plugin table inventory described in the original design below.

Date: 2026-07-09
Status: implemented and live. `OAUTH_AS_ENABLED` is `true` in production, and
the discovery, authorization, and token endpoints serve from
`https://api.setluca.com/api/auth`.
Supersedes: ADR 0006 §D3's "hand-rolled Hono handlers" implementation choice.
The D3 _invariants_ still hold; only the implementation changed.

## 1. Context and goal

`apps/mcp` ships a remote Streamable HTTP transport (`src/remote.ts`) behind a
`TokenResolver` seam. Today the only resolver is `apiKeyResolver` (the bearer
token _is_ a Luca developer API key). Hosted MCP clients — Claude connectors,
ChatGPT apps, Cursor — require OAuth 2.1 with discovery and dynamic client
registration. This design adds the OAuth Authorization Server (AS) and the
`oauthResolver` that fills the existing seam.

**Definition of done (user decision):** full production launch — working AS,
consent UI, staging validation with a real Claude connector, the
ADR-0006-mandated security review, then prod enablement.

**Default scope posture (user decision):** least-privilege. A new OAuth
connection gets read + draft capability by default; queue operations and
full-content access are explicit opt-ins on the consent screen. Every write
still passes the existing `confirm: true` tool gate and the review queue.

## 2. Approach (decided, revised after adversarial review)

Use **`@better-auth/oauth-provider@1.6.23`** — the maintained successor to
better-auth's built-in `oidc-provider`/`mcp` plugins — as the AS, installed
alongside `better-auth@1.6.23` exactly like `@better-auth/api-key` already is
(same release train, peer-dep `better-auth ^1.6.23`).

The first draft of this design targeted the built-in `mcp` plugin. The
adversarial review (§12) killed that: the built-in plugin is **deprecated**
(slated for removal, warning suppressed), its consent endpoint is binary
accept/deny (no scope narrowing — breaks the least-privilege consent UX),
its `/mcp/register` DCR path ignores both `storeClientSecret` and
`allowDynamicClientRegistration`, and it force-injects `openid profile email`
scopes that leak coach PII through id_tokens. The successor fixes all of
this — verified against its published dist (v1.6.23):

- `/oauth2/consent` accepts an optional **`scope` subset** — "if none is
  provided, all originally requested scopes are accepted" — i.e. first-class
  scope-narrowing consent (the checkbox UX).
- `storeClientSecret` is applied on **every** client-creation path (default
  `"hashed"`), with config-consistency errors on unsafe combinations.
- `allowDynamicClientRegistration` is enforced (`FORBIDDEN` without it), and
  public PKCE clients (`token_endpoint_auth_method: "none"`) are first-class —
  MCP clients carry **no client secret at all**.
- `options.scopes` **replaces** the `openid profile email offline_access`
  default instead of extending it: excluding `openid`/`profile`/`email`
  removes id_tokens and the PII side channel entirely.
- Endpoints: `/oauth2/authorize`, `/oauth2/token`, `/oauth2/register` (DCR),
  `/oauth2/consent`, `/oauth2/introspect` (RFC 7662), `/oauth2/revoke`
  (RFC 7009), `/oauth2/get-consents`, `/oauth2/delete-consent`,
  `/oauth2/public-client`, `/.well-known/oauth-authorization-server`; helpers
  `oauthProviderAuthServerMetadata` (root-mountable metadata) and
  `mcpHandler` (emits the spec-correct
  `WWW-Authenticate: Bearer resource_metadata="…"` challenge, with path-scoped
  audience support).
- Schema: four plugin tables — `oauthClient`, `oauthRefreshToken`,
  `oauthAccessToken`, `oauthConsent` — plus the `jwt` plugin's `jwks` table,
  via the Drizzle adapter we already use, added to `packages/db/src/schema/`
  following the existing hand-written `apikey` pattern (mirror the plugin's
  schema definition by hand as with `auth.ts:137`).
- DCR nuance (verified in dist): unauthenticated registration requires BOTH
  `allowDynamicClientRegistration: true` AND
  `allowUnauthenticatedClientRegistration: true`; unauthenticated
  registrations are force-downgraded to public clients
  (`token_endpoint_auth_method: "none"`) and `client_credentials` is blocked
  for them. Built-in per-endpoint rate limits exist (register: 5/min).

Rejected: the deprecated built-in `mcp` plugin (above); hand-rolling Hono
handlers around the MCP SDK's OAuth logic (far more security-sensitive code
to review); an external IdP (splits consent identity from Better Auth, new
vendor, still needs the token→coach mapping).

## 3. Architecture

Three components, each inside an existing boundary:

```
MCP client (Claude/Cursor/ChatGPT)
   │  Bearer <access token>
   ▼
mcp.setluca.com  (apps/mcp remote Worker — thin client, no DB)
   │  serves /.well-known/oauth-protected-resource (static JSON) → points at AS
   │  oauthResolver: token → one authenticated call to apps/api → vended key
   ▼
api.setluca.com  (apps/api, Hono)
   │  /.well-known/oauth-authorization-server  (root route, plugin helper)
   │  /api/auth/oauth2/*  (authorize, token, register, consent, introspect,
   │                       revoke, delete-consent)
   │  consent wrapper endpoint: mints vended key + forwards narrowed scope
   ▼
app.setluca.com  (apps/app)
   │  /oauth/consent  (branded consent screen, session-authenticated)
   │  settings → "Connected agents" (list, scopes, last used, revoke)
```

### 3.1 The vended-key model (trust boundary)

OAuth is **credential vending, not a second authorization system**. On consent
approval we mint a hidden Better Auth API key scoped to the coach, whose
`permissions` are the **intersection** of (consented scopes → capability
tiers → concrete `resource:action` permissions) with what the coach's account
allows. The access token resolves server-side to that key; the MCP server
calls the public API with it; `requireApiAccess` + `apiKeyPolicies` in
`apps/api/src/lib/public-route-policy.ts` enforce exactly as they do for any
hand-issued key. Nothing about the public API's enforcement changes.

Consequences:

- Per-connection kill switch: revoking a connection deletes the vended key —
  every in-flight and future token for that grant dies at the API layer.
- Per-connection audit attribution: API audit logs show _which_ connected
  agent acted, not just "the coach's key."
- The vended key's plaintext must be retrievable by the resolver (Better Auth
  stores only a hash), so it is stored **encrypted at rest** in Postgres using
  the existing `packages/utils/src/credentials-cipher.ts` (AES-256-GCM,
  `v1.{iv}.{ciphertext}`) — the same cipher already protecting channel
  provider tokens (`coach-integrations.ts`, DEK env `CREDENTIAL_DEK`). New
  secret: `OAUTH_VENDED_KEY_DEK` (dedicated; do not reuse `CREDENTIAL_DEK`,
  so the two can rotate independently).
- Key minting: `@better-auth/api-key`'s server-side create accepts `userId`,
  **`organizationId`** (required — our `apiKey` plugin is configured with
  `references: "organization"`), and `permissions`. The org id comes from the
  existing deterministic mapping (`packages/db/src/lookup.ts` —
  `defaultOrganizationId` / `ensureCoachForUser`).

### 3.2 New table: `oauth_connections`

In `packages/db/src/schema/` (additive migration), alongside the plugin's
client/consent/token tables:

| column                                     | notes                                                                |
| ------------------------------------------ | -------------------------------------------------------------------- |
| `id`                                       | pk                                                                   |
| `coach_id`                                 | tenant scope, FK coaches — every query goes through `createScopedDb` |
| `user_id`                                  | Better Auth user                                                     |
| `client_id`                                | FK → the plugin's OAuth client table                                 |
| `apikey_id`                                | FK → apikey (the vended key)                                         |
| `encrypted_api_key`                        | vended key plaintext, encrypted at rest (§3.1)                       |
| `scopes`                                   | granted OAuth scopes (post-narrowing, post-intersection)             |
| `client_name`                              | denormalized for the settings UI                                     |
| `created_at`, `last_used_at`, `revoked_at` | lifecycle + UI                                                       |

One row per (coach, client) grant. Re-consent updates the row (and re-mints
the key if scopes changed). Revocation sets `revoked_at`, deletes the vended
`apikey` row, revokes outstanding tokens (`/oauth2/revoke`), **and deletes
the plugin's consent record (`/oauth2/delete-consent`)** — without that last
step the plugin would silently skip the consent screen on reconnect and our
minting step would never run.

### 3.3 Scope model (reuses the agent scope tiers — no parallel taxonomy)

OAuth scopes are the agent scope tiers from `@luca/schemas`
`agent-scope.ts`, plus
`offline_access` (required for refresh tokens). `openid`, `profile`, and
`email` are **excluded** from the configured scope list — no id_tokens, no
PII disclosure, and `/.well-known/openid-configuration` correctly 404s (we
are a pure OAuth 2.1 AS, not an OIDC IdP).

| OAuth scope         | Agent scope tier                | consent default                       |
| ------------------- | ------------------------------- | ------------------------------------- |
| `luca:read`         | capability `read`               | required baseline, always granted     |
| `luca:draft`        | capability `draft`              | pre-checked (DEFAULT_CAPABILITY_TIER) |
| `luca:queue_ops`    | capability `queue_ops`          | unchecked, opt-in                     |
| `luca:full`         | capability `full`               | unchecked, opt-in, extra warning copy |
| `luca:full_content` | data sensitivity `full_content` | unchecked, opt-in                     |

- The consent screen renders the **intersection of the client's requested
  scopes and the checkbox model**; the coach's selections post to the consent
  wrapper as the narrowed `scope` subset — enforced by the plugin's own
  `/oauth2/consent` `scope` parameter, so the issued token's scopes match
  what the coach actually approved (protocol-level truth, not advisory).
- Tier → concrete `resource:action` permissions: a canonical
  `permissionsForCapabilityTier()` map lives in `apps/api`'s
  `public-route-policy.ts` (it owns the policy source of truth), with a drift
  test cross-checking the `api-key-policies.json` snapshot and the MCP
  manifest's `requiredScope` per operation, so the map cannot silently rot.
- Intersection uses `scopeSatisfies()` from `@luca/schemas`.
- Honest limitation: `luca:full_content` is recorded and vended, but
  API-layer redaction enforcement is separately gated work. Until
  that lands, data-sensitivity scope affects what is _vended_ (redacted-tier
  grants exclude routes/permissions that return verbatim message content,
  per the tier map) rather than row-level redaction.

## 4. Configuration

`packages/auth/src/server.ts` — add to `createAuth()`:

```ts
oauthProvider({
  loginPage: `${appUrl}/sign-in`,
  consentPage: `${appUrl}/oauth/consent`,
  allowDynamicClientRegistration: true, // enforced by this plugin
  scopes: [
    "offline_access",
    "luca:read",
    "luca:draft",
    "luca:queue_ops",
    "luca:full",
    "luca:full_content",
  ], // REPLACES the openid/profile/email default
  // PKCE is required for authorization-code flows (OAuth 2.1); verify the
  // plugin's per-client `require_pkce` default and pin it on registration.
  accessTokenExpiresIn: 3600, // 1h
  refreshTokenExpiresIn: 60 * 60 * 24 * 30, // 30d
  codeExpiresIn: 600, // 10min, single-use
});
```

- **JWT plugin enabled** (resolves §11.1): access tokens are JWTs signed via
  the `jwt` plugin's JWKS (the plugin's default and its officially supported
  verification path — `verifyAccessToken` from `better-auth/oauth2`).
  Revocation stays immediate because `/oauth/resolve` also checks the
  `oauth_connections` row (`revoked_at`) on every call, and the vended key is
  deleted at revoke. Refresh tokens are opaque and stored hashed. The jwt
  plugin's session-token sidechannel is disabled (`disabledPaths: ["/token"]`
  per the official docs pattern).
- Refresh tokens carry the `luca_ort_` prefix (`prefix.refreshToken`) so
  they are secret-scanner-friendly and visually distinct from developer API
  keys (`luca_`). Access tokens are JWTs (no prefix); the remote Worker's
  resolver dispatches on shape — developer-key-shaped bearers go to
  `apiKeyResolver`, everything else to `oauthResolver`.
- `AuthEnv` gains `appUrl` (already known in every deploy env).
- Feature flag: `OAUTH_AS_ENABLED` on `apps/api` gates the root discovery
  route and the plugin registration; off = today's behavior exactly.

## 5. Data flows

### 5.1 Connect (once per client)

1. Client hits `mcp.setluca.com/mcp` without a token → `401` with
   `WWW-Authenticate: Bearer
resource_metadata="https://mcp.setluca.com/.well-known/oauth-protected-resource"`
   (shape borrowed from the plugin's `mcpHandler`; emitted by `remote.ts`).
2. Client fetches protected-resource metadata — **static JSON served by the
   MCP Worker itself** (RFC 9728: `resource` is the path-scoped
   `https://mcp.setluca.com/mcp`, `authorization_servers:
["https://api.setluca.com"]`). The Worker has no DB and calls no plugin
   code for this. → Client fetches root
   `/.well-known/oauth-authorization-server` on the AS (Hono root route
   calling `oauthProviderAuthServerMetadata`).
3. Registration, one of two ways. A client that names an https URL as its
   `client_id` registers through a Client ID Metadata Document: the AS
   fetches and validates the document instead of taking a registration
   request ([ADR 0034](../adr/0034-client-id-metadata-documents.md)). Any
   other client uses DCR: `POST /api/auth/oauth2/register` as a **public
   client** (`token_endpoint_auth_method: "none"`, PKCE), rate-limited.
   Either way the registration is inert until first consent (it grants
   nothing by itself).
4. PKCE authorize: client → `/api/auth/oauth2/authorize`. No app session →
   `loginPage` → sign-in → back to consent. Coach sees the `apps/app`
   consent screen: client name/icon + capability checkboxes per §3.3 with
   plain-English descriptions ("Draft replies for your review", "Approve and
   send queued drafts", …). Decline → standard OAuth `access_denied`
   redirect, nothing persisted.
5. Approve → the consent page posts the coach's selections to a **consent
   wrapper endpoint in `apps/api`** (session-authenticated, same-origin as
   Better Auth) which, in order: (a) computes the narrowed scope set +
   permission intersection, (b) mints the vended key and writes the
   `oauth_connections` row, (c) forwards to the plugin's
   `POST /oauth2/consent` with `accept: true` and the narrowed `scope`, and
   (d) returns the plugin's `redirect_uri` to the browser. If (c) fails,
   compensate: delete the just-minted key + connection row + any plugin
   consent row for the (user, client) pair — the last one so a failed
   RE-consent cannot leave a consent that skips the screen while no vended
   key exists (no orphaned credentials, no dead-end grants).
   No fragile plugin hook required — the wrapper _is_ the hook (adversarial
   finding §12 F-6).
6. Client exchanges the single-use code at `/api/auth/oauth2/token` (PKCE
   verified) → opaque access + refresh tokens.

### 5.2 Every tool call

1. `Authorization: Bearer <access token>` → `mcp.setluca.com/mcp`.
2. `oauthResolver` makes **one authenticated call** to `apps/api`
   (`POST /oauth/resolve` — its own mount, NOT under the session-gated
   `/api/*` or the api-key surface: it authenticates by the OAuth bearer
   token itself and is rate-limited): the API verifies the JWT access token
   in-process (`verifyAccessToken` from `better-auth/oauth2` against the jwt
   plugin's JWKS, checking issuer + audience), loads the non-revoked
   `oauth_connections` row for that grant (sub + client), decrypts the vended
   key, and returns `{ apiKey, scopes }` — only ever for the presenting
   token's own grant. The resolver builds the same `LucaConfig`
   `apiKeyResolver` returns and ignores `scopes`, because the API enforces
   them on every call. Expired/revoked/unknown → 401 → client
   refreshes or re-consents. A token that is not a compact JWT, or is
   longer than 8,192 characters, gets the same 401 before any other work.
   The rate limiter runs after signature verification and is keyed on a
   hash of the token, so a forged token gets its 401 without spending a
   real grant's budget. The Cloudflare rate limiter binding decides where
   it exists; elsewhere a fixed one-minute KV window allows 60 resolves per
   token. Past the limit the API answers 429
   `rate_limited`, and if the limiter itself fails it answers 503
   `rate_limit_unavailable` and logs `oauth.resolve.rate_limit_unavailable`
   with the cause. Tokens are rejected when they lack `exp` or `iat`. When
   the API cannot finish the check
   (signing keys, database, or the stored key's decryption unavailable) it
   answers 503, and the Worker passes a 503 with `Retry-After: 5` to the
   client instead of a 401 that would read as a revoked grant. (The MCP
   Worker stays a thin client: no DB, no decryption secret, no plugin code.)
3. Tool executes with the vended key; `requireApiAccess` enforces route
   policy; `confirm: true`, untrusted-content framing, review queue — all
   unchanged.
4. `last_used_at` updated (throttled, e.g. at most once/minute) for the
   settings UI.

### 5.3 Refresh, revoke, re-consent

- Refresh rotates the access token; scopes can never widen on refresh;
  refresh failure → re-consent, never silent scope change.
- Coach settings → "Connected agents": list (client name, scopes granted,
  connected date, last used), revoke button. Revoke = delete vended key +
  revoke tokens + **delete the plugin consent record** + set `revoked_at`
  (§3.2). Next tool call 401s; next connect attempt gets a real consent
  screen, which re-mints through the wrapper.
- Re-consent (client asks for more scope): full authorize flow again; new
  narrowing + intersection; key re-minted; audit event recorded.

## 6. Error handling

- Protocol errors: the plugin's standard OAuth error responses
  (`invalid_grant`, `invalid_client`, `access_denied`, …).
- Resolver failures: a rejected token gets 401 + `WWW-Authenticate`
  challenge (with `resource_metadata` pointer), matching `remote.ts`. A
  check the API could not finish gets 503 with `Retry-After: 5` and logs
  `oauth.resolve.unavailable`, so a server fault never forces a re-consent.
- Revoke failures: when the signing keys cannot load, `/oauth/revoke`
  answers 503 `oauth_unavailable` and logs the failure, rather than
  reporting a revocation it could not verify.
- Consent-screen failures (expired authorize state, unknown client,
  declined): explicit error page states in `apps/app`, never a hang or a
  blank page. Wrapper-endpoint failure mid-sequence compensates (§5.1.5).
- DCR abuse: rate limit on `/oauth2/register` (Better Auth rate limiting +
  CF), registrations inert until consent, alert on registration spikes.
- Encryption-key unavailable / decrypt failure: 503, logged at error level
  — fail closed, never fall back to broader credentials.

## 7. Security invariants (carried from ADR 0006 + this design)

1. PKCE mandatory for the authorization-code flow; codes single-use and
   replay-rejected.
2. DCR can never grant scopes beyond the coach's account: token scopes are
   narrowed at consent (protocol-level) AND vended permissions are an
   intersection computed server-side (API-level) — two independent fences.
3. Refresh never widens scope; re-consent required for widening.
4. Tokens opaque, stored hashed; vended keys encrypted at rest; revocation
   kills the vended key (API-layer dead, not just AS-layer) and the standing
   consent record.
5. Tenant isolation: `oauth_connections` reads/writes via `createScopedDb`;
   `/oauth/resolve` returns data only for the presenting token's own
   grant; cross-tenant token guessing yields 401, indistinguishable from
   invalid.
6. Remote exposure bypasses nothing: `confirm: true` gate, review queue,
   auto-send rules, untrusted-content framing all apply identically.
7. No PII side channel: `openid`/`profile`/`email` scopes are not offered;
   no id_tokens are issued; the consent screen lists everything a connection
   can see or do.
8. Fail closed everywhere (missing config, decrypt failure, drift between
   consent scopes and vended permissions → deny).
9. Observability: structured events for grant / refresh / revoke / 401s;
   repeated PKCE or DCR failures alert as abuse signals; vended-key API
   calls carry the connection id for audit attribution.

## 8. Testing

- **Unit**: scope narrowing + intersection (never exceeds coach account or
  client request; defaults least-privilege; unknown scopes rejected),
  tier→permissions map drift test (vs. `api-key-policies.json` + MCP
  manifest), vended-key encrypt/decrypt round-trip, resolver null-paths
  (expired, revoked, garbage token), consent-wrapper compensation path.
- **Integration** (PGlite + the existing test harness): full PKCE flow —
  register (public client) → authorize → consent(narrowed accept) → token →
  MCP tool call over the remote transport with the issued token → refresh →
  revoke → next call 401s → reconnect shows a real consent screen and
  re-mints. Consent-decline path persists nothing.
- **Regression**: the existing 66-tool protocol suite runs unchanged against
  an OAuth-resolved identity; `apiKeyResolver` path untouched (both
  resolvers coexist).
- **Hostile cases**: code replay (second exchange rejected), PKCE downgrade
  (no verifier → rejected), scope-widening refresh attempt, consent-wrapper
  called with scopes the client never requested (rejected), cross-tenant
  token/connection guessing, vended key used directly against a route
  outside its permissions (403 from `requireApiAccess`), token used after
  revoke-but-before-expiry (401 via connection lookup).
- **E2E (staging)**: real Claude connector connect → narrowed consent → tool
  call → revoke → reconnect.

## 9. Rollout

1. Implement behind `OAUTH_AS_ENABLED` (off in prod).
2. Migrations (plugin OAuth tables + `oauth_connections`) — additive.
3. Staging: enable, validate with a real Claude connector end-to-end
   (including §11.3's client-probing question).
4. Security review (ADR-0006-mandated, external gate): §7 + §12 are the
   checklist skeleton; produce the threat model alongside implementation.
5. Prod enable; publish connection docs (`apps/mcp/docs/remote.md` update);
   update ADR 0006 (D3 implementation = `@better-auth/oauth-provider`;
   status → fully accepted).
6. Hand off to AS16 (install page), AS17 (Claude directory), AS20 (ChatGPT),
   AS21 (A2A) — all consume this AS.

## 10. Out of scope

- The distribution tickets themselves (AS16/17/20/21).
- API-layer redaction enforcement for the data-sensitivity tier (separately
  gated; §3.3 notes the interim vending-level behavior).
- npm publish flip (LUC-42, separate trivial step).
- Event-driven MCP (AS13) and any Event Spine work.

## 11. Open questions (tracked, non-blocking)

1. ~~JWT-plugin coupling~~ **Resolved during planning**: the `jwt` plugin is
   enabled (§4) — JWT access tokens verified in-process via JWKS; revocation
   immediacy preserved by the per-call `oauth_connections` check.
2. `mcp.setluca.com` vs. serving the remote Worker on a path of
   `api.setluca.com`: dedicated subdomain assumed (cleaner protected-resource
   metadata); confirm DNS/Workers routing at deploy.
3. Whether Claude's connector flow also probes AS metadata on the _MCP_ host:
   if so, the MCP Worker serves a static copy — trivial, verify in staging.
4. ~~`offline_access` gating~~ **Resolved at implementation**: the plugin
   issues a refresh token only when the granted scopes include
   `offline_access` (verified in the flow harness); omitting it degrades
   gracefully to access-token-only.

## 11a. Implementation deltas (2026-07-09)

Discovered while building against `@better-auth/oauth-provider@1.6.23`;
everything else shipped as specified.

- **JWT access tokens require RFC 8707 `resource`** — the plugin mints a JWT
  only when the token request names a resource in `validAudiences`
  (`OAUTH_VALID_AUDIENCES`, prod `https://mcp.setluca.com/mcp`); otherwise it
  falls back to an
  opaque token, which `/oauth/resolve` rejects. That variable is the _minting_
  allowlist and nothing more — `/oauth/resolve` verifies against the single
  audience in `MCP_RESOURCE_AUDIENCE` (prod `https://mcp.setluca.com/mcp`), so
  a token bound to another resource server cannot be exchanged for a
  coach-scoped product API key. Unset, it fails closed with the same uniform 401.
  MCP clients are required by the MCP authorization spec to send `resource`,
  so this is the correct fail-closed posture. The JWT's claims (pinned in the
  flow test): `sub` = user id, `azp` = client id (no `client_id` claim),
  `scope` = space-joined string, `iss` = `${API_URL}/api/auth`,
  `aud` = the resource URL.
- **The consent state travels as a signed query, not a cookie** — the plugin
  redirects to the consent page with the signed pending request in the URL;
  the consent POST must return it verbatim as `oauth_query`. The wrapper
  (§5.1.5) forwards it and the plugin re-verifies the signature.
- **`clientRegistrationAllowedScopes` must list the full catalog** — with
  only `clientRegistrationDefaultScopes` set, DCR rejects registrations
  requesting elevated scopes; clients may _request_ anything in the catalog,
  the consent screen decides what they _get_.
- **AS discovery is served at two paths** — the issuer includes the
  `/api/auth` mount, so `apps/api` answers both
  `/.well-known/oauth-authorization-server` and the RFC 8414 path-inserted
  `/.well-known/oauth-authorization-server/api/auth`; the protected-resource
  metadata points `authorization_servers` at `${API_URL}/api/auth`.
- **Payment gate exemption** — `/api/oauth-connections` is exempt from the
  payment gate: revoking a connected agent is a security action and must
  never be pay-walled (the OAuth grant/consent surface at `/oauth` sits
  outside the gated `/api` mutations entirely; the vended key's API calls
  remain fully gated).

## 12. Adversarial review record (2026-07-09)

Two independent reviews ran against the first draft: a context-loaded
security attack and a cold-read fact-check against the plugin dist and this
repo. Dispositions:

| #    | Finding (severity)                                                                                                     | Disposition                                                                                                                   |
| ---- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| F-1  | Built-in plugin consent is binary accept/deny — checkbox UX impossible (blocker)                                       | **Fixed by rebase**: successor's `/oauth2/consent` takes a narrowed `scope` subset (§2, §3.3)                                 |
| F-2  | `/mcp/register` stored client secrets in plaintext, ignoring `storeClientSecret` (blocker)                             | **Fixed by rebase**: successor hashes on every path; MCP clients are public/secretless (§2, §5.1.3)                           |
| F-3  | `oidc-provider` is deprecated; `mcp` plugin suppresses the warning (blocker)                                           | **Fixed by rebase**: `@better-auth/oauth-provider@1.6.23` is the maintained successor, version-locked to our better-auth (§2) |
| F-4  | `allowDynamicClientRegistration` not enforced on `/mcp/register` (major)                                               | **Fixed by rebase**: successor enforces it (§2); rate limiting retained (§6)                                                  |
| F-5  | Forced `openid profile email` scopes leak coach name/email via id_token, invisible to consent UI (major)               | **Fixed by config**: successor's `scopes` replaces the default; OIDC scopes excluded (§3.3, §7.7)                             |
| F-6  | No hook point to mint the vended key at consent time; global `hooks.after` on deprecated internals is fragile (major)  | **Designed out**: our consent wrapper endpoint mints-then-forwards with compensation (§5.1.5)                                 |
| F-7  | Advertised `userinfo`/`jwks` endpoints 404 in built-in plugin (minor)                                                  | **Moot after rebase** (real endpoints exist; unused without `openid`)                                                         |
| F-8  | `oAuthProtectedResourceMetadata` helper needs a live auth instance — unusable in the DB-less Worker (minor)            | **Fixed**: Worker serves static RFC 9728 JSON; no plugin code in the Worker (§5.1.2)                                          |
| F-9  | Vended-key minting needs `organizationId` (apiKey plugin uses `references: "organization"`) (minor)                    | **Documented**: deterministic org mapping via `defaultOrganizationId` (§3.1)                                                  |
| F-10 | Protected-resource `resource` must be path-scoped to `/mcp` per RFC 9728 (minor)                                       | **Fixed**: static metadata uses the path-scoped resource id (§5.1.2)                                                          |
| F-D  | Plugin skips the consent screen when a consent record exists → reconnect-after-revoke would 401 forever (fork finding) | **Fixed**: revoke deletes the consent record via `/oauth2/delete-consent`, forcing real re-consent (§3.2, §5.3)               |

Residual items for the security review: §11 open questions, the
consent-wrapper compensation path (§5.1.5), and independent verification of
the successor plugin's PKCE/replay behavior (§8 hostile cases).
