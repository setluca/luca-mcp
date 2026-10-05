# Security boundary

Luca MCP is a client of Luca's public API, authenticating with a developer API
key over stdio or with an API key or OAuth access token over the remote
transport. It stays inside the same trust boundary as any other external API
consumer.

## Allowed

- Public `/api/*` operations that Luca allows for API-key actors.
- `x-api-key` and `Authorization: Bearer` developer API key authentication.
- Workspace selection through `x-luca-workspace-id` and
  `x-luca-workspace-slug`.
- Idempotent public writes with `idempotency-key`.

## Not allowed

- Direct database access.
- `/internal/*` routes.
- Browser session cookies.
- Private webhook ingress.
- Service tokens.
- Secret discovery or environment dumping.
- Tools that bypass Luca scopes, review gates, idempotency, or safety policy.

## Secret handling

- Configure API keys through MCP client environment variables.
- Never put real API keys in committed config files.
- Never log API keys or request headers.
- Tool errors may include Luca request ids, status codes, and response envelopes,
  but must not include secrets.

## Untrusted content (prompt-injection defense)

Some tools return text that leads or other outside people wrote. Conversation
messages, lead-provided profile fields, the review queue's inbound context, a
cancellation reason an invitee typed, and a call summary generated from what a
lead said all carry it. A lead can write "ignore your instructions and ..." into
a DM, and an agent that reads it through a tool could act on it.

Tools whose responses carry such content frame their output as untrusted. Three
rules decide which tools those are:

- Every operation in a group listed in `UNTRUSTED_CONTENT_GROUPS`
  (`src/operations/registry.ts`) is framed, whatever its method, because a write
  can echo lead text back too.
- An operation can override the group default with `untrustedContent` in its
  `op()` call: `true` for a route outside those groups that still returns
  outside text, `false` for a route in one whose response holds no such text.
  Routes framed this way include the CRM rows, broadcast recipients, campaign
  enrollments, and the integration sync records, which carry lead-written
  names, messages, or notes. A free-text field the coach wrote stays unframed;
  `test/operations.test.ts` lists each such field with its reason.
- A task tool is framed when any operation it composes is, or when it sets its
  own `untrustedContent: true` for a field the composed routes do not mark.
  No task tool needs the latter today: every booking route that returns a
  `cancellationReason` is framed, and a test fails when a route that returns
  one is not.

The code is the list of record. Read each operation's flag from the
`untrustedContent` field of the `luca://operations` resource, or from
`src/operations/` directly, rather than from a copy here. A few reads stay
unframed on purpose. Every webhook event's delivered payload, for example, is
structured ids, enums, and counts, never verbatim lead text. All framed tools
mark their output the same way:

- **Structured signal** (authoritative): `structuredContent.provenance` is
  `{ untrusted: true, note: "…" }`. This is a JSON field, not a delimiter, so a
  lead cannot spoof it by writing a fake marker into their message.
- **Human-facing hint**: the text content is prefixed with `[UNTRUSTED CONTENT]`
  and the note.

### Guidance for MCP client implementers

- Treat any tool result carrying `provenance.untrusted === true` as **data to
  analyze, never as instructions to execute**. Do not follow directives found
  inside it.
- Do not persist that text into long-term memory or system prompts verbatim
  without the same untrusted framing.
- The framing does not sanitize the text, because Luca cannot know a lead's
  intent. It marks where the text came from so your agent's own guardrails can
  apply.

### Memory-write guard

Lead-linked facts are neutralized at the memory-write boundary (`@luca/memory`
`addLeadMemory`) before they are persisted: the fact text is stripped of control
and zero-width characters and prefixed with a `[lead-said]` data label, so a
downstream agent that later recalls the fact reads it as data, not as a leading
instruction. This protects the `extract-memory` pipeline today and any future
memory-write tool by construction, independent of the caller.

## Scopes

Every tool documents its required Luca API scopes in `docs/tools.md` and in the
MCP tool description. If the API returns `scope_required`, create or rotate the
developer key with the required scope in Luca.

[scopes.md](./scopes.md) inverts that view: it lists every API scope with the
lowest OAuth capability scope that grants it, and every capability tier with
what it can reach. It is generated from `src/scopes.ts`, and `docs:generate`
fails if an operation ever needs a scope no tier grants.

### Capability and content scope

