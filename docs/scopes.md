# Scope reference

This file is generated from `src/scopes.ts` and the operation catalog.
Never edit it by hand. Run `bun run docs:generate` after changing either.

Two scope vocabularies meet in this server. A tool call returns 403 when a
caller uses the wrong one.

An **API scope** (`leads:read`, `bookings:write`) is what Luca's API checks
on every request. Each tool declares the ones it needs, and `tools.md`
lists them per tool. An API key you create in the Luca dashboard carries
API scopes directly.

An **OAuth scope** (`luca:draft`) is what a remote client asks for when it
connects through `mcp.setluca.com`. Luca's authorization server vends a key
carrying every API scope that tier covers. A client never names an API
scope itself.

New connections default to `luca:read luca:draft`.

## What each OAuth scope unlocks

The tiers nest, so `luca:full` grants everything `luca:queue_ops` does. The
counts are tools reachable with that scope alone, not tools added by it.
Each tool counts at the scope its `_meta.securitySchemes` names: the lowest
tier granting any one of its API scopes, raised to the tool's own capability
tier when that is higher.

| OAuth scope      | Operation tools | Task tools | API scopes added over the tier below                                                                                                                                                                                                                                                                                                  |
| ---------------- | --------------: | ---------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `luca:read`      |             103 |          7 | `analytics:read`, `bookings:read`, `broadcasts:read`, `call_events:read`, `campaigns:read`, `channels:read`, `coach:read`, `conversations:read`, `integrations:read`, `knowledge:read`, `leads:read`, `learning:read`, `memory:read`, `reports:read`, `review_queue:read`, `safety:read`, `usage:read`, `voice:read`, `webhooks:read` |
| `luca:draft`     |             123 |          9 | `call_events:write`, `insights:write`, `leads:write`, `learning:write`, `memory:write`                                                                                                                                                                                                                                                |
| `luca:queue_ops` |             174 |         15 | `bookings:write`, `broadcasts:write`, `cadences:write`, `campaigns:write`, `conversations:write`, `knowledge:write`, `review_queue:write`                                                                                                                                                                                             |
| `luca:full`      |             188 |         15 | `integrations:write`, `webhooks:write`                                                                                                                                                                                                                                                                                                |

Two scopes grant no API scopes at all:

| OAuth scope         | What it does                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `luca:full_content` | Read verbatim lead-authored message content. Without it a vended key reads the redacted view. This is a separate axis from the tier, not a higher tier. |
| `offline_access`    | Issue a refresh token so the connection survives past the access token's lifetime. Grants no API scope.                                                 |

## Which OAuth scope covers an API scope

Read this when a tool returns 403 and you need to know what to ask for.
The middle column is the least-privilege answer.

| API scope             | Lowest OAuth scope granting it | Tools | Groups                         |
| --------------------- | ------------------------------ | ----: | ------------------------------ |
| `analytics:read`      | `luca:read`                    |    25 | Analytics, Campaigns, Insights |
| `bookings:read`       | `luca:read`                    |    17 | Bookings, Capabilities         |
| `bookings:write`      | `luca:queue_ops`               |    18 | Bookings                       |
| `broadcasts:read`     | `luca:read`                    |     3 | Broadcasts, Capabilities       |
| `broadcasts:write`    | `luca:queue_ops`               |     7 | Broadcasts                     |
| `cadences:write`      | `luca:queue_ops`               |     2 | Cadences                       |
| `call_events:read`    | `luca:read`                    |     4 | Call Events                    |
| `call_events:write`   | `luca:draft`                   |     6 | Call Events                    |
| `campaigns:read`      | `luca:read`                    |    10 | Campaigns, Capabilities        |
| `campaigns:write`     | `luca:queue_ops`               |     9 | Campaigns                      |
| `channels:read`       | `luca:read`                    |     4 | Channels                       |
| `coach:read`          | `luca:read`                    |     8 | Coach                          |
| `conversations:read`  | `luca:read`                    |     4 | Capabilities, Conversations    |
| `conversations:write` | `luca:queue_ops`               |     2 | Conversations                  |
| `insights:write`      | `luca:draft`                   |     4 | Insights                       |
| `integrations:read`   | `luca:read`                    |     6 | Capabilities, Integrations     |
| `integrations:write`  | `luca:full`                    |     7 | Integrations                   |
| `knowledge:read`      | `luca:read`                    |     2 | Knowledge                      |
| `knowledge:write`     | `luca:queue_ops`               |     4 | Knowledge                      |
| `leads:read`          | `luca:read`                    |     6 | Capabilities, Leads            |
| `leads:write`         | `luca:draft`                   |    10 | Leads                          |
| `learning:read`       | `luca:read`                    |     5 | Teach Luca                     |
| `learning:write`      | `luca:draft`                   |     1 | Teach Luca                     |
| `memory:read`         | `luca:read`                    |     1 | Memory                         |
| `memory:write`        | `luca:draft`                   |     2 | Memory                         |
| `reports:read`        | `luca:read`                    |     2 | Reports                        |
| `review_queue:read`   | `luca:read`                    |     3 | Review Queue                   |
| `review_queue:write`  | `luca:queue_ops`               |     5 | Review Queue                   |
| `safety:read`         | `luca:read`                    |     1 | Account Safety                 |
| `usage:read`          | `luca:read`                    |     2 | Usage                          |
| `voice:read`          | `luca:read`                    |     2 | Voice                          |
| `webhooks:read`       | `luca:read`                    |     5 | Capabilities, Webhooks         |
| `webhooks:write`      | `luca:full`                    |     7 | Webhooks                       |

## Task tools

A task tool composes several operations, so it needs the union of their
scopes and the highest OAuth scope any of them needs.

| Task tool                     | Needs at least   | API scopes                                                |
| ----------------------------- | ---------------- | --------------------------------------------------------- |
| `luca_triage_inbox`           | `luca:read`      | `review_queue:read`                                       |
| `luca_morning_report`         | `luca:read`      | `reports:read`                                            |
| `luca_find_leads`             | `luca:read`      | `leads:read`                                              |
| `luca_flag_for_human`         | `luca:draft`     | `leads:write`                                             |
| `luca_draft_reply`            | `luca:draft`     | `leads:write`                                             |
| `luca_approve_and_send`       | `luca:queue_ops` | `review_queue:write`                                      |
| `luca_book_call`              | `luca:queue_ops` | `bookings:read`, `bookings:write`                         |
| `luca_reschedule_call`        | `luca:queue_ops` | `bookings:read`, `bookings:write`                         |
| `luca_post_call_queue`        | `luca:read`      | `bookings:read`, `call_events:read`                       |
| `luca_close_call_loop`        | `luca:queue_ops` | `bookings:write`, `call_events:read`, `call_events:write` |
| `luca_rescue_silent_leads`    | `luca:queue_ops` | `cadences:write`                                          |
| `luca_pause_cadence`          | `luca:queue_ops` | `cadences:write`                                          |
| `luca_analytics_rollup`       | `luca:read`      | `analytics:read`, `broadcasts:read`, `campaigns:read`     |
| `luca_analytics_magic_monday` | `luca:read`      | `analytics:read`                                          |
| `luca_analytics_deep_dive`    | `luca:read`      | `analytics:read`                                          |
