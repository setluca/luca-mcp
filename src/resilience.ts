import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Str from "effect/String";

import {
  formatError,
  type LucaError,
  LucaHttpError,
  LucaTimeoutError,
} from "./errors.ts";

/**
 * The statuses worth considering for a retry. A gateway can answer after the
 * handler ran, so a replay is still subject to read-only or idempotency rules.
 *
 * 500 is deliberately not here. A 500 means the handler ran and threw, which
 * may well be after it wrote something. Replaying that without an idempotency
 * key can double the write.
 */

const RETRYABLE_STATUSES = HashSet.fromIterable([429, 502, 503, 504]);

/**
 * The longest server-requested wait we will sit through. Past this the server
 * is not asking for a retry, it is asking us to come back later. Holding a
 * tool call open for minutes is worse for the caller than reporting the 429.
 */
const MAX_RETRY_AFTER_MS = 10_000;

const RETRY_ATTEMPTS = 3;

/**
 * Backoff of roughly 200ms, 400ms, 800ms, each shifted by 0.8x-1.2x so a fleet
 * of clients that all failed at once does not come back in lockstep.
 * `Schedule.recurs` caps the number of attempts; `Schedule.upTo` caps elapsed
 * time instead, which is a different job.
 */
const httpRetrySchedule = Schedule.max([
  Schedule.exponential(Duration.millis(200), 2).pipe(Schedule.jittered),
  Schedule.recurs(RETRY_ATTEMPTS),
]);

/**
 * Everything the retry rules read about a request: the catalog's read-only
 * guarantee decides whether a replay can repeat an effect, and the key decides
 * whether the API would dedupe a state-changing call. The method is retained
 * for the timeout message, not as a replay-safety shortcut.
 * The per-attempt timeout bounds a request but never decides a replay.
 */
export type RetryPolicy = {
  readonly method: string;
  readonly readOnly: boolean;
  readonly idempotencyKey: string | undefined;
};

/**
 * The part of a request these rules read. Stated structurally rather than
 * imported, so the transport can hand its own request straight in and this
 * module keeps no dependency on it.
 */
type RetryableRequest = {
  readonly operation: {
    readonly method: string;
    readonly readOnly: boolean;
    readonly idempotencyRequired: boolean;
  };
  readonly idempotencyKey?: string;
};

/**
 * The idempotency key an attempt carries, absent for operations that do not
 * require one. An operation that requires a key the caller did not supply gets
 * a fresh one rather than being sent unprotected.
 */
function idempotencyKeyFor(request: RetryableRequest): string | undefined {
  if (!request.operation.idempotencyRequired) {
    return;
  }

  return request.idempotencyKey ?? crypto.randomUUID();
}

/** How long the server asked us to wait, absent when it asked for nothing. */
function requestedDelay(error: LucaError): Option.Option<number> {
  return Match.value(error).pipe(
    Match.when(Match.instanceOf(LucaHttpError), (http) =>
      Option.fromNullishOr(http.retryAfterMs)
    ),
    Match.orElse(() => Option.none<number>())
  );
}

/**
 * The wait to sit out before replaying. No cap is applied here: {@link mayRetry}
 * already refused an overlong wait, and the schedule only reads this for a
 * failure it agreed to replay.
 */
function serverDelay(error: LucaError): Option.Option<Duration.Duration> {
  return Option.map(requestedDelay(error), Duration.millis);
}

/**
 * The failures that carry no verdict of their own. A network failure and a
 * timeout both leave the request's fate unknown; every other tag means the
 * server answered, so the answer is the outcome.
 */

const TRANSIENT_TAGS = HashSet.fromIterable([
  "LucaNetworkError",
  "LucaTimeoutError",
]);

/** A failure that says nothing about whether the request was handled. */
function isTransient(error: LucaError): boolean {
  return error instanceof LucaHttpError
    ? HashSet.has(RETRYABLE_STATUSES, error.status)
    : HashSet.has(TRANSIENT_TAGS, error._tag);
}

/**
 * Whether this failure may be sent again. Read-only calls are replayable. A write
 * is replayable only when it carries an idempotency key, because the API dedupes
 * by [organizationId, coachId, actorId, method, path, key] and that is the only
 * replay which cannot file the same write twice.
 *
 * A server that asked for a wait longer than we are willing to hold is refused
 * here too, so the schedule's wait and this decision never disagree.
 */
export function mayRetry(policy: RetryPolicy, error: LucaError): boolean {
  if (!isTransient(error)) {
    return false;
  }

  if (Option.exists(requestedDelay(error), (ms) => ms > MAX_RETRY_AFTER_MS)) {
    return false;
  }

  return policy.readOnly || policy.idempotencyKey !== undefined;
}