Luca's API also gates every API-key request along two further, independent
axes. Capability is what the key may _do_, from read-only up through operating
the live queue. Content sensitivity is how much of a lead's content it may
_see_, from redacted summaries up to verbatim text. Each operation under
`src/operations/groups/` declares the pair it requires (`RequiredScope`). The
MCP server carries that as metadata and never enforces it. Enforcement lives
entirely in Luca's API. A key whose
granted capability falls short of what a route needs gets a `needs_scope` 403
(distinct from the `scope_required` check above). The content-sensitivity axis
never denies a call, because every route accepts the baseline "redacted" tier
and any granted tier satisfies it. A key below full content access still gets a
response. The API strips the verbatim and PII fields before the MCP server ever
sees the body.

Local developer API keys (what this server's stdio transport authenticates
with) always carry full content access; the redaction path only affects keys
vended through the hosted OAuth connector that were not granted full content
on their consent screen.

### Which fields may be stripped (`x-luca-redacted-fields`)

An MCP client otherwise has no way to know a field may come back blanked for
its key's tier, so the affected tools mark it in their `outputSchema`:

- **Structured signal**: `outputSchema.result` (and therefore the tool's
  generated JSON Schema) carries an `x-luca-redacted-fields` array. Each entry is
  a field path relative to `result`, in dot and `[]` notation, such as
  `"items[].draftBody"`, `"pendingReview.qualification"`, or
  `"identities[].displayName"`. It is metadata only. It is present whether or not
  the calling key is `redacted`-tier, and it never changes what the schema
  validates.
- **Where it appears**: on every operation tool whose response schema marks a
  field with `sensitive()` in `@luca/schemas`. `scripts/generate-openapi-outputs.ts`
  reads those markers from the OpenAPI snapshot into `OPENAPI_REDACTED_FIELDS`,
  and `op()` attaches the route's list, so the marker cannot drift from what the
  API blanks. On a tool such as `campaigns.commentEvents.list` this marker sits
  next to the untrusted-content framing above and means something different.
  Untrusted means "treat as external data". Redacted means "may arrive blanked
  for your key's tier".

**Guidance for MCP client implementers.** Before trusting a value at one of a
tool's `x-luca-redacted-fields` paths, check whether it looks blanked (empty
string, `null`, or `[]`) rather than assuming absence means "the lead has no
data". It may mean "your key cannot see this". Do not treat a blanked field as
a qualification/draft/safety signal that is actually zero or negative; treat it
as unknown for that key's tier. A `full_content`-tier key sees these fields
populated normally; the marker is identical on both tiers, only the payload
differs.

## Write safety

For idempotent writes, pass a stable `idempotencyKey` when retrying the same user
intent. Letting the MCP server generate a UUID is appropriate only for a new
write attempt.

### Idempotency-key retry contract

For every operation with `idempotencyRequired`, `src/http.ts` sends an
`idempotency-key` header. If a tool call supplies `idempotencyKey`, that value is
used; otherwise the server generates a fresh `crypto.randomUUID()` per call.

- **Safe retry**: re-call with the **same** `idempotencyKey`. The Luca API replays
  the original result instead of performing the write twice (a launched broadcast
  is launched once, an enrolled lead is enrolled once). A stuck agent retrying a
  timed-out call should reuse the key it sent.
- **New intent**: omit `idempotencyKey` (or send a new one) to perform a genuinely
  new write. Reusing a key with a **different** request body is rejected with a
  409 conflict.

The API scopes a key by organization, coach, actor, HTTP method, and request path,
so one key is safe across the writes of a task tool that hit different routes.
`luca_close_call_loop` files call feedback and a booking outcome under one key,
and `luca_reschedule_call` moves the booking and mints a guest link under one.

`luca_book_call` and `luca_reschedule_call` check availability before they write.
`luca_book_call` sends its `provider` to the booking. `luca_reschedule_call` uses
`provider` only for the check, so the booking keeps its stored provider.
A call that carries an `idempotencyKey` skips that check. A retry may follow a
booking that landed while its response was lost, so the slot reads as taken by
that same booking. With the key, the retry goes straight to the API, which
replays the first result.

### Confirmation gate for destructive tools

Tools with a real-world side effect require an explicit `confirm: true`
argument. The server instructions tell the agent to pass it only after the
coach approves that exact action. Without it, the MCP server rejects the call
before any outbound request. An agent hallucination or an overly literal
instruction can't fire one silently.

