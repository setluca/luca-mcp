import {
  createMcpHandler,
  type McpHttpHandler,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";

import { addressKey } from "./client-address.ts";
import { LucaApi, createLucaApi } from "./http.ts";
import { bearerChallenge, type OAuthError } from "./oauth-challenge.ts";
import { logAgentSurfaceEvent } from "./observability.ts";
import { optionalField } from "./optional-field.ts";
import {
  RATE_LIMIT_WINDOW_MS,
  type RateLimit,
  type RateLimits,
  createLocalRateLimits,
} from "./rate-limit.ts";
import { OAUTH_DEFAULT_SCOPE } from "./scopes.ts";
import { toJsonPayload } from "./serialization.ts";
import { createLucaServer, type LucaToolset, parseToolset } from "./server.ts";
import { sha256Hex, type TokenResolver } from "./token-verification.ts";

export type { RemoteSettings } from "./config.ts";

export type {
  RateLimits,
  RemoteRateLimiter,
  RemoteRateLimiters,
} from "./rate-limit.ts";

export { bindingRateLimits, createLocalRateLimits } from "./rate-limit.ts";

export { apiKeyResolver, looksLikeDeveloperKey } from "./resolvers.ts";

export type { TokenResolver } from "./token-verification.ts";

export type RemoteHandlerOptions = {
  readonly resolveToken: TokenResolver;
  /** Path the MCP endpoint is served at. Defaults to `/mcp`. */
  readonly mcpPath?: string;
  /**
   * RFC 9728 protected-resource metadata URL advertised on 401s so OAuth
   * clients can discover the authorization server (MCP authorization spec).
   */
  readonly resourceMetadataUrl?: string;
  /** Tool surface for every session this handler serves. Defaults to full. */
  readonly toolset?: LucaToolset;
  /**
   * Limits for the auth path. The Worker builds them once per isolate, from
   * its Cloudflare bindings or in memory, because it makes a handler per
   * request. Without them the handler holds in-process limits of its own with
   * the same budgets.
   */
  readonly rateLimits?: RateLimits;
  /**
   * Hostnames a browser `Origin` header may name, in addition to the host the
   * request was sent to. A request with no `Origin` is not a browser request
   * and passes. Any other origin gets a 403, which is the DNS-rebinding guard
   * the MCP transport spec requires.
   */
  readonly allowedOrigins?: readonly string[];
  /** Out-of-band errors the SDK reports while serving. Reporting only. */
  readonly onError?: (error: Error) => void;
};

/**
 * Per-request toolset selection: the `?toolset=` query param wins so a single
 * deployment can serve both surfaces; the `LUCA_TOOLSET` var is the default;
 * anything unrecognized (including bogus params) falls back to `full`.
 */
export function resolveToolset(
  url: URL,
  env: { readonly LUCA_TOOLSET?: string }
): LucaToolset {
  return parseToolset(url.searchParams.get("toolset") ?? env.LUCA_TOOLSET);
}

// Stryker disable next-line Regex: `.trim()` on the greedy capture makes `\s+` and `\s` indistinguishable
const BEARER = /^Bearer\s+(.+)$/i;

const MAX_BEARER_TOKEN_LENGTH = 4096;

/** The bearer token on a request, absent when the header is missing or empty. */
function bearerToken(request: Request): Option.Option<string> {
  return Option.fromNullishOr(request.headers.get("authorization")).pipe(
    // Stryker disable next-line OptionalChaining: capture group 1 is always present on a match
    Option.flatMapNullishOr((header) => BEARER.exec(header)?.[1]?.trim()),
    Option.filter(Str.isNonEmpty)
  );
}

/**
 * The caller's address as Cloudflare saw it, keyed by {@link addressKey}.
 * `X-Forwarded-For` is never read: any client can set it, so trusting it
 * would let one caller rotate through fresh budgets.
 *
 * This trusts `cf-connecting-ip` as sent and assumes a Cloudflare runtime that
 * sets it and strips any client-supplied copy. Outside Cloudflare, or on a
 * route that bypasses it, a caller can write the header itself and pick its own
 * rate-limit bucket. Without the header every caller shares the `unknown`
 * bucket.
 */
function clientAddress(request: Request): string {
  return addressKey(
    request.headers.get("cf-connecting-ip")?.trim() || "unknown"
  );
}

/** A JSON error body with its status and any extra headers. */
function jsonResponse(
  status: number,
  body: Record<string, string>,
  headers: Record<string, string> = {}
): Response {
  return new Response(toJsonPayload(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A refused request can retry once the current window has closed. */
const RATE_LIMIT_RETRY_AFTER_SECONDS = String(RATE_LIMIT_WINDOW_MS / 1000);

const rateLimited = () =>
  jsonResponse(
    429,
    { error: "rate_limited", detail: "Too many requests" },
    { "retry-after": RATE_LIMIT_RETRY_AFTER_SECONDS }
  );

/** Seconds a client should wait before retrying through an outage. */
const OUTAGE_RETRY_AFTER_SECONDS = "5";

const serviceUnavailable = (detail: string) =>
  jsonResponse(
    503,
    { error: "service_unavailable", detail },
    { "retry-after": OUTAGE_RETRY_AFTER_SECONDS }
  );

// Failing closed keeps a broken distributed binding from turning the bearer
// endpoint into an unbounded OAuth and server-build oracle.
const rateLimiterUnavailable = () =>
  serviceUnavailable("Authentication throttling is temporarily unavailable");

/** SHA-256 of the token, so the limiter never stores a credential. */
const tokenFingerprint = (token: string) =>
  sha256Hex(token).pipe(Effect.mapError(rateLimiterUnavailable));

const consume = (limit: RateLimit, key: string) =>
  limit(key).pipe(
    Effect.mapError(rateLimiterUnavailable),
    Effect.filterOrFail((allowed) => allowed, rateLimited)
  );

/**
 * Charges a request that carries a token to its client address. The budget is
 * looser than the per-token one, and it bounds a caller who rotates through
 * tokens that never repeat.
 */
const throttleTokenAddress = (request: Request, rateLimits: RateLimits) =>
  consume(rateLimits.perTokenAddress, `ip:${clientAddress(request)}`);

/** Charges a request against the token it carries. */
const throttleToken = (token: string, rateLimits: RateLimits) =>
  tokenFingerprint(token).pipe(
    Effect.flatMap((fingerprint) =>
      consume(rateLimits.perToken, `token:${fingerprint}`)
    )
  );

/** Charges a request without a token against its client address. */
const throttleAnonymous = (request: Request, rateLimits: RateLimits) =>
  consume(rateLimits.perAnonymousAddress, `ip:${clientAddress(request)}`);

/**
 * A 401 with the RFC 6750 challenge. `resource_metadata` points OAuth clients
 * at the RFC 9728 document that names the authorization server. Only a request
 * with no token also gets the `scope` hint: a client whose token was refused
 * must refresh it, not ask for a different scope.
 */
function unauthorized(
  detail: string,
  resourceMetadataUrl: string | undefined,
  error?: OAuthError
): Response {
  const challenge = bearerChallenge({
    resourceMetadataUrl,
    ...(error === undefined ? { scope: OAUTH_DEFAULT_SCOPE } : { error }),
  });

  return jsonResponse(
    401,
    { error: "unauthorized", detail },
    { "www-authenticate": challenge }
  );
}

const invalidToken = (resourceMetadataUrl: string | undefined) =>
  unauthorized(
    "Invalid or expired token",
    resourceMetadataUrl,
    "invalid_token"
  );

const notFound = () => jsonResponse(404, { error: "not_found" });

/**
 * Hands the response back with the handler still open, and closes it once the
 * body has been read to the end or cancelled. `handler.close()` aborts every
 * exchange in flight, so closing it as soon as `fetch` resolves would cut off
 * an SSE response mid-stream.
 */
function closeAfterBody(
  response: Response,
  handler: McpHttpHandler
): Effect.Effect<Response> {
  // oxlint-disable-next-line effect/effect-promise-vs-trypromise -- the SDK handler answers protocol failures with a Response, so a rejection here is a defect; the Worker should surface it, not turn it into a reply.
  const close = Effect.promise(() => handler.close());

  if (response.body === null) {
    return Effect.as(close, response);
  }

  const body = response.body;

  return Effect.succeed(
    new Response(
      Stream.fromReadableStream({
        evaluate: () => body,
        onError: (error) => error,
      }).pipe(Stream.ensuring(close), Stream.toReadableStream()),
      response
    )
  );
}

/**
 * A Web Standard fetch handler that serves the Luca MCP server over Streamable
 * HTTP: each request authenticates via a bearer token, builds a fresh server
 * bound to that coach's config, handles the one request, and tears down. Runs
 * on any Web Standard runtime (Cloudflare Workers, Deno, Bun, Node 18+).
 *
 * The 2026-07-28 revision carries protocol version, client identity, and
 * capabilities on every request instead of a session, which is why the server
 * can be per-request with nothing held in between. `createMcpHandler` defaults
 * to `legacy: 'stateless'`, so a client still speaking the 2025 revision keeps
 * working through the same factory: it gets its own instance for the one
 * request it sends, and no session state exists on either path to drain.
 */
export function createRemoteHandler(options: RemoteHandlerOptions) {
  const respond = createRemoteResponder(options);

  return (request: Request): Promise<Response> =>
    Effect.runPromise(respond(request));
}

/**
 * The Effect behind {@link createRemoteHandler}, for a caller that runs its
 * own Effect program around the request, as the Worker does.
 */
export function createRemoteResponder(options: RemoteHandlerOptions) {
  const mcpPath = options.mcpPath ?? "/mcp";
  const rateLimits = options.rateLimits ?? createLocalRateLimits();
  const allowedOrigins = options.allowedOrigins ?? [];

  return (request: Request): Effect.Effect<Response> =>
    Effect.gen(function* () {
      const url = new URL(request.url);

      if (url.pathname !== mcpPath) {
        return yield* Effect.fail(notFound());
      }

      // Before auth, so a page on another site learns nothing about tokens.
      const forbiddenOrigin = originValidationResponse(request, [
        url.hostname,
        ...allowedOrigins,
      ]);

      if (forbiddenOrigin !== undefined) {
        return yield* Effect.fail(forbiddenOrigin);
      }

      const token = bearerToken(request);

      if (Option.isNone(token)) {
        yield* throttleAnonymous(request, rateLimits);

        return yield* Effect.fail(
          unauthorized("Missing bearer token", options.resourceMetadataUrl)
        );
      }

      yield* throttleTokenAddress(request, rateLimits);

      if (token.value.length > MAX_BEARER_TOKEN_LENGTH) {
        return yield* Effect.fail(invalidToken(options.resourceMetadataUrl));
      }

      yield* throttleToken(token.value, rateLimits);

      const config = yield* options.resolveToken(token.value).pipe(
        Effect.mapError((error) => {
          // The message names the failure, never the token or the response.
          logAgentSurfaceEvent("mcp.token_verification_unavailable", {
            message: error.message,
          });

          return serviceUnavailable(
            "Token verification is temporarily unavailable"
          );
        })
      );

      if (Option.isNone(config)) {
        return yield* Effect.fail(invalidToken(options.resourceMetadataUrl));
      }

      const handler = createMcpHandler(
        () =>
          createLucaServer({
            lucaLayer: Layer.succeed(LucaApi, createLucaApi(config.value)),
            ...optionalField("toolset", options.toolset),
            ...optionalField(
              "resourceMetadataUrl",
              options.resourceMetadataUrl
            ),
          }),
        { ...optionalField("onerror", options.onError) }
      );

      // The handler lives until the response body is done with, then
      // closes. If fetch itself fails, it closes here instead.
      // oxlint-disable-next-line effect/effect-promise-vs-trypromise -- the SDK handler answers protocol failures with a Response, so a rejection here is a defect; the Worker should surface it, not turn it into a reply.
      return yield* Effect.promise(() => handler.fetch(request)).pipe(
        // oxlint-disable-next-line effect/effect-promise-vs-trypromise -- teardown after a defect; a rejection from close() is a defect too.
        Effect.onError(() => Effect.promise(() => handler.close())),
        Effect.flatMap((response) => closeAfterBody(response, handler))
      );
      // Every rejection travels the error channel as the Response to send,
      // so either outcome is the reply.
    }).pipe(
      Effect.match({
        onFailure: (rejection: Response) => rejection,
        onSuccess: (response) => response,
      })
    );
}