/**
 * The backoff schedule with a `Retry-After` folded in: the next replay waits
 * for whichever is longer, the backoff or the server's delay. The delay is read
 * only when the schedule recurs, so the last attempt fails at once instead of
 * sitting out a wait no replay will follow.
 */
const retrySchedule = httpRetrySchedule.pipe(
  Schedule.modifyDelay(
    ({ input, duration }: Schedule.Metadata<Duration.Duration, LucaError>) =>
      Effect.succeed(
        Option.match(serverDelay(input), {
          onNone: () => duration,
          onSome: (wait) => Duration.max(duration, wait),
        })
      )
  )
);

/**
 * The longest one call may take across every attempt and every wait between
 * them. Each attempt is still bounded on its own; this caps the sum, so a slow
 * API cannot hold a tool call open past the point a hosted client gives up.
 */
const CALL_DEADLINE_MS = 45_000;

const LAST_FAILURE_EXCERPT = 300;

/**
 * What the last failed attempt said, for a deadline that cut the call short. A
 * 503 or 429 that was being retried is the real reason the call went nowhere,
 * and the bare deadline message would hide it. A timeout adds nothing the
 * message does not already say, so it is left out.
 */
function lastFailureNote(lastFailure: Option.Option<LucaError>): string {
  return Option.match(lastFailure, {
    onNone: () => "",
    onSome: (error) =>
      error instanceof LucaTimeoutError
        ? ""
        : `. Last failure: ${Str.slice(0, LAST_FAILURE_EXCERPT)(formatError(error))}`,
  });
}

/**
 * The timeout a caller reads. A read-only call can be sent again. A call that
 * changes state and timed out may or may not have landed, so the message says
 * so and names the key that makes a second send safe when there is one.
 */
function timeoutError(
  policy: RetryPolicy,
  ms: number,
  lastFailure: Option.Option<LucaError> = Option.none()
) {
  const base = `Luca API did not answer within ${ms}ms${lastFailureNote(lastFailure)}`;

  if (policy.readOnly) {
    return new LucaTimeoutError({ message: base });
  }

  const replay =
    policy.idempotencyKey === undefined
      ? "Check whether it took effect before sending it again."
      : `Check whether it took effect, or send it again with idempotencyKey "${policy.idempotencyKey}" so the API cannot apply it twice.`;

  return new LucaTimeoutError({
    message: `${base}. The outcome is unknown: this ${policy.method} may or may not have been applied. ${replay}`,
  });
}

/**
 * One request, bounded and replayed under the rules above.
 *
 * Two bounds apply. The per-attempt timeout guards one socket that never
 * answers, and lets a replayable request try again. {@link CALL_DEADLINE_MS}
 * caps the whole run, waits included. `timeoutOrElse` keeps both failures
 * inside `LucaError` instead of leaking a `TimeoutError` as a defect.
 *
 * `Retry-After` is honoured by {@link retrySchedule}, which stretches the
 * backoff to the server's delay before a replay.
 */
export function resilient<A>(
  request: RetryableRequest,
  timeoutMs: number,
  attempt: (
    idempotencyKey: string | undefined
  ) => Effect.Effect<A, LucaError, never>,
  deadlineMs: number = CALL_DEADLINE_MS
): Effect.Effect<A, LucaError, never> {
  // Minted when the program runs, once per run rather than once per attempt,
  // and handed to the sender. The API dedupes a write by this key, so a header
  // and a replay decision derived from two different values would file the
  // same write twice. Minting at build time instead would hand every run of
  // the same program one key, and the API would drop the second run as a
  // replay of the first.
  return Effect.gen(function* () {
    const idempotencyKey = idempotencyKeyFor(request);
    const lastFailure = yield* Ref.make(Option.none<LucaError>());

    const policy: RetryPolicy = {
      method: request.operation.method,
      readOnly: request.operation.readOnly,
      idempotencyKey,
    };

    return yield* attempt(idempotencyKey).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(timeoutMs),
        orElse: () => Effect.fail(timeoutError(policy, timeoutMs)),
      }),
      // Recorded after the per-attempt timeout so a hung attempt counts too,
      // and before the retry so every failure the schedule swallows is seen.
      Effect.tapError((error) => Ref.set(lastFailure, Option.some(error))),
      Effect.retry({
        schedule: retrySchedule,
        while: (error: LucaError) => mayRetry(policy, error),
      }),
      Effect.timeoutOrElse({
        duration: Duration.millis(deadlineMs),
        orElse: () =>
          Ref.get(lastFailure).pipe(
            Effect.flatMap((last) =>
              Effect.fail(timeoutError(policy, deadlineMs, last))
            )
          ),
      })
    );
  });
}
