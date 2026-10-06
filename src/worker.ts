import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/server";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Str from "effect/String";

import {
  loadRemoteSettings,
  type RemoteSettings,
  withoutTrailingSlashes,
} from "./config.ts";
import { LucaConfigError } from "./errors.ts";
import { oauthResolver } from "./oauth-resolver.ts";
import { LUCA_OPERATIONS } from "./operations.ts";
import {
  bindingRateLimits,
  createLocalRateLimits,
  type RateLimits,
  type RemoteRateLimiter,
} from "./rate-limit.ts";
import { createRemoteResponder, resolveToolset } from "./remote.ts";
import { apiKeyResolver, looksLikeDeveloperKey } from "./resolvers.ts";
import { LUCA_RESOURCE_SCOPES } from "./scopes.ts";
import { type JsonValue, toJsonPayload } from "./serialization.ts";
import { LUCA_SERVER_INFO } from "./server.ts";
import { LUCA_TASK_TOOLS } from "./task-tools.ts";

/**
 * Cloudflare Worker entry for the remote MCP transport (setluca-mcp,
 * mcp.setluca.com). Not part of the npm stdio package: the build tsconfig
 * excludes it, and wrangler bundles it straight from src.
 *
 * Serves:
 * - POST /mcp, Streamable HTTP MCP. The bearer is an OAuth access token,
 *   resolved through the Luca API's /oauth/resolve, or a developer API key.
 * - GET /.well-known/mcp/server-card.json, the MCP server card for agent
 *   discovery.
 * - GET /.well-known/oauth-protected-resource[/mcp], the RFC 9728 metadata
 *   pointing OAuth clients at the Luca authorization server.
 * - GET /.well-known/openai-apps-challenge, the domain-verification token the
 *   OpenAI apps portal asks for. 404 until the token is configured.
 *
 * An unknown LUCA_AUTH_HEADER answers every request with 500, so a typo in
 * the deploy config fails loudly instead of sending keys in the wrong header.
 * So does a production deploy missing any rate-limit binding, which would
 * otherwise fall back to a per-isolate limit that never adds up.
 */
type WorkerEnv = {
  readonly LUCA_API_BASE_URL?: string;
  /** Direct binding to setluca-api; bypasses the public WAF. */
  readonly LUCA_API?: { readonly fetch: typeof fetch };
  /** x-api-key (default), authorization, or its alias bearer. */
  readonly LUCA_AUTH_HEADER?: string;
  /** Per-attempt timeout for calls to the Luca API, in milliseconds. */
  readonly LUCA_REQUEST_TIMEOUT_MS?: string;
  /** Public origin of this Worker, e.g. https://mcp.setluca.com. */
  readonly MCP_PUBLIC_ORIGIN?: string;
  /** Default tool surface (full | tasks); a ?toolset= query param overrides. */
  readonly LUCA_TOOLSET?: string;
  /** `production` makes all three rate-limit bindings required. */
  readonly NODE_ENV?: string;
  /** Cloudflare Rate Limit binding charged per bearer token. */
  readonly MCP_AUTH_RATE_LIMIT?: RemoteRateLimiter;
  /** Cloudflare Rate Limit binding charged per address for token-bearing requests. */
  readonly MCP_TOKEN_ADDRESS_RATE_LIMIT?: RemoteRateLimiter;
  /** Cloudflare Rate Limit binding charged per address for token-less requests. */
  readonly MCP_ANONYMOUS_RATE_LIMIT?: RemoteRateLimiter;
  /**
   * Comma-separated hostnames a browser `Origin` may name besides this
   * Worker's own host. Unset means only same-host browser requests pass.
   */
  readonly MCP_ALLOWED_ORIGINS?: string;
  /** Domain-verification token from the OpenAI apps portal. */
  readonly OPENAI_APPS_CHALLENGE_TOKEN?: string;
};

/**
 * Tool count for the server card. The card doesn't vary by `?toolset=`
 * today, so it advertises the default `full` surface: every 1:1 operation
 * tool plus every task tool (`createLucaServer` registers task tools
 * unconditionally, whatever the toolset, as server.ts shows). Derived from the
 * same registries the server itself registers tools from, so this can never
 * drift the way the old hardcoded literal did.
 */
