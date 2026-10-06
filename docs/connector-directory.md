# Connector directories

We plan to list Luca in two directories: the Claude connectors directory and
the ChatGPT apps directory. This page records where Luca stands against each.
The Claude requirements come from
https://claude.com/docs/connectors/building/submission.

Both directories take remote servers only, so the thing being submitted is
`https://mcp.setluca.com/mcp` (streamable HTTP), not the npm stdio package.
The npm package and the MCP registry listing are a separate distribution path,
covered in [release.md](./release.md).

## What the code already satisfies

These hold for both directories unless a row says otherwise.

| Requirement                                               | How it is met                                                                                                                                                                                                     |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool names at most 64 characters                          | 203 tools, longest is 48                                                                                                                                                                                          |
| Every tool carries a `title`                              | `check-registry.ts` rejects missing or machine-shaped operation titles; the protocol test checks every title in `tools/list`                                                                                      |
| Safety hints on every tool                                | `src/annotations.ts` derives the hints from the route and catalog; the protocol test checks their presence, read-only consistency, and representative outside-world actions                                       |
| Real-world side effects wait for the user                 | 28 operations and 5 task tools reject a call without `confirm: true`. See [security.md](./security.md#confirmation-gate-for-destructive-tools)                                                                    |
| Server instructions                                       | `LUCA_SERVER_INSTRUCTIONS` in `src/server.ts` names the starting tools, the confirm rule, and that lead-authored text is untrusted                                                                                |
| Server name, title, website, and icons                    | `LUCA_SERVER_INFO` in `src/server.ts` carries the title, `https://setluca.com`, and SVG and 512px PNG icons. The server card at `/.well-known/mcp/server-card.json` repeats them                                  |
| ChatGPT domain verification route                         | The Worker serves `OPENAI_APPS_CHALLENGE_TOKEN` at `/.well-known/openai-apps-challenge`. See [configuration.md](./configuration.md#remote-worker-settings)                                                        |
| Narrow, accurate descriptions                             | One tool per API operation, generated from that route's own schema                                                                                                                                                |
| No catch-all HTTP tool                                    | Every tool is one fixed method against one closed path template. There is no tool that takes a URL or a method as an argument                                                                                     |
| No prompt-injection phrasing in descriptions              | Descriptions state what the route does and nothing about how the model should behave                                                                                                                              |
| Every tool returns a successful response for valid input  | Covered by the operation and protocol suites                                                                                                                                                                      |
| Actionable errors                                         | The API's error body names the missing scope or the failed field, and the server passes it through rather than flattening it                                                                                      |
| Reasonably sized responses                                | List tools auto-paginate to a bounded guard and report `pagination.truncated` rather than returning an unbounded merge. See [pagination-and-tool-count.md](./pagination-and-tool-count.md)                        |
| OAuth 2.0 for an authenticated service                    | Authorization-code flow with PKCE, dynamic client registration, and RFC 9728 protected-resource metadata. See [remote.md](./remote.md). The open auth items are listed below                                      |
| Per-tool auth hints for ChatGPT                           | Every tool declares its least-privilege scope in `_meta.securitySchemes`, and a token or scope failure returns `_meta["mcp/www_authenticate"]`. See [remote.md](./remote.md#per-tool-scopes-and-re-authorization) |
| First-party API on a matching domain                      | `mcp.setluca.com` fronts `api.setluca.com`, and both are ours                                                                                                                                                     |
| No money or financial-asset transfer                      | No tool moves funds. Billing routes are not on the public surface                                                                                                                                                 |
| No AI image, video, or audio generation                   | None                                                                                                                                                                                                              |
| Does not read the client's memory, chat history, or files | The three `luca_memory_*` tools read and write Luca's own coach and lead memory, which lives behind the Luca API                                                                                                  |
| Privacy policy                                            | https://setluca.com/privacy, covering collection, use, sharing, protection, retention, and choices, with an email and a postal address. Summarized for this server in the README                                  |
| Public documentation by publish date                      | https://api.setluca.com/docs, https://setluca.com/developers, and this package's README                                                                                                                           |

## Remaining work

### Auth work in the code

None of these exist yet. Don't describe them as shipped in a submission.

- **Audience check.** `/oauth/resolve` doesn't yet check that a token was issued
  for the `https://mcp.setluca.com/mcp` resource.
- **Client ID metadata documents (CIMD).** `packages/auth` doesn't accept a URL
  as a client ID yet. Clients register through dynamic client registration.

### Work outside the code

- **OpenAI reviewer connection.** The dedicated
  `openai-reviewer@setluca.com` account and seeded OpenAI Review Workspace are
  ready. Its credentials are in Infisical production at
  `/operations/openai-review`. ChatGPT has a read and draft OAuth grant. The
  `0.3.5` release is live. The portal's plugin package `0.1.3` selects Business
  & Operations and passed its metadata check. A fresh authenticated MCP scan
  discovered all 203 tools with no tool findings. Only a generic nonblocking
  server-instructions review notice remains; OpenAI supplies no actionable
  instruction-level finding. The existing confirmation and redaction guidance
  remains in place for review.
  Eight live ChatGPT reviewer cases passed. The reviewer grant redacts sample
  lead names and draft text, and ChatGPT describes those fields as unavailable.
  Final review submission remains pending the publisher's legal attestations.
  See `submission/openai/README.md`.
- **Claude reviewer access.** Confirm the dedicated account and its fixtures
  meet Claude's review requirements before using it there. See item 2 below.
- **Final icon.** The current icons point at the site favicon and app icon
  with a `wordmark-1` version tag. The listing icon isn't final.
- **OpenAI domain verification.** Completed October 6, 2026. The production
  Worker serves the challenge token and the portal shows Domain verified.
  The token is a Worker secret and must not be committed here.
- **Portal submissions.** An OpenAI plugin draft exists, but it has not been
  submitted for review. No Claude submission has been filed.

## What a human has to do in the Claude portal

None of this can be done from the repo. Each one is a rejection risk on its
own, and an incomplete test account is the one Anthropic calls out by name.

1. **A Team or Enterprise organization**, and an account in it with Owner or
   Directory permission. The submission form is not visible otherwise.
2. **Test credentials that actually work.** A Luca workspace with leads,
   conversations, bookings, and campaign data in it, plus a key or an OAuth
   login the reviewer can use. A reviewer who lands in an empty workspace
   cannot exercise a single tool and will not guess why.
3. **Listing copy.** An icon, a tagline of at most 55 characters, a description
   of at most 2,000 characters, one to five categories, a support contact, and
   the permanent URL slug. The slug does not change later.
4. **Seven compliance acknowledgments** at the end of the form.
5. **Screenshots**, only if this is submitted as an MCP App: three to five
   PNGs, each at least 1,000px wide.

## Things worth re-checking before each submission

- **The deployed version is what the directory reviews.** `server-card.json`
  reports the running build; confirm it matches the release you intend to
  submit rather than the last one that happened to deploy.
- **`destructiveHint` tracks the method.** A new PATCH, PUT, or DELETE route
  reads destructive on its own, and `test/operations.test.ts` fails if one does
  not. A new POST that reaches a real lead does not. It needs `confirmRequired`
  on its catalog entry, and that is what makes it destructive.
- **A new tool inherits the whole checklist.** CI gates the name length, title,
  description, and all four safety hints on the published `tools/list` shape.
