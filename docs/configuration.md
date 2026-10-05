# Configuration

## Environment variables

| Variable                  | Required | Default                   | Description                                                              |
| ------------------------- | -------: | ------------------------- | ------------------------------------------------------------------------ |
| `LUCA_API_KEY`            |      yes | none                      | Luca developer API key.                                                  |
| `LUCA_API_TOKEN`          |       no | none                      | Alias for `LUCA_API_KEY`. Used only when `LUCA_API_KEY` is not set.      |
| `LUCA_API_BASE_URL`       |       no | `https://api.setluca.com` | Luca API origin.                                                         |
| `LUCA_AUTH_HEADER`        |       no | `x-api-key`               | Use `x-api-key`, `authorization`, or `bearer`.                           |
| `LUCA_WORKSPACE_ID`       |       no | none                      | Default workspace id header.                                             |
| `LUCA_WORKSPACE_SLUG`     |       no | none                      | Default workspace slug header.                                           |
| `LUCA_REQUEST_TIMEOUT_MS` |       no | `30000`                   | Milliseconds one API attempt may run before it is cancelled and retried. |
| `LUCA_TOOLSET`            |       no | `full`                    | Use `full` or `tasks`. See Toolset selection below.                      |

## Authentication

By default requests include:

```http
x-api-key: luca_...
```

When `LUCA_AUTH_HEADER=authorization` or `LUCA_AUTH_HEADER=bearer`, requests
include:

```http
authorization: Bearer luca_...
```

## Workspace headers

When configured, the API client sends:

```http
x-luca-workspace-id: ...
x-luca-workspace-slug: ...
```

Tool input `workspaceId` and `workspaceSlug` override environment values for the
current call.

## Idempotency

For mutating operations that Luca marks as idempotent, the MCP server sends:

```http
idempotency-key: ...
```

If a tool call provides `idempotencyKey`, the server sends that value.
Otherwise it generates a fresh UUID for the call. Pass a stable key when
retrying the same user intent, so a replay cannot double-file the write.

## Toolset selection

`LUCA_TOOLSET=full`, the default, registers all 188 operation tools plus the 15
task tools, 203 in all. `LUCA_TOOLSET=tasks` registers only the task tools and
capability discovery, 16 in all. Use it for a coach-facing assistant that works
through intents like "book this lead a call" rather than raw API calls.
`tools.md` lists both sets. Any value other than `tasks` means `full`.

On the remote Worker, a `?toolset=` query parameter on the MCP URL wins over
`LUCA_TOOLSET`, so one deployment serves both sets:

```text
https://mcp.setluca.com/mcp?toolset=tasks
```

## Remote Worker settings

The deployed Worker in `src/worker.ts` reads its own settings from the Worker
environment. It takes no API key, since every request brings its own token.

| Setting                        | Default                   | Description                                                                                                                                                                 |
| ------------------------------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LUCA_API_BASE_URL`            | `https://api.setluca.com` | Luca API origin. OAuth discovery points clients at `<origin>/api/auth`.                                                                                                     |
| `LUCA_AUTH_HEADER`             | `x-api-key`               | How the Worker forwards the key to the API: `x-api-key`, or `authorization` (alias `bearer`). Anything else fails closed.                                                   |
| `LUCA_REQUEST_TIMEOUT_MS`      | `30000`                   | Per-attempt timeout for every API call a tool makes, in milliseconds. Token resolution uses it too, capped at 5 seconds.                                                    |
| `LUCA_TOOLSET`                 | `full`                    | Default tool set. A `?toolset=` query parameter overrides it per request.                                                                                                   |
| `MCP_PUBLIC_ORIGIN`            | the request's origin      | Public origin of the Worker, such as `https://mcp.setluca.com`. Discovery metadata names `<origin>/mcp` as the resource. A value with a path or another scheme answers 500. |
| `MCP_ALLOWED_ORIGINS`          | none                      | Comma-separated hostnames a browser `Origin` header may name besides the Worker's own host. See below.                                                                      |
| `OPENAI_APPS_CHALLENGE_TOKEN`  | none                      | Domain-verification token from the OpenAI apps portal, served at `/.well-known/openai-apps-challenge`.                                                                      |
| `MCP_AUTH_RATE_LIMIT`          | none                      | Cloudflare rate-limit binding charged per bearer token. `wrangler.toml` sets it to 60 requests per 60 seconds.                                                              |
| `MCP_TOKEN_ADDRESS_RATE_LIMIT` | none                      | Cloudflare rate-limit binding charged per client address for requests with a token. 600 requests per 60 seconds.                                                            |
| `MCP_ANONYMOUS_RATE_LIMIT`     | none                      | Cloudflare rate-limit binding charged per client address for requests without a token. 600 requests per 60 seconds.                                                         |
| `NODE_ENV`                     | none                      | `production` makes all three rate-limit bindings required. `wrangler.toml` sets it for the production environment.                                                          |

The Worker reads `LUCA_API_BASE_URL`, `LUCA_AUTH_HEADER`, and
`LUCA_REQUEST_TIMEOUT_MS` with the same parser the stdio server uses. An
unknown `LUCA_AUTH_HEADER` answers every request with 500 and logs
`mcp.config_error`, so a typo can't send keys in a header the API ignores. A
production deploy missing any of the three rate-limit bindings fails the same way, since
the fallback limiter lives in one isolate and would never add up across them.
Outside production, a missing binding falls back to in-process limits with the
same budgets.

A tool call stops after 45 seconds in total, retries and waits included,
whatever `LUCA_REQUEST_TIMEOUT_MS` says about one attempt.

The Worker checks the `Origin` header before it resolves any token. A request
with no `Origin` passes, since it doesn't come from a browser. A browser request
passes when its origin's host is the Worker's own host or one listed in
`MCP_ALLOWED_ORIGINS`. Any other origin gets a 403, which blocks DNS-rebinding
attacks from a page the coach happens to have open.

Until `OPENAI_APPS_CHALLENGE_TOKEN` is set, the challenge route returns 404.
