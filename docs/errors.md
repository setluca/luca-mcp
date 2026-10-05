# Error reference

What a client receives when a tool call fails and how to handle each error.

## How a failure arrives

Every failure comes back as a normal tool result with `isError: true` and one
text block. No tool throws at the protocol level, so a client that only reads
`content` still sees the message.

```json
{
  "isError": true,
  "content": [
    {
      "type": "text",
      "text": "Luca API returned 403 Forbidden requestId=01J…: {\"code\":\"scope_required\"}"
    }
  ]
}
```

The text is built by `formatError` in `src/errors.ts`. An HTTP failure renders
the status, the request id when the response carried one, and the API's own JSON
body, so the machine-readable `code` is always in there even though the envelope
is text.

The confirmation gate is the one failure with structured output as well, because
it is the one an agent is expected to recover from on its own:

```json
{
  "isError": true,
  "structuredContent": {
    "error": {
      "code": "confirmation_required",
      "toolName": "luca_conversations_send",
      "requiredArgument": "confirm"
    }
  }
}
```

Re-call the tool with `confirm: true`. Nothing reached the lead. See
`security.md` for the full list of confirm-gated tools and why each is on it.

## The six failures

`src/errors.ts` defines six tagged errors. Every one of them ends up as the text
above; the tag matters when you are reading a trace or writing a handler.

| Error                | Cause                                                                                                                                             | Retried                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `LucaConfigError`    | No API key or token, or a malformed base URL. The server cannot build a request at all.                                                           | No                          |
| `LucaNetworkError`   | `fetch` itself failed. DNS, TLS, or a dropped connection.                                                                                         | Yes                         |
| `LucaTimeoutError`   | One attempt ran past `LUCA_REQUEST_TIMEOUT_MS` (30s by default) and was cancelled.                                                                | Yes                         |
| `LucaHttpError`      | Luca's API answered with a non-2xx status. Carries `status`, `statusText`, `body`, and `requestId` and `retryAfterMs` when the response had them. | Only for 429, 502, 503, 504 |
| `LucaDecodeError`    | The response was not the JSON the schema expected. The first 500 characters of the body are in the message.                                       | No                          |
| `LucaToolInputError` | Tool arguments that are not a JSON object. The SDK validates against the tool's input schema first, so a real client cannot reach this.           | No                          |

A `LucaConfigError` on the first call almost always means the environment is
wrong rather than the request. Check `configuration.md`.

## What the server retries for you

Retries are automatic, so a transient failure that reaches your agent has
already been attempted four times.

Three attempts follow the first, backing off about 200ms, 400ms, then 800ms,
each shifted between 0.8x and 1.2x so a fleet of clients that all failed at once
does not come back in lockstep. A `Retry-After` header is honoured when it asks
for 10 seconds or less. Past that the server is not asking for a retry, it is
asking you to come back later, and the 429 is reported instead.

Two rules decide whether a failure is sent again, and both must hold.

**The failure has to say nothing about whether the request was handled.** That
means a network error, a timeout, or a 429, 502, 503, or 504. A 500 is
deliberately excluded: it means the handler ran and threw, possibly after
writing something, so replaying it without a key can double the write.

**The request has to be replayable.** `GET` and `HEAD` always are. A write is
replayable only when it carries an idempotency key, because Luca dedupes by
`[organizationId, coachId, actorId, method, path, key]` and that is the only
replay which cannot file the same write twice.

The practical consequence: pass `idempotencyKey` on writes. Without one, a write
that hits a 503 fails on the first attempt and comes straight back to you.
Operations with `Idempotency-Key required` in `tools.md` get a generated key when
you omit one, which satisfies the API but gives you no dedupe across your own
retries, since a fresh key is minted each call.

## Reading an HTTP failure

The status and the API's `code` together tell you what to change. The three 403
codes in particular mean different things and want different fixes.

| Status | `code`                    | What it means                                                                                                                                                                       | What to do                                                                                                                                                    |
| ------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `idempotency_required`    | The route requires an `Idempotency-Key` and none was sent.                                                                                                                          | Pass `idempotencyKey`.                                                                                                                                        |
| 401    | `unauthorized`            | The key or token was missing, malformed, or revoked.                                                                                                                                | Check `LUCA_API_KEY`. For a remote connection, reauthorize.                                                                                                   |
| 403    | `forbidden`               | The route is not reachable by any API key. It is session-only by design, not by oversight.                                                                                          | Nothing to grant. See "What the MCP deliberately cannot do" in `security.md`.                                                                                 |
| 403    | `scope_required`          | The key lacks an API scope the route needs. The response body names the scopes that would satisfy it.                                                                               | Mint a key with those scopes, or ask for the OAuth scope that grants them. `scopes.md` maps one to the other.                                                 |
| 403    | `needs_scope`             | The key's scopes are right but its capability tier is too low. A read-tier key cannot draft; a draft-tier key cannot operate the live queue. The body carries `requiredCapability`. | Reconnect asking for the capability scope that reaches that tier.                                                                                             |
| 404    |                           | The record does not exist, or belongs to another workspace.                                                                                                                         | Check the id, then check `workspaceId`. Cross-tenant reads look identical to missing records on purpose.                                                      |
| 409    | `idempotency_conflict`    | The same key was already used for a different request body.                                                                                                                         | Use a fresh key for a genuinely different request.                                                                                                            |
| 409    | `idempotency_in_progress` | The same key is being processed right now.                                                                                                                                          | Wait and re-call with the same key. The completed response replays.                                                                                           |
| 422    |                           | The body failed the API's own validation.                                                                                                                                           | Read the message. The tool's input schema is narrower than the API's, so this usually means a value the schema cannot check, such as an id of the wrong kind. |
| 429    |                           | Rate limited. Already retried up to three times.                                                                                                                                    | Slow down. A 429 that reaches you means backoff did not clear it.                                                                                             |
| 5xx    |                           | Luca's API failed. 502, 503, and 504 were retried; 500 was not.                                                                                                                     | Retry a 500 yourself only if the operation is a read or you can reuse the same idempotency key.                                                               |

A replayed idempotent response carries an `Idempotency-Replayed: true` header. It
is a normal success, not a failure.

## Getting help with one

`LucaHttpError` carries `requestId` from the response's `x-request-id` header,
and `formatError` puts it in the message. Quote it when reporting a failure.
It is what ties your call to a single request in Luca's logs.
