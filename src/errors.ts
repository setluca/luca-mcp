import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";

import { toJsonPayload } from "./serialization.ts";
import type { JsonValue } from "./serialization.ts";

export class LucaConfigError extends Schema.TaggedError<LucaConfigError>()(
  "LucaConfigError",
  {
    message: Schema.String,
  }
) {}

export class LucaNetworkError extends Schema.TaggedError<LucaNetworkError>()(
  "LucaNetworkError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Unknown),
  }
) {}

export class LucaDecodeError extends Schema.TaggedError<LucaDecodeError>()(
  "LucaDecodeError",
  {
    message: Schema.String,
    body: Schema.String,
  }
) {}

export class LucaHttpError extends Schema.TaggedError<LucaHttpError>()(
  "LucaHttpError",
  {
    status: Schema.Number,
    statusText: Schema.String,
    body: Schema.Json,
    requestId: Schema.optionalKey(Schema.String),
    /**
     * How long the server asked us to wait, from its `Retry-After` header. Absent
     * when the header was missing or unreadable.
     */
    retryAfterMs: Schema.optionalKey(Schema.Number),
  }
) {}

/**
 * One attempt ran past the request timeout and was cancelled. It is its own
 * error rather than a network error because a caller can retry it safely under
 * the same rules but cannot tell from a network failure whether the request
 * reached the API.
 */
export class LucaTimeoutError extends Schema.TaggedError<LucaTimeoutError>()(
  "LucaTimeoutError",
  {
    message: Schema.String,
  }
) {}

/**
 * A tool was called with arguments that are not a JSON object. The MCP SDK
 * validates against the tool's own input schema before the handler runs, so a
 * real client cannot reach this. It exists so no code ahead of `runPromise` can
 * throw where the error channel cannot see it.
 */
export class LucaToolInputError extends Schema.TaggedError<LucaToolInputError>()(
  "LucaToolInputError",
  {
    message: Schema.String,
  }
) {}

/**
 * A gated tool was called without `confirm: true`. It stays out of
 * {@link LucaError} because no request was sent: the tool pipeline turns it
 * into its own result telling the agent which argument to add.
 */
export class LucaConfirmationRequired extends Schema.TaggedError<LucaConfirmationRequired>()(
  "LucaConfirmationRequired",
  {
    toolName: Schema.String,
  }
) {}

/**
 * The service that verifies bearer tokens could not give an answer: it was
 * unreachable, timed out, or answered with a server error. This is not a
 * verdict on the token. The transport replies 503 so a client retries instead
 * of discarding a token that may be valid and starting a new sign-in.
 */
export class TokenVerificationUnavailable extends Schema.TaggedError<TokenVerificationUnavailable>()(
  "TokenVerificationUnavailable",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Unknown),
  }
) {}

export type LucaError =
  | LucaConfigError
  | LucaNetworkError
  | LucaDecodeError
  | LucaHttpError
  | LucaTimeoutError
  | LucaToolInputError;

/** Whether the API answered that the thing asked for does not exist. */
export function isNotFound(error: LucaError) {
  return P.isTagged(error, "LucaHttpError") && error.status === 404;
}

/**
 * An API error body whose code means the key is valid but its scopes fall
 * short: `scope_required` for a missing API scope, `needs_scope` for a
 * capability tier below the route's.
 */
const ScopeErrorBody = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Literals(["scope_required", "needs_scope"]),
  }),
});

const isScopeErrorBody = Schema.is(ScopeErrorBody);

/**
 * Whether the API answered 403 because the caller's scopes fall short. Any
 * other 403 covers plan limits and workspace access, which re-authorizing
 * cannot fix.
 */
export function isScopeRefusal(error: LucaError): boolean {
  return (
    P.isTagged(error, "LucaHttpError") &&
    error.status === 403 &&
    isScopeErrorBody(error.body)
  );
}

/**
 * Whether the API refused the caller's credentials rather than the request: a
 * 401, or a scope refusal. Re-authorizing fixes these.
 */
export function isAuthorizationFailure(error: LucaError): boolean {
  return (
    (P.isTagged(error, "LucaHttpError") && error.status === 401) ||
    isScopeRefusal(error)
  );
}

/**
 * A body the API could not send as JSON, named by its length only. It is
 * usually an edge or proxy page, text no Luca schema shaped, and quoting it
 * would hand the agent instructions with nothing marking them as untrusted.
 */
function formatDecodeError(error: LucaDecodeError) {
  return `${error.message} (${error.body.length} characters)`;
}

function formatHttpError(error: LucaHttpError) {
  const request = Option.fromNullishOr(error.requestId).pipe(
    Option.match({
      onNone: () => "",
      onSome: (requestId) => ` requestId=${requestId}`,
    })
  );

  return `Luca API returned ${error.status} ${error.statusText}${request}: ${toJsonPayload(error.body)}`;
}

/**
 * A value that carries no message of its own, rendered for a human. A string is
 * handed back as it was thrown, since quoting it would put the reader a step
 * further from the value than the throw site was. Everything else comes back as
 * JSON rather than "[object Object]". Numbers and booleans need no case of
 * their own: JSON renders each of them exactly as `String` would.
 */
function formatJsonValue(error: JsonValue): string {
  return P.isString(error) ? error : toJsonPayload(error);
}

/** Any failure this server can hand a client, as one line of text. */
export function formatError(error: LucaError | Error | JsonValue): string {
  // oxlint-disable-next-line effect/avoid-untagged-errors -- boundary narrows an unknown thrown value that carries no tag
  return error instanceof Error ? formatThrown(error) : formatJsonValue(error);
}

/**
 * A thrown value rendered for a human. The two structured errors get their own
 * rendering; every other tagged error carries a `message`, and one branch
 * covers all of them rather than a case per tag that would all say the same
 * thing.
 *
 * The match is on the class, not on `_tag`. This takes any `Error`, including
 * one thrown by a dependency that carries no tag at all, so there is no tagged
 * union here for `Match.tag` to narrow.
 */
function formatThrown(error: Error): string {
  return Match.value(error).pipe(
    Match.when(Match.instanceOf(LucaDecodeError), formatDecodeError),
    Match.when(Match.instanceOf(LucaHttpError), formatHttpError),
    Match.orElse((thrown) => thrown.message)
  );
}
