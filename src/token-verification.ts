import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { LucaConfig, RemoteSettings } from "./config.ts";
import { TokenVerificationUnavailable } from "./errors.ts";

/**
 * Maps an inbound bearer token to the coach's API config, or `None` when the
 * token is unknown or expired. The config is the same shape the stdio path
 * builds from env, so the MCP server behaves identically however the request
 * arrived. The remote transport changes how a call reaches Luca, never what it
 * is allowed to do.
 *
 * This is the seam between the transport and the auth model: `apiKeyResolver`
 * reads the token as a Luca API key and `oauthResolver` asks the API about an
 * OAuth-issued one (see ADR 0006).
 *
 * The failure channel is for an outage, not a rejection. A verifier that
 * cannot answer fails with `TokenVerificationUnavailable`, and the handler
 * answers 503 so the client retries instead of discarding a valid token.
 */
export type TokenResolver = (
  token: string
) => Effect.Effect<Option.Option<LucaConfig>, TokenVerificationUnavailable>;

/**
 * The longest a verification call may run. It sits in front of every remote
 * request, so a slow API answers 503 within seconds instead of holding the
 * client for the full API timeout. A shorter configured timeout still wins.
 */
const VERIFY_TIMEOUT_MS = 5000;

export function unavailable(message: string) {
  return (cause: unknown) =>
    new TokenVerificationUnavailable({ message, cause });
}

/** SHA-256 of a secret as hex, so a limiter or cache never stores it. */
export const sha256Hex = (value: string) =>
  Effect.tryPromise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  ).pipe(
    Effect.map((digest) =>
      Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("")
    )
  );

/**
 * One bounded call to the Luca API that carries a token, with `read` turning
 * the response into the verdict. Timeout but no retry: this is on the auth
 * path of every request, and the client retries a 503 on its own schedule. A
 * redirect is refused, because it would carry the token to a host we never
 * named. Cloudflare Workers does not support `redirect: "error"`, so fetch
 * uses `manual` and we reject 3xx responses before the resolver reads them.
 */
export function callApi<A>(
  settings: RemoteSettings,
  fetchImpl: typeof fetch,
  request: { readonly path: string; readonly init: RequestInit },
  read: (response: Response) => Effect.Effect<A, TokenVerificationUnavailable>
): Effect.Effect<A, TokenVerificationUnavailable> {
  const controller = new AbortController();

  const timeoutMs = Math.min(
    settings.requestTimeoutMs ?? VERIFY_TIMEOUT_MS,
    VERIFY_TIMEOUT_MS
  );

  return Effect.tryPromise({
    try: () =>
      fetchImpl(`${settings.apiBaseUrl}${request.path}`, {
        ...request.init,
        redirect: "manual",
        signal: controller.signal,
      }),
    catch: unavailable("Could not reach token verification"),
  }).pipe(
    Effect.flatMap((response) =>
      response.status >= 300 && response.status < 400
        ? Effect.fail(
            new TokenVerificationUnavailable({
              message: "Token verification redirected",
            })
          )
        : read(response)
    ),
    Effect.timeoutOrElse({
      duration: Duration.millis(timeoutMs),
      orElse: () =>
        Effect.fail(
          new TokenVerificationUnavailable({
            message: `Token verification did not answer within ${timeoutMs}ms`,
          })
        ),
    }),
    // The signal belongs to the whole exchange, body read included, so abort
    // on every exit: a timed-out or unread response cannot outlive the auth
    // decision it was made for.
    Effect.ensuring(Effect.sync(() => controller.abort()))
  );
}