const FULL_TOOLSET_TOOL_COUNT = LUCA_OPERATIONS.length + LUCA_TASK_TOOLS.length;

/** Hostnames from a comma-separated list, blanks dropped. */
export function parseAllowedOrigins(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((hostname) => hostname.trim())
    .filter(Str.isNonEmpty);
}

/**
 * The in-memory fallback outside production, built once per isolate because
 * the Worker makes a handler per request: a table per handler would never
 * accumulate a count.
 */
const DEV_RATE_LIMITS = createLocalRateLimits();

/**
 * The auth-path limits: the Worker's rate-limit bindings, or the in-memory
 * fallback outside production when any is missing. Production refuses to run
 * without all three.
 */
function loadRateLimits(
  env: WorkerEnv
): Effect.Effect<RateLimits, LucaConfigError> {
  const perToken = env.MCP_AUTH_RATE_LIMIT;
  const perTokenAddress = env.MCP_TOKEN_ADDRESS_RATE_LIMIT;
  const perAnonymousAddress = env.MCP_ANONYMOUS_RATE_LIMIT;

  if (
    perToken !== undefined &&
    perTokenAddress !== undefined &&
    perAnonymousAddress !== undefined
  ) {
    return Effect.succeed(
      bindingRateLimits({ perToken, perTokenAddress, perAnonymousAddress })
    );
  }

  return env.NODE_ENV === "production"
    ? Effect.fail(
        new LucaConfigError({
          message:
            "MCP_AUTH_RATE_LIMIT, MCP_TOKEN_ADDRESS_RATE_LIMIT and MCP_ANONYMOUS_RATE_LIMIT must all be bound in production",
        })
      )
    : Effect.succeed(DEV_RATE_LIMITS);
}

/** Production must use the API service binding for verification and tools. */
function loadApiFetch(
  env: WorkerEnv
): Effect.Effect<typeof fetch, LucaConfigError> {
  if (env.LUCA_API !== undefined) {
    return Effect.succeed(env.LUCA_API.fetch.bind(env.LUCA_API));
  }

  return env.NODE_ENV === "production"
    ? Effect.fail(
        new LucaConfigError({
          message: "LUCA_API service binding must be bound in production",
        })
      )
    : Effect.succeed(fetch);
}

/**
 * MCP_PUBLIC_ORIGIN as a bare origin, or undefined when unset. A value with a
 * path, a query, or a scheme other than http(s) fails the request at load:
 * it would otherwise land in every advertised URL, and clients would send
 * their tokens to an endpoint that does not exist.
 */
function loadPublicOrigin(
  env: WorkerEnv
): Effect.Effect<string | undefined, LucaConfigError> {
  const value = env.MCP_PUBLIC_ORIGIN;

  if (value === undefined) {
    return Effect.succeed(undefined);
  }

  const origin = withoutTrailingSlashes(value.trim());
  const parsed = URL.parse(origin);

  return parsed !== null &&
    (parsed.protocol === "https:" || parsed.protocol === "http:") &&
    parsed.origin === origin
    ? Effect.succeed(origin)
    : Effect.fail(
        new LucaConfigError({
          message: "MCP_PUBLIC_ORIGIN must be an http(s) origin with no path",
        })
      );
}

/**
 * A public discovery document, readable from any origin the way the SDK's
 * own metadata helper serves it: a browser-based client fetches it before it
 * has a token, and the preflight a custom header triggers must pass too.
 */
function discoveryDocument(request: Request, body: JsonValue): Response {
  const cors = { "access-control-allow-origin": "*" };

  if (request.method === "OPTIONS") {
    const requestedHeaders = request.headers.get(
      "access-control-request-headers"
    );

    const headers = new Headers({
      ...cors,
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
    });

    if (requestedHeaders !== null) {
      headers.set("access-control-allow-headers", requestedHeaders);
      headers.set("vary", "Access-Control-Request-Headers");
    }

    return new Response(null, { status: 204, headers });
  }

  return Response.json(body, {
    headers: { ...cors, "cache-control": "public, max-age=300" },
  });
}