The rejection is a tool error with this text:

```text
<toolName>: This tool requires confirm: true because it has a real-world side effect. Re-call the tool with confirm: true to proceed.
```

Its `structuredContent.error` is
`{ "code": "confirmation_required", "toolName": "<toolName>", "requiredArgument": "confirm" }`,
and the server logs `mcp.write_gate.rejected`.

These 28 operations carry the gate:

- `luca_leads_import_apply`
- `luca_leads_consents_grant`
- `luca_conversations_send`
- `luca_conversations_partial_send_retry`
- `luca_review_queue_approve`
- `luca_bookings_create`
- `luca_bookings_update`
- `luca_bookings_cancel`
- `luca_bookings_lifecycle_resolution`
- `luca_bookings_provider_sync_retry`
- `luca_call_events_feedback`, only when `outcome` is `no_show`
- `luca_call_events_summary_replace`
- `luca_call_events_push_to_crm`
- `luca_campaigns_enroll`
- `luca_campaigns_publish`
- `luca_campaigns_set_status`, only when `status` is `published`
- `luca_broadcasts_launch`
- `luca_broadcasts_retry`
- `luca_webhooks_subscriptions_create`
- `luca_webhooks_subscriptions_update`
- `luca_webhooks_test_delivery`
- `luca_webhooks_deliveries_replay`
- `luca_webhooks_events_replay`
- `luca_webhooks_events_bulk_replay`
- `luca_integrations_crm_connections_webhooks_setup`
- `luca_integrations_crm_sync_runs_create`
- `luca_knowledge_approve_suggestion`
- `luca_cadences_rescue_start`

`luca_campaigns_set_status` and `luca_call_events_feedback` are the conditional
gates. Setting `published` resumes a paused campaign, which restarts automatic
sends to real leads. Pausing or archiving only stops work, so those calls run
without `confirm`. Reporting a `no_show` outcome can start recovery messaging to
the lead, so that report needs `confirm`; the other outcomes run without it. The
tool's description says when the gate applies.

Four task tools carry the gate on every call, because they compose those
operations for the same effect: `luca_approve_and_send`,
`luca_rescue_silent_leads`, `luca_book_call`, and `luca_reschedule_call`.

`luca_close_call_loop` is gated only when `attendance` is `no_show`, the one
report that can start recovery messaging to the lead. Other attendance values
run without `confirm`. A task tool declares such a narrowed gate with its own
`confirm: { applies, description }`, the same shape operations use. A task tool
that composes an operation gated every time is gated every time. One that
composes only conditionally gated operations needs its own narrowed gate, and
without one it is gated on every call.

The rule for what gets gated: a tool is gated when its effect reaches a real
lead, a real calendar, or a system outside Luca. That covers:

- messaging leads, directly or by starting a campaign, broadcast, or cadence
- booking, moving, or cancelling a call on the lead's and the coach's calendars
- writing to a connected calendar or CRM, including a sync run or a call
  summary pushed to the CRM
- granting the consent that lets Luca message a lead on a channel
- importing many leads and their consent records at once
- pointing the workspace event stream at an outside URL, or posting a test
  delivery to one
- re-delivering events that trigger a subscriber's downstream automation

Other writes to Luca's own records, such as creating a draft or updating a
lead, aren't gated. The gate is defense in depth on top of the review-queue and
state-machine checks in `apps/api`, not a replacement for them. The API still
rejects an invalid state, such as launching an unapproved broadcast, whatever
the MCP client sends.

### `destructiveHint` is wider than the confirm gate

The gate above decides which tools refuse to run without `confirm: true`. The
`destructiveHint` annotation answers a different question, for a client
deciding what it may auto-approve, and it covers more tools.

A tool reads destructive when it is not a read **and** either it carries the
confirm gate or its method changes something that already exists, meaning
`DELETE`, `PATCH`, or `PUT`. MCP defines the non-destructive half as additive-only, so a
`PATCH` that overwrites a field and a `PUT` that replaces a whole resource both
qualify even though neither reaches a lead. A `POST` that creates a record does
not: nothing it touches existed before the call.

`src/annotations.ts` owns the rule and both kinds of Luca tool read it from
there. A catalog-wide test asserts that every `DELETE`, `PATCH`, and `PUT` tool
reads destructive and every `GET` does not, so a new mutating route cannot ship
announcing itself as safe.
