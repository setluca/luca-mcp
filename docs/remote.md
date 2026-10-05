# Remote transport

Luca MCP runs over Streamable HTTP as well as stdio, so a hosted MCP client
reaches it with no local process. The design and its security invariants are in
[ADR 0006](./adr/0006-mcp-remote-transport-and-oauth.md).

The deployed Worker is `setluca-mcp` at `https://mcp.setluca.com/mcp`.

## The handler

`src/remote.ts` exports a Web Standard fetch handler, so it runs on Cloudflare
Workers, Deno, Bun, and Node 18 or newer:

```ts
import { apiKeyResolver, createRemoteHandler } from "@setluca/mcp/remote";

const handler = createRemoteHandler({
  resolveToken: apiKeyResolver({
    apiBaseUrl: "https://api.setluca.com",
    authHeader: "x-api-key",
  }),
});

export default {
  fetch: (request: Request) => handler(request),
};
```

`src/worker.ts` is the deployed entry point. It wires the same handler to the
Worker's environment and adds the discovery routes below.
[Configuration](./configuration.md#remote-worker-settings) lists the settings it
reads.

`wrangler.toml` names the top-level Worker `setluca-mcp-dev`, pointed at a local
API, so a deploy without `--env production` can't replace production.

Properties worth knowing:

- **It holds no state.** Each request builds its own server and transport, so
  there is no session affinity to lose when a Worker isolate recycles.
- **It authenticates every request.** A missing or unresolved token returns 401
  with a `WWW-Authenticate: Bearer` challenge. The token resolves to one coach's
  scope, which the Luca API enforces, so the remote path can reach nothing the
  stdio path cannot.
- **It checks the browser origin first.** A request whose `Origin` names a host
  other than the Worker's own, or one in `MCP_ALLOWED_ORIGINS`, gets a 403
  before any token is resolved. A request with no `Origin` passes.
- **It limits request rates.** A request with a token counts against that
  token, 60 a minute by default, and against the caller's address, 600 a
  minute, so a caller that sends a fresh made-up token each time still runs
  out. A request without a token counts against its address, also 600 a
  minute, which is high on purpose: many clients can share one address. The
  address comes from `CF-Connecting-IP` only, never from `X-Forwarded-For`,
  which any caller can set. `CF-Connecting-IP` is trusted because Cloudflare
  sets it on every request that reaches the Worker. Outside Cloudflare a client
  can set it, and a request without it shares one `unknown` address bucket, so
  run the Worker only behind Cloudflare. An IPv6 address counts against its /64, because
  one subscriber usually holds a whole /64, and an IPv4-mapped IPv6 address
  counts as the IPv4 address it carries. A production Worker needs all three
  bindings, `MCP_AUTH_RATE_LIMIT`, `MCP_TOKEN_ADDRESS_RATE_LIMIT`, and
  `MCP_ANONYMOUS_RATE_LIMIT`, and answers 500 and logs why when one is
  missing. Dev uses its own namespace ids, so it never shares production
  counters. Without bindings, the Worker falls back to an in-memory limit that
  lasts for the isolate. That limit tracks up to 10,000 keys and answers 429 to
  a new key once it is full, so cycling tokens cannot reset a live budget.
- **It refuses malformed tokens locally.** A token over 4,096 characters, or an
  OAuth token that is not three base64url segments, gets 401 `invalid_token`
  without a call to the API.
- **It picks the tool set per request.** `?toolset=tasks` on the URL serves the
  15 task tools plus capability discovery, and anything else serves the full 203. The query parameter wins over `LUCA_TOOLSET`.
- **stdio did not change.** `dist/index.js` still runs the same catalog.

## Bearer token clients

A client that can send a header takes a Luca API key directly:

```json
{
  "mcpServers": {
    "luca": {
      "url": "https://mcp.setluca.com/mcp",
      "headers": { "Authorization": "Bearer luca_..." }
    }
  }
}
```

## OAuth 2.1

Hosted connectors such as Claude, ChatGPT, and Cursor need OAuth 2.1, and it is
live. The authorization server lives in `apps/api`, which is where Better Auth
handles consent and Postgres stores the tokens. The Worker publishes discovery
so a client can find it:

| Endpoint                                    | Serves                                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------- |
| `/.well-known/oauth-protected-resource`     | The resource `<origin>/mcp`, its authorization server `<api>/api/auth`, and five scopes |
| `/.well-known/oauth-protected-resource/mcp` | The same metadata, at the path-suffixed location some clients try first                 |

The five scopes are `luca:read`, `luca:draft`, `luca:queue_ops`, `luca:full`,
and `luca:full_content`. The Worker doesn't serve
`/.well-known/oauth-authorization-server`. A client reads that metadata from the
authorization server in `apps/api`.

The transport itself did not change to gain this. `createRemoteHandler` takes a
`TokenResolver`, a function from a token to the coach's API config.
`apiKeyResolver` and `oauthResolver` are both resolvers. The Worker picks one
by the token's shape: a token starting with `luca_`, other than a `luca_ort_`
refresh token, goes to `apiKeyResolver`, and everything else goes to
`oauthResolver`. A malformed `luca_` token is refused without a network call.
Both resolvers take the settings the Worker read once, so a vended key reaches
the API with the same base URL, auth header, and timeout as a developer key.

`apiKeyResolver` checks a key with one `GET /api/capabilities` before it builds
a server, within 5 seconds. These answers accept the key, because each means it
authenticated:

- a 2xx
- a 400 `{ "error": "workspace_required" }`, for a key that reaches several
  workspaces when the check named none
- a 403 in the API's error shape, such as `scope_required`, for a key that
  lacks a scope for that route

A 401 refuses the key, and so does a 403 `{ "error": "forbidden" }`, for a key
that reaches no workspace and so can make no call. Any other answer, including
a 429, a timeout, or a network error, returns 503 with `Retry-After: 5`, and
nothing is cached. A key that passed is trusted for 60 seconds per isolate,
held under a hash of the key, in a cache bounded at 10,000 entries. A revoked
key can therefore keep working for up to a minute; see
[ADR 0035](./adr/0035-developer-key-revocation-window-on-the-mcp-worker.md).

### Per-tool scopes and re-authorization

Each tool lists the lowest scope that can call it in
`_meta.securitySchemes`, for example
`[{ "type": "oauth2", "scopes": ["luca:queue_ops"] }]`. ChatGPT reads this to
decide when to offer account linking. The scope is the higher of two values:

- the lowest tier that grants one of the route's API scopes
- the operation's capability tier

A task tool needs the highest scope among the operations it calls.
`oauthScopeForOperation` in `src/scopes.ts` works this out.

A tool call can fail after the transport has accepted the token. The token may
have been revoked, or the connection's scopes may not cover the tool. In those
cases the error result carries `_meta["mcp/www_authenticate"]`, which holds the
same kind of `Bearer` challenge a 401 carries. An `insufficient_scope`
challenge also names the scope the tool needs. An `invalid_token` challenge
names none, because the client must refresh or re-authorize rather than ask
for a different scope:

| API response                                    | `error` in the challenge |
| ----------------------------------------------- | ------------------------ |
| 401                                             | `invalid_token`          |
| 403 with code `scope_required` or `needs_scope` | `insufficient_scope`     |

Other 403s are left alone, because reconnecting would not fix a plan limit or a
workspace-access error. The challenge needs the protected-resource metadata
URL, which only the Worker knows, so stdio errors never carry one. See
`src/oauth-challenge.ts`.

A client that supports OAuth needs only the URL:

```json
{
  "mcpServers": {
    "luca": { "url": "https://mcp.setluca.com/mcp" }
  }
}
```

## Other public routes

| Endpoint                             | Serves                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| `/.well-known/mcp/server-card.json`  | The server card: name, version, description, icons, and tool count. Open to any origin. |
| `/.well-known/openai-apps-challenge` | The OpenAI apps domain-verification token as plain text, or 404 when none is set        |
