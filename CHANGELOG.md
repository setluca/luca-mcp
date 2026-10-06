# Changelog

Notable changes to `@setluca/mcp` and the hosted server at `mcp.setluca.com`.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this package follows [semantic versioning](https://semver.org/spec/v2.0.0.html).
What counts as a breaking change for an MCP server is spelled out in
[docs/release.md](./docs/release.md): removing or renaming a tool, tightening an
input schema, or changing what a tool does to a workspace.

## [Unreleased]

## [0.3.3] - 2026-10-06

### Fixed

- Mark live booking provider and calendar reads, plus call feedback that can
  start no-show recovery, as reaching outside the Luca workspace in MCP tool
  annotations.

## [0.3.2] - 2026-10-06

### Fixed

- Correct MCP safety hints for CRM schema and health probes, knowledge-source
  syncs, and the settings read that creates defaults on first use.
- Clarify the display names and descriptions of the ghosted-lead analytics and
  weekly business report tools without changing their stable tool names.

## [0.3.1] - 2026-10-06

### Fixed

- Restore authenticated remote MCP discovery and tool calls on Cloudflare.
  Token checks and tool requests now use a direct service binding to Luca's API,
  avoiding the public API's WAF challenge. Both paths use Cloudflare's supported
  manual redirect mode and still reject redirected responses without forwarding
  credentials.

### Changed

- The remote tool catalog includes explicit safety annotations for directory
  review. The protocol suite checks the published `tools/list` shape.

## [0.3.0] - 2026-10-05

This is the first Luca MCP release from its own repository. The package and
hosted connection now share a release path, with checks against the Luca API
currently in production. The README starts with what people can do in Luca;
setup and development details live in the guides.

### Breaking

- **Tool names are snake_case throughout.** Operation tools used the camelCase
  of their operation id, so the list mixed `luca_analytics_speedImpact` with
  `luca_book_call`. Every name now matches the task tools' casing. 73 tools
  are renamed; the other 130 keep their names. A client or saved prompt that
  calls an old name gets an unknown-tool error. 203 tools ship: 188 operations
  and 15 task tools.

  <details>
  <summary>Every renamed tool</summary>

  | Old name                                          | New name                                           |
  | ------------------------------------------------- | -------------------------------------------------- |
  | `luca_leads_fieldDefinitions_list`                | `luca_leads_field_definitions_list`                |
  | `luca_leads_fieldDefinitions_upsert`              | `luca_leads_field_definitions_upsert`              |
  | `luca_leads_importPreview`                        | `luca_leads_import_preview`                        |
  | `luca_leads_importApply`                          | `luca_leads_import_apply`                          |
  | `luca_reviewQueue_list`                           | `luca_review_queue_list`                           |
  | `luca_reviewQueue_explain`                        | `luca_review_queue_explain`                        |
  | `luca_reviewQueue_approve`                        | `luca_review_queue_approve`                        |
  | `luca_reviewQueue_reject`                         | `luca_review_queue_reject`                         |
  | `luca_reviewQueue_restore`                        | `luca_review_queue_restore`                        |
  | `luca_reviewQueue_media_retry`                    | `luca_review_queue_media_retry`                    |
  | `luca_reviewQueue_sla`                            | `luca_review_queue_sla`                            |
  | `luca_reviewQueue_objectionVariant`               | `luca_review_queue_objection_variant`              |
  | `luca_bookings_managedAvailability`               | `luca_bookings_managed_availability`               |
  | `luca_bookings_outcomeReasons_list`               | `luca_bookings_outcome_reasons_list`               |
  | `luca_bookings_needsOutcome`                      | `luca_bookings_needs_outcome`                      |
  | `luca_bookings_lifecycleAttention`                | `luca_bookings_lifecycle_attention`                |
  | `luca_bookings_lifecycleResolution`               | `luca_bookings_lifecycle_resolution`               |
  | `luca_bookings_providerSync_retry`                | `luca_bookings_provider_sync_retry`                |
  | `luca_bookings_guestLinks_create`                 | `luca_bookings_guest_links_create`                 |
  | `luca_bookings_guestLinks_revoke`                 | `luca_bookings_guest_links_revoke`                 |
  | `luca_bookings_outcomeReasons_create`             | `luca_bookings_outcome_reasons_create`             |
  | `luca_bookings_outcomeReasons_update`             | `luca_bookings_outcome_reasons_update`             |
  | `luca_callEvents_needingFeedback`                 | `luca_call_events_needing_feedback`                |
  | `luca_callEvents_get`                             | `luca_call_events_get`                             |
  | `luca_callEvents_byBooking`                       | `luca_call_events_by_booking`                      |
  | `luca_callEvents_byLead`                          | `luca_call_events_by_lead`                         |
  | `luca_callEvents_feedback`                        | `luca_call_events_feedback`                        |
  | `luca_callEvents_summary_generate`                | `luca_call_events_summary_generate`                |
  | `luca_callEvents_summary_replace`                 | `luca_call_events_summary_replace`                 |
  | `luca_callEvents_pushToCrm`                       | `luca_call_events_push_to_crm`                     |
  | `luca_callEvents_undoOutcome`                     | `luca_call_events_undo_outcome`                    |
  | `luca_callEvents_backfill`                        | `luca_call_events_backfill`                        |
  | `luca_campaigns_providerCapabilities`             | `luca_campaigns_provider_capabilities`             |
  | `luca_campaigns_commentEvents_list`               | `luca_campaigns_comment_events_list`               |
  | `luca_campaigns_commentSimulationSuite_run`       | `luca_campaigns_comment_simulation_suite_run`      |
  | `luca_campaigns_setStatus`                        | `luca_campaigns_set_status`                        |
  | `luca_webhooks_testDelivery`                      | `luca_webhooks_test_delivery`                      |
  | `luca_webhooks_signatureGuide`                    | `luca_webhooks_signature_guide`                    |
  | `luca_webhooks_events_bulkReplay`                 | `luca_webhooks_events_bulk_replay`                 |
  | `luca_integrations_crm_oauthUrl`                  | `luca_integrations_crm_oauth_url`                  |
  | `luca_integrations_crm_connections_webhooksSetup` | `luca_integrations_crm_connections_webhooks_setup` |
  | `luca_integrations_crm_syncRuns_list`             | `luca_integrations_crm_sync_runs_list`             |
  | `luca_integrations_crm_syncRuns_create`           | `luca_integrations_crm_sync_runs_create`           |
  | `luca_coach_nicheProfile`                         | `luca_coach_niche_profile`                         |
  | `luca_coach_objectionPlaybook`                    | `luca_coach_objection_playbook`                    |
  | `luca_coach_postCallSettings`                     | `luca_coach_post_call_settings`                    |
  | `luca_coach_postCallCrmMapping`                   | `luca_coach_post_call_crm_mapping`                 |
  | `luca_coach_postCallDealSync`                     | `luca_coach_post_call_deal_sync`                   |
  | `luca_coach_auditLog`                             | `luca_coach_audit_log`                             |
  | `luca_insights_unreadCount`                       | `luca_insights_unread_count`                       |
  | `luca_insights_markRead`                          | `luca_insights_mark_read`                          |
  | `luca_insights_markActioned`                      | `luca_insights_mark_actioned`                      |
  | `luca_learning_frameworkPerformance`              | `luca_learning_framework_performance`              |
  | `luca_learning_abTests_list`                      | `luca_learning_ab_tests_list`                      |
  | `luca_learning_abTests_get`                       | `luca_learning_ab_tests_get`                       |
  | `luca_knowledge_approveSuggestion`                | `luca_knowledge_approve_suggestion`                |
  | `luca_knowledge_rejectSuggestion`                 | `luca_knowledge_reject_suggestion`                 |
  | `luca_memory_setArchived`                         | `luca_memory_set_archived`                         |
  | `luca_cadences_rescueStart`                       | `luca_cadences_rescue_start`                       |
  | `luca_analytics_speedImpact`                      | `luca_analytics_speed_impact`                      |
  | `luca_analytics_callIntelligence`                 | `luca_analytics_call_intelligence`                 |
  | `luca_analytics_callIntelligenceCalls`            | `luca_analytics_call_intelligence_calls`           |
  | `luca_analytics_ghostedLeads`                     | `luca_analytics_ghosted_leads`                     |
  | `luca_analytics_trustScore`                       | `luca_analytics_trust_score`                       |
  | `luca_analytics_leadScore`                        | `luca_analytics_lead_score`                        |
  | `luca_analytics_lossReasons`                      | `luca_analytics_loss_reasons`                      |
  | `luca_analytics_contentAttribution`               | `luca_analytics_content_attribution`               |
  | `luca_analytics_contentPerformance`               | `luca_analytics_content_performance`               |
  | `luca_analytics_topicPerformance`                 | `luca_analytics_topic_performance`                 |
  | `luca_analytics_benchmarkConsent`                 | `luca_analytics_benchmark_consent`                 |
  | `luca_analytics_learningInsights`                 | `luca_analytics_learning_insights`                 |
  | `luca_analytics_crmSyncHealth`                    | `luca_analytics_crm_sync_health`                   |
  | `luca_analytics_objectionDrilldown`               | `luca_analytics_objection_drilldown`               |

  </details>

- **A tool call with an argument the tool does not define fails.** It used to
  drop the field and run, so a typo such as `limt` silently fell back to the
  default. The error names the field, and no request is sent.
- **Seven further tools need `confirm: true`:**
  `luca_bookings_lifecycle_resolution`, `luca_bookings_provider_sync_retry`,
  `luca_call_events_summary_replace`, `luca_call_events_push_to_crm`,
  `luca_webhooks_test_delivery`,
  `luca_integrations_crm_connections_webhooks_setup`, and
  `luca_integrations_crm_sync_runs_create`. Each writes to a connected
  calendar or CRM, or posts to an outside URL. 27 operations are now gated,
  which covers every write that can reach past the workspace.
- **`luca_find_leads` takes `channel` as one of `telegram`, `instagram`,
  `messenger`, or `whatsapp`,** the values `GET /api/leads` accepts. Any other
  value fails before a request is sent.
- **The analytics task tools return what they could read.**
  `luca_analytics_rollup`, `luca_analytics_magic_monday`, and
  `luca_analytics_deep_dive` used to fail when any one read failed. Each
  section is now optional, and a `failedSections` list names the section and
  the error for every read that failed. The call fails only when every read
  does, or when a read is refused with a 401 or a scope 403.
- **Six more tools need `confirm: true`:** `luca_leads_import_apply`,
  `luca_leads_consents_grant`, `luca_bookings_cancel`,
  `luca_webhooks_subscriptions_create`, `luca_webhooks_subscriptions_update`,
  and `luca_campaigns_set_status` when it sets `published` (resuming sends). A
  client that called these without it now gets a tool error asking for it.
- **Two tools are gone.** `luca_integrations_crm_oauthCallback` and
  `luca_integrations_crm_webhooks_record` were provider callbacks that an agent
  had no reason to call.
- **`openWorldHint` is now `false` for most tools.** It is `true` only for the
  25 operations, and the task tools built on them, that can reach past the
  workspace: messaging a lead, posting to an outside URL, or writing to a
  connected calendar or CRM.
- **The remote resolver API changed.** `apiKeyResolver(settings)` and
  `oauthResolver(settings)` take the API base URL, auth header, and timeout as
  one settings object, and a `TokenResolver` returns `Option<LucaConfig>`.
  `ResolvedIdentity` and `chainResolvers` are gone. Pick a resolver by the
  token's shape with the new `looksLikeDeveloperKey`.
- **`LucaConfig.apiKey` is a `Redacted<string>`.** A custom `TokenResolver`
  wraps the key with `Redacted.make` from `effect/Redacted`, so a logged or
  inspected config prints `<redacted>` instead of the key.
- **Booking and moving a call need `confirm: true`:** `luca_book_call`,
  `luca_reschedule_call`, `luca_bookings_create`, and `luca_bookings_update`
  now match `luca_bookings_cancel`. A booking moves the lead to booked and
  notifies the coach's webhook subscribers; a move updates the connected
  calendar and the lead's reminder. All four now report `destructiveHint: true`.
  To migrate, show the coach the slot, then pass `confirm: true` once they
  approve it. A call without it returns a tool error and sends nothing.
- **`luca_close_call_loop` needs `confirm: true` when `attendance` is
  `no_show`.** That report can start recovery that messages the lead. Other
  attendance values run without it.
- **`provider` on `luca_book_call` and `luca_reschedule_call` is one of
  `manual`, `cal_com`, `calendly`, `google_calendar`, `iclosed`, or
  `gohighlevel`.** Any other value fails before a request is sent. It used to
  be skipped by the availability check without a word.
- **The hosted server checks developer keys.** A `luca_` key is checked with
  one `GET /api/capabilities` before a server is built, so a made-up key gets
  401 instead of a tool list. `apiKeyResolver(settings, fetchImpl?, checks?)`
  now resolves asynchronously and can fail with
  `TokenVerificationUnavailable`.
- **An empty `idempotencyKey` fails before a request is sent** on every task
  tool that takes one. It used to reach the API as a blank header.
- **`RemoteRateLimiters` has a required `perTokenAddress` limiter,** charged
  per client address on requests that carry a token.
- **`luca_call_events_feedback` asks for confirmation on a `no_show` report.**
  A no-show can start recovery messaging, so that outcome now needs
  `confirm: true`. Other outcomes need no confirmation, and the tool stays on
  the `luca:draft` scope. `luca_close_call_loop` keeps its own no-show gate.

### Added

- Every tool declares the lowest OAuth scope that can call it in
  `_meta.securitySchemes`. On the hosted server, a call that fails because the
  token was revoked or its scopes fall short returns
  `_meta["mcp/www_authenticate"]`, so a client such as ChatGPT can ask the coach
  to reconnect. See [docs/remote.md](./docs/remote.md#per-tool-scopes-and-re-authorization).
- Two prompts, `luca-plan-campaign` and `luca-plan-broadcast`, which take a
  campaign or broadcast through a dry run or preview before anything goes live.
- Server instructions, returned on `initialize`, naming the starting tools, the
  confirm rule, and how to treat lead-authored text.
- Cancelling a tool call now aborts the request it has in flight.
- `luca_book_call` takes an optional `bookingTypeId` and sends it with the
  booking. The API requires one for a `google_calendar` booking, so that
  provider could not be booked through the tool before.
- Two tools: `luca_learning_ab_tests_list` and `luca_learning_ab_tests_get`
  read the coach's A/B tests and per-variant results. Creating, running, and
  adopting a test stay in the Luca app.
- Four channel tools under the new `channels:read` API-key scope, granted from
  `luca:read` up: `luca_channels_list` and `luca_channels_get` read the coach's
  connected accounts with their status and health, `luca_channels_catalog`
  says which channels can be connected yet, and `luca_channels_features` says
  what each provider supports. Connecting, pausing, and repairing an account
  stay in the Luca app.
- The 15 task tools declare an `outputSchema`, so a client can read their
  `structuredContent` without guessing its shape.
- `createRemoteResponder` in `@setluca/mcp/remote` returns the remote handler as
  an Effect, for a host that runs its own Effect program around each request.
  `createRemoteHandler` still returns a plain fetch handler.
- `createLocalRateLimits` in `@setluca/mcp/remote` builds the in-memory
  limiters, and `createRemoteHandler` and `createRemoteResponder` take them as
  an optional `rateLimits`, so a host can keep one set across requests.

### Changed

- A tool call stops after 45 seconds in total, retries and waits included, and
  each attempt still stops after 30. A write that times out says its outcome is
  unknown and names the idempotency key that makes a second send safe. The
  timeout error carries the last 429 or 5xx the call saw.
- A 429, 502, 503, or 504 retries even when its body is HTML or plain text, and
  honors `Retry-After`. It used to fail as a decode error.
- A paged list that stops early keeps the pages it fetched and leads with a
  `warning` that says the list is incomplete and how to fetch the rest. It
  stops when a page fails or can't be read, when the server repeats a cursor
  or sends an empty page with one, or after 120 seconds in total. A later page
  refused with 401, or 403 for a missing scope, fails the whole call instead,
  so the client gets the challenge that sends it back through sign-in.
- Lead-authored text is marked untrusted per operation instead of only on
  reads, so a write that returns lead text is framed too. 51 operations are
  framed, among them every booking route that returns the invitee's
  cancellation reason (`luca_bookings_list`, `luca_bookings_get`,
  `luca_bookings_create`, `luca_bookings_update`, `luca_bookings_cancel`,
  `luca_bookings_lifecycle_attention`, and
  `luca_bookings_lifecycle_resolution`), `luca_bookings_needs_outcome`,
  `luca_analytics_ghosted_leads`, and the five lead writes that echo the lead
  record back: `luca_leads_create`, `luca_leads_update`,
  `luca_leads_import_preview`, `luca_leads_import_apply`, and
  `luca_leads_identities_attach`. Those five now list `full_content` as their
  data sensitivity. `luca_book_call`, `luca_reschedule_call`, and
  `luca_analytics_deep_dive` are framed as well.
- A task tool that returns partial results fails the whole call when the API
  answers 401, or 403 with `scope_required` or `needs_scope`, so the agent
  sees a credentials problem instead of a missing section. This covers the
  three analytics task tools, `luca_close_call_loop`, the explanations of
  `luca_triage_inbox`, and the guest links of `luca_reschedule_call`. Other failures still come back as a section error.
- `luca_book_call` and `luca_reschedule_call` skip the availability check when
  the call carries an `idempotencyKey`, so a retry of a booking that went
  through reaches the API's replay instead of reporting the slot taken.
  `luca_book_call` sends `provider` with the booking; `luca_reschedule_call`
  uses it only for the availability check and keeps the booking's provider.
- `luca_book_call` with a `bookingTypeId` checks the slot against that booking
  type's own schedule instead of the calendar provider's free time. An
  availability check refused with 401, or 403 for a missing scope, fails the
  call instead of booking unchecked.
- `luca_close_call_loop` says what filing starts: no-show recovery, a call
  summary that can sync to the CRM, and a CRM deal-stage update.
- The workflow prompts point at the task tools, such as
  `luca_morning_report` and `luca_draft_reply`, instead of the raw operations.
- Completion suggestions match the typed prefix in any case.
- `luca-rescue-silent-leads` applies its `days` window to the conversation
  list step, not only to the heading.
- `luca_analytics_deep_dive` no longer requires `question`.
- `luca_close_call_loop` reports a failed call-event lookup as
  `feedbackError`. It used to read as "no call event for this booking".
- A failed resource read answers with a JSON-RPC error: resource-not-found for
  a missing record, an invalid request carrying the same
  `mcp/www_authenticate` challenge a tool error carries for a refused token or
  missing scope, and an internal error for anything else.
- An API response that is not JSON is reported by its length. The error no
  longer quotes the body, text no Luca schema shaped.
- Calls to the Luca API refuse to follow redirects, so a key or token is never
  sent to a host the config did not name.
- The hosted server:
  - checks an OAuth token within 5 seconds and answers 503 if it cannot;
  - treats only a 401 from the token check as a refused token, so a misrouted
    or overloaded API no longer sends every client back through sign-in;
  - limits each bearer token to 60 requests a minute, so coaches who
    share an address no longer share a budget, and also limits requests with
    a token to 600 a minute per address, so made-up tokens run out too;
  - limits requests without a token to 600 a minute per address;
  - refuses a token over 4,096 characters, or an OAuth token that is not
    three base64url segments, with 401 `invalid_token` and no API call;
  - leaves `scope` out of an `invalid_token` challenge, so a client that
    reconnects asks for the scope it had rather than a lower one;
  - answers 429 with "Too many requests";
  - reads the client address from `CF-Connecting-IP` only and ignores
    `X-Forwarded-For`, which any client can set;
  - answers 500 to every request when a production deploy is missing any of
    its three rate-limit bindings, or when `MCP_PUBLIC_ORIGIN` is not an
    http(s) origin with no path;
  - serves its discovery documents to any origin, CORS preflight included.
- The package no longer depends on Zod directly.
- Tool input schemas now advertise closed objects
  (`additionalProperties: false`) and keep each field's format, title, and
  description.
- The docs describe Luca as a DM sales platform.
- The hosted Worker reads `LUCA_AUTH_HEADER` and `LUCA_REQUEST_TIMEOUT_MS` with
  the stdio parser. `bearer` now works there, and an unknown value answers 500
  instead of sending keys in a header the API ignores.
- The `WWW-Authenticate` challenge on a tool error now carries
  `realm="luca-mcp"`, like the transport's 401.
- A tool call missing a path parameter fails as a tool input error before any
  request is sent.
- Prompts no longer use em dashes, and every workflow prompt ends with the same
  safety rules.
- A task tool's read-only, confirm, and untrusted-content flags now come from
  the operations it composes, so a task tool cannot claim to be safer than the
  routes it calls.
- Cancelling a resource read aborts the request it has in flight.
- A write that needs an idempotency key and gets none now mints a fresh key
  each time the call runs, rather than once per built request.
- A cancelled tool call is logged with `outcome: "interrupted"`.
- Each tool's `x-luca-redacted-fields` list now comes from the API's
  `sensitive()` markers at generation time instead of a hand-written list, and
  `redaction:check` is gone. The lists did not change.
- **`luca_reschedule_call` checks the booking's own schedule.** It reads the
  booking first and checks the new time against the slots of its booking type,
  or the provider calendar when the booking has no booking type or cannot be
  read.
- **More routes frame lead-written text as untrusted.** CRM rows, broadcast
  recipients, campaign enrollments, and integration sync records now carry the
  untrusted-content marker and `full_content` data sensitivity.
- **`luca_rescue_silent_leads` rejects empty lead ids.**

### Fixed

- The hosted server logs `mcp.token_verification_unavailable`, with the error
  message and no token, when the token verifier cannot answer and the request
  gets a 503.
- Resource registration shares one read path for fixed and templated URIs.

## [0.2.1] - 2026-08-22

### Added

- `docs/scopes.md`, a generated map between the two scope vocabularies. Tools
  declare API scopes (`leads:read`); OAuth clients ask for capability scopes
  (`luca:draft`). The new reference says which one grants which, how many tools
  each tier reaches, and what to ask for when a call returns 403.
- `docs/prompts-and-resources.md`, a generated reference for all 7 prompts and
  5 resources. Previously only the 198 tools had one.
- `docs/errors.md`, covering the six error types, which failures the server
  retries for you, and what each API error code means.
- `server.json` now declares the hosted Worker under `remotes`, so a client
  browsing the MCP registry can find `https://mcp.setluca.com/mcp` instead of
  only the stdio package.
- The changelog ships in the npm tarball, so the package page carries it.

### Changed

- `docs:generate` now emits three files instead of one, and fails when a tool
  needs an API scope no OAuth tier grants.

## [0.2.0] - 2026-08-21

The first release with a hosted server. Everything below is one version's worth
of change, so read the breaking section before upgrading.

### Breaking

- **The registry name moved** from `io.github.leonardomso/luca-mcp` to
  `io.github.setluca/luca-mcp`. A client that pinned the old name keeps
  resolving 0.1.1 and will not see this release. Re-add the server under the new
  name. The npm package name, `@setluca/mcp`, did not change.
- **`destructiveHint` now reflects what a tool does.** Task tools previously
  advertised `destructiveHint: false` across the board, including
  `luca_approve_and_send` and `luca_rescue_silent_leads`, which message real
  leads. Both now report `true`. A client configured to auto-approve
  non-destructive tools will start prompting for these.
- **The protocol revision moved to `2026-07-28`.** Clients on an older revision
  negotiate down, but tool titles and completions need the newer one.

### Added

- 198 tools, up from 67: 183 one-per-route operations plus 15 task tools.
  Analytics, call events, cadences, knowledge, memory, insights, and reports are
  all reachable now, and booking coverage is complete.
- Task tools, which compose several operations behind one intent-level call.
  `luca_triage_inbox`, `luca_close_call_loop`, and `luca_rescue_silent_leads`
  are the ones worth starting with. Set `LUCA_TOOLSET=tasks` to register only
  these plus capability discovery, which keeps a small context window usable.
- The hosted server at `https://mcp.setluca.com/mcp`, with OAuth. Six scopes,
  discovery endpoints under `/.well-known/`, and no API key to paste. See
  [docs/remote.md](./docs/remote.md).
- Automatic retries. Network failures, timeouts, and 429, 502, 503, and 504
  responses are retried three times with jittered backoff, honouring
  `Retry-After` up to 10 seconds. A write is only replayed when it carries an
  idempotency key, so a retry can never file the same write twice.
- A per-request timeout, `LUCA_REQUEST_TIMEOUT_MS`, defaulting to 30 seconds. A
  hung connection used to block a tool call indefinitely.
- 7 prompts and 5 resources, including `luca-weekly-review` and
  `luca-rescue-silent-leads`, plus argument completions for enumerable fields.
- Workspace overrides. `workspaceId` and `workspaceSlug` on every tool let one
  organization API key work across workspaces.
- Redaction markers. A tool whose output may arrive blanked for a
  `redacted`-tier key now says so in its output schema, under
  `x-luca-redacted-fields`.
- `mcp.tool.called` structured logs, one line per call with the tool name,
  toolset, outcome, and duration.

### Fixed

- `luca_close_call_loop` no longer loses the revenue write when the attendance
  write fails. Each half is filed independently and reports its own failure.
- Pagination is derived from the response schema instead of guessed from the
  tool name. The old heuristic was wrong for 14 tools: 12 that do not paginate
  were auto-paginated, and `conversations.messages` and `analytics.insights`
  were not paginated when they should have been. `conversations.messages` also
  uses `before` rather than `cursor`, which the paginator now reads.
- Every tool has a written title. All 159 used to read `"Luca " + id`, which
  told a client nothing its name did not already say.

## [0.1.1] - 2026-07-10

### Added

- npm trusted publishing and an automated MCP registry listing, so a tag
  publishes to both without a human holding a token.
- A titled GitHub release on every `mcp-v*` tag.

### Changed

- The README is written for coaches and agents rather than contributors, and
  carries a copy-paste setup prompt.

## [0.1.0] - 2026-07-10

First public release. 67 API-key-safe tools over the Luca public API, shipped as
a stdio server on npm.
