import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import type { LucaConfig, RemoteSettings } from "./config.ts";
import { TokenVerificationUnavailable } from "./errors.ts";
import {
  createFixedWindowTable,
  type FixedWindowTable,
} from "./fixed-window.ts";
import {
  callApi,
  sha256Hex,
  type TokenResolver,
  unavailable,
} from "./token-verification.ts";

/**
 * Whether a token belongs to `apiKeyResolver` rather than `oauthResolver`.
 * Developer keys start with `luca_`. Refresh tokens start with `luca_ort_` and
 * are not developer keys, so they go to the OAuth resolver, which refuses them
 * without a network call. A malformed `luca_` token goes to `apiKeyResolver`
 * and is refused there, so it never leaves the process.
 */
export function looksLikeDeveloperKey(token: string): boolean {
  return /^luca_(?!ort_)/i.test(token);
}

const DEVELOPER_KEY = /^luca_[a-f0-9]{64}$/i;

/** The cheapest authenticated read in the public API. */
const KEY_CHECK_PATH = "/api/capabilities";

/** How long a passed key check is trusted. */
const KEY_CHECK_TTL_MS = 60_000;

/** Passed key checks by SHA-256 of the key, so no raw key is ever held. */
export type KeyCheckCache = FixedWindowTable;

export function createKeyCheckCache(): KeyCheckCache {
  return createFixedWindowTable(KEY_CHECK_TTL_MS);
}

/** One cache per isolate: the Worker builds a resolver per request. */
const ISOLATE_KEY_CHECKS = createKeyCheckCache();

/**
 * The shape of an error from the Luca API. A 403 carrying it is the API's own
 * scope answer, as opposed to an edge rule's.
 */
const LucaErrorBody = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    requestId: Schema.String,
  }),
});

/** The session middleware's answer to a key with several workspaces and none chosen. */
const WorkspaceRequiredBody = Schema.Struct({
  error: Schema.Literal("workspace_required"),
});

/** The session middleware's answer to a key that reaches no workspace. */
const NoWorkspaceAccessBody = Schema.Struct({
  error: Schema.Literal("forbidden"),
});

/**
 * The verdict an error answer carries, by status and body. Any other pairing
 * (an edge rule's page, an unknown body) says nothing about the key.
 */
const BODY_VERDICTS: ReadonlyArray<
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- each predicate is the parser for the error body read off the wire
  readonly [status: number, matches: (body: unknown) => boolean, valid: boolean]
> = [
  // The key authenticated; the check request named no workspace.
  [400, Schema.is(WorkspaceRequiredBody), true],
  // The key authenticated but lacks a scope for this route.
  [403, Schema.is(LucaErrorBody), true],
  // The key authenticated but reaches no workspace, so no call can succeed.
  [403, Schema.is(NoWorkspaceAccessBody), false],
];

function keyHeaders(
  settings: RemoteSettings,
  apiKey: string
): Record<string, string> {
  return settings.authHeader === "authorization"
    ? { accept: "application/json", authorization: `Bearer ${apiKey}` }
    : { accept: "application/json", "x-api-key": apiKey };
}

const verdictFromBody = (response: Response) =>
  Effect.tryPromise({
    try: () => response.json(),
    catch: unavailable("Key verification returned non-JSON content"),
  }).pipe(
    Effect.flatMap((body) =>
      Arr.findFirst(
        BODY_VERDICTS,
        ([status, matches]) => status === response.status && matches(body)
      ).pipe(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TokenVerificationUnavailable({
                message: `Key verification answered ${response.status} outside the Luca API`,
              })
            ),
          onSome: ([, , valid]) => Effect.succeed(valid),
        })
      )
    )
  );

/** Whether the API vouches for the key: `false` is a refusal, sent as a 401. */
const keyVerdict = (response: Response) => {
  if (response.status === 401) {
    return Effect.succeed(false);
  }

  if (response.ok) {
    return Effect.succeed(true);
  }

  return response.status === 400 || response.status === 403
    ? verdictFromBody(response)
    : Effect.fail(
        new TokenVerificationUnavailable({
          message: `Key verification answered ${response.status}`,
        })
      );
};

/**
 * Resolver where the bearer token IS a Luca developer API key. Zero new
 * privilege surface: the token resolves to exactly the coach scope that key
 * already grants, enforced server-side by the Luca API on each call. A token
 * that is not a well-formed key resolves to `None` with no network call. A
 * well-formed one is checked with one authenticated API call first, so a
 * fabricated key gets a 401 instead of a server.
 *
 * A 2xx accepts the key, and so do a 400 `workspace_required` and a 403 in the
 * API's error shape, because both mean the key authenticated. A 401, or a 403
 * `forbidden` for a key with no workspace, resolves to `None`. Anything else
 * fails as {@link TokenVerificationUnavailable}. A passed check is trusted for
 * 60 seconds, so only acceptances are cached.
 */
export function apiKeyResolver(
  settings: RemoteSettings,
  fetchImpl: typeof fetch = fetch,
  checks: KeyCheckCache = ISOLATE_KEY_CHECKS
): TokenResolver {
  const accepted = (token: string) =>
    Option.some<LucaConfig>({ ...settings, apiKey: Redacted.make(token) });

  const verify = (token: string, fingerprint: string) =>
    callApi(
      settings,
      fetchImpl,
      {
        path: KEY_CHECK_PATH,
        init: { method: "GET", headers: keyHeaders(settings, token) },
      },
      keyVerdict
    ).pipe(
      Effect.flatMap((valid) =>
        valid
          ? Effect.map(Clock.currentTimeMillis, (now) => {
              // A full table skips the entry, so the key is checked again
              // next time.
              checks.charge(fingerprint, now);

              return accepted(token);
            })
          : Effect.succeedNone
      )
    );

  return (token) =>
    DEVELOPER_KEY.test(token)
      ? Effect.gen(function* () {
          const fingerprint = yield* sha256Hex(token).pipe(
            Effect.mapError(unavailable("Could not fingerprint the key"))
          );

          const now = yield* Clock.currentTimeMillis;

          return checks.isLive(fingerprint, now)
            ? accepted(token)
            : yield* verify(token, fingerprint);
        })
      : Effect.succeedNone;
}
