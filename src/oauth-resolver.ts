import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import type { LucaConfig, RemoteSettings } from "./config.ts";
import { TokenVerificationUnavailable } from "./errors.ts";
import { NonEmptyString } from "./fields.ts";
import {
  callApi,
  type TokenResolver,
  unavailable,
} from "./token-verification.ts";

/**
 * The body POST /oauth/resolve answers with for a token it accepted. The API
 * also sends the grant's scopes; the Luca API enforces them on every call, so
 * this resolver does not read them. An empty key is an API fault, not a key,
 * so it fails as unavailable instead of reaching the API as a blank header.
 */
const ResolvePayload = Schema.Struct({
  apiKey: Schema.optionalKey(NonEmptyString),
});

type ResolvePayload = typeof ResolvePayload.Type;

const decodeResolvePayload = Schema.decodeUnknownEffect(ResolvePayload);

/**
 * The body of a resolve response, absent when the API refused the token. Only
 * a 401 is that verdict: any other non-2xx (a 404 from a misrouted base URL, a
 * 403 from an edge rule, a 429, a 5xx) says nothing about the token, so it must
 * not send the client back through sign-in. A refusal is not read at all. A
 * 2xx with a body this resolver cannot read is an API fault, not a verdict, so
 * it fails as unavailable.
 */
function resolvePayload(response: Response) {
  if (response.status === 401) {
    return Effect.succeed(Option.none<ResolvePayload>());
  }

  if (!response.ok) {
    return Effect.fail(
      new TokenVerificationUnavailable({
        message: `Token verification answered ${response.status}`,
      })
    );
  }

  return Effect.tryPromise({
    try: () => response.json(),
    catch: unavailable("Token verification returned non-JSON content"),
  }).pipe(
    Effect.flatMap((body) =>
      decodeResolvePayload(body).pipe(
        Effect.mapError(
          unavailable("Token verification returned an unexpected body")
        )
      )
    ),
    Effect.map(Option.some)
  );
}

/**
 * One authenticated call to POST /oauth/resolve, answered with the config for
 * the vended key the token maps to. A 401, or a payload with no key, is no
 * config, which the transport turns into 401. A network failure, a timeout, or
 * any other non-2xx is {@link TokenVerificationUnavailable}, which the transport
 * turns into 503. Both fail closed. Telling them apart reveals nothing about
 * the token, and it stops an outage from sending every connected client back
 * through sign-in.
 */
function requestConfig(
  settings: RemoteSettings,
  fetchImpl: typeof fetch,
  token: string
) {
  return callApi(
    settings,
    fetchImpl,
    {
      path: "/oauth/resolve",
      init: { method: "POST", headers: { authorization: `Bearer ${token}` } },
    },
    resolvePayload
  ).pipe(
    Effect.map((payload) =>
      Option.flatMapNullishOr(payload, (body) => body.apiKey).pipe(
        Option.map((apiKey): LucaConfig => ({
          ...settings,
          apiKey: Redacted.make(apiKey),
        }))
      )
    )
  );
}

/** Three base64url segments: the form a JWT access token takes. */
const JWT_ACCESS_TOKEN = /^[\w-]+\.[\w-]+\.[\w-]+$/;

/**
 * Resolver for OAuth access tokens (docs/runbooks/mcp-oauth-authorization-server.md
 * §5.2): one authenticated call to the Luca API's POST /oauth/resolve, which
 * verifies the JWT and returns the hidden vended key for the token's own
 * grant. The config it returns carries the same settings the stdio path reads,
 * so the vended key reaches the API with the same base URL, auth header, and
 * timeout. Developer keys never come here: the Worker sends them to
 * `apiKeyResolver` by shape (see `looksLikeDeveloperKey`). A token that is not
 * JWT-shaped is refused without calling the API.
 */
export function oauthResolver(
  settings: RemoteSettings,
  fetchImpl: typeof fetch = fetch
): TokenResolver {
  return (token) =>
    JWT_ACCESS_TOKEN.test(token)
      ? requestConfig(settings, fetchImpl, token)
      : Effect.succeedNone;
}
