import { isScopeRefusal, type LucaError, LucaHttpError } from "./errors.ts";
import type { LucaCapabilityScope } from "./scopes.ts";

/**
 * The `_meta` key a tool error uses to ask the client to re-authorize. ChatGPT
 * reads it to show its account-linking UI when a call fails for lack of a
 * valid token or a broad enough scope. The value is a list of RFC 6750
 * `WWW-Authenticate` challenges, the same header a 401 from the transport
 * carries.
 */
const WWW_AUTHENTICATE_META_KEY = "mcp/www_authenticate";

/** The RFC 6750 error codes Luca puts in a `Bearer` challenge. */
export type OAuthError = "invalid_token" | "insufficient_scope";

/**
 * The OAuth error a failed tool call maps to, or `undefined` when the failure
 * has nothing to do with authorization. A 401 means the token is no longer
 * accepted. A 403 counts only when the API says a scope is missing.
 */
function oauthErrorFor(error: LucaError): OAuthError | undefined {
  if (error instanceof LucaHttpError && error.status === 401) {
    return "invalid_token";
  }

  return isScopeRefusal(error) ? "insufficient_scope" : undefined;
}

const ERROR_DESCRIPTIONS: Readonly<Record<OAuthError, string>> = {
  invalid_token: "The access token is invalid or expired",
  insufficient_scope: "The connection's scopes do not cover this tool",
};

/**
 * An RFC 6750 `Bearer` challenge, for the transport's `WWW-Authenticate`
 * header and for a tool error's `_meta`. Both name the same realm, so a client
 * sees one protected resource however the challenge reached it. A request that
 * sent no token gets no `error`; one whose token was refused gets
 * `invalid_token`, which tells the client to refresh or re-authorize rather
 * than rediscover the server.
 */
export function bearerChallenge(params: {
  readonly scope?: string | undefined;
  readonly resourceMetadataUrl?: string | undefined;
  readonly error?: OAuthError | undefined;
}): string {
  const { error, resourceMetadataUrl, scope } = params;

  const fields = [
    'realm="luca-mcp"',
    resourceMetadataUrl === undefined
      ? undefined
      : `resource_metadata="${resourceMetadataUrl}"`,
    error === undefined ? undefined : `error="${error}"`,
    error === undefined
      ? undefined
      : `error_description="${ERROR_DESCRIPTIONS[error]}"`,
    scope === undefined ? undefined : `scope="${scope}"`,
  ];

  return `Bearer ${fields.filter((field) => field !== undefined).join(", ")}`;
}

/**
 * The `_meta` for a tool error that re-authorizing could fix, or `undefined`
 * for every other failure. An `insufficient_scope` challenge names the scope
 * the tool needs, so the client can ask for it when the coach reconnects. An
 * `invalid_token` challenge names none: the client must refresh or
 * re-authorize, not ask for a different scope, the same rule the transport's
 * 401 follows.
 *
 * It needs the resource-metadata URL, which only the remote Worker knows. A
 * stdio server has no OAuth flow to send the client into, so it passes none
 * and its errors carry no challenge.
 */
export function authChallengeMeta(
  error: LucaError,
  scope: LucaCapabilityScope,
  resourceMetadataUrl: string | undefined
): Record<string, readonly string[]> | undefined {
  const oauthError = oauthErrorFor(error);

  if (oauthError === undefined || resourceMetadataUrl === undefined) {
    return undefined;
  }

  return {
    [WWW_AUTHENTICATE_META_KEY]: [
      bearerChallenge({
        resourceMetadataUrl,
        error: oauthError,
        scope: oauthError === "insufficient_scope" ? scope : undefined,
      }),
    ],
  };
}