const logJson = (payload: Record<string, string>) =>
  Console.error(toJsonPayload(payload));

type LoadedConfig = {
  readonly settings: RemoteSettings;
  readonly rateLimits: RateLimits;
  readonly publicOrigin: string | undefined;
  readonly apiFetch: typeof fetch;
};

function route(
  request: Request,
  env: WorkerEnv,
  { settings, rateLimits, publicOrigin, apiFetch }: LoadedConfig
): Effect.Effect<Response> {
  const origin = publicOrigin ?? new URL(request.url).origin;

  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(
    new URL(`${origin}/mcp`)
  );

  const apiOrigin = settings.apiBaseUrl;
  const { pathname } = new URL(request.url);

  // MCP Server Card (SEP-1649). It describes this server's capabilities,
  // transport endpoint, and version for agent discovery.
  if (pathname === "/.well-known/mcp/server-card.json") {
    return Effect.succeed(
      discoveryDocument(request, {
        // The same identity the MCP server announces over the wire, so a
        // client that reads the card and a client that connects can never
        // be told two different things about this server.
        serverInfo: LUCA_SERVER_INFO,
        endpoint: `${origin}/mcp`,
        transport: "streamable-http",
        capabilities: {
          tools: {
            enabled: true,
            count: FULL_TOOLSET_TOOL_COUNT,
          },
          resources: {
            enabled: true,
          },
          prompts: {
            enabled: true,
          },
          logging: {
            enabled: true,
          },
        },
        authentication: {
          type: "oauth2",
          issuer: `${apiOrigin}/api/auth`,
          metadataUrl: resourceMetadataUrl,
        },
        description: LUCA_SERVER_INFO.description,
      })
    );
  }

  // RFC 9728 protected-resource metadata, path-scoped for /mcp plus the
  // root fallback older clients probe. The authorization server is the
  // Better Auth mount on the Luca API (its issuer includes /api/auth).
  if (
    pathname === "/.well-known/oauth-protected-resource/mcp" ||
    pathname === "/.well-known/oauth-protected-resource"
  ) {
    return Effect.succeed(
      discoveryDocument(request, {
        resource: `${origin}/mcp`,
        authorization_servers: [`${apiOrigin}/api/auth`],
        bearer_methods_supported: ["header"],
        scopes_supported: LUCA_RESOURCE_SCOPES,
      })
    );
  }

  if (pathname === "/.well-known/openai-apps-challenge") {
    const token = env.OPENAI_APPS_CHALLENGE_TOKEN?.trim();

    return Effect.succeed(
      token
        ? new Response(token, {
            headers: { "content-type": "text/plain; charset=utf-8" },
          })
        : Response.json({ error: "not_found" }, { status: 404 })
    );
  }

  const apiKey = apiKeyResolver(settings, apiFetch);
  const oauth = oauthResolver(settings, apiFetch);

  const respond = createRemoteResponder({
    resolveToken: (token) =>
      looksLikeDeveloperKey(token) ? apiKey(token) : oauth(token),
    apiFetch,
    resourceMetadataUrl,
    toolset: resolveToolset(new URL(request.url), env),
    allowedOrigins: parseAllowedOrigins(env.MCP_ALLOWED_ORIGINS),
    // The SDK reports these through a plain callback, outside any Effect.
    onError: () => {
      // SDK errors can contain client-controlled request text. Do not log it.
      Effect.runSync(logJson({ msg: "mcp.transport_error" }));
    },
    rateLimits,
  });

  return respond(request);
}

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return Effect.runPromise(
      Effect.all(
        {
          settings: loadRemoteSettings(env),
          rateLimits: loadRateLimits(env),
          publicOrigin: loadPublicOrigin(env),
          apiFetch: loadApiFetch(env),
        },
        { concurrency: 1 }
      ).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            logJson({ msg: "mcp.config_error", error: error.message }).pipe(
              Effect.as(
                Response.json(
                  { error: "server_misconfigured" },
                  { status: 500 }
                )
              )
            ),
          onSuccess: (config) => route(request, env, config),
        })
      )
    );
  },
};
