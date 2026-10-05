import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { createFixedWindowTable } from "./fixed-window.ts";

/** A Cloudflare Rate Limit binding, or anything with the same `limit` call. */
export type RemoteRateLimiter = {
  readonly limit: (input: {
    readonly key: string;
  }) => Promise<{ readonly success: boolean }>;
};

/**
 * The auth-path budgets. A request with a bearer token is charged per token,
 * so coaches behind one shared address never spend each other's budget, and
 * also per client address with a looser limit, so rotating garbage tokens
 * cannot dodge the limiter. A request without a token is charged per address
 * only, with a higher limit because it costs no more than a 401.
 */
export type RemoteRateLimiters = {
  readonly perToken: RemoteRateLimiter;
  readonly perTokenAddress: RemoteRateLimiter;
  readonly perAnonymousAddress: RemoteRateLimiter;
};

/**
 * Charges one request to `key` and says whether it is within budget. The
 * failure channel is for a limiter that could not answer.
 */
export type RateLimit = (key: string) => Effect.Effect<boolean, unknown>;

export type RateLimits = {
  readonly perToken: RateLimit;
  readonly perTokenAddress: RateLimit;
  readonly perAnonymousAddress: RateLimit;
};

/** Per-token budget; wrangler.toml sets the same limit on MCP_AUTH_RATE_LIMIT. */
const TOKEN_RATE_LIMIT_MAX = 60;

/** Per-address budget for token-bearing requests: 10x the per-token budget. */
const TOKEN_ADDRESS_RATE_LIMIT_MAX = 600;

/** Per-address budget for requests without a token. */
const ANONYMOUS_RATE_LIMIT_MAX = 600;

/** Window for every budget; wrangler.toml sets `period = 60` on each binding. */
export const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * A fixed-window limiter held in this handler, timed by Effect's `Clock`. A
 * new key that finds the table full is refused, never admitted by evicting a
 * live window.
 */
function createLocalRateLimit(max: number): RateLimit {
  const windows = createFixedWindowTable(RATE_LIMIT_WINDOW_MS);

  return (key) =>
    Effect.map(Clock.currentTimeMillis, (now) => {
      const count = windows.charge(key, now);

      return count !== undefined && count <= max;
    });
}

const bindingRateLimit =
  (binding: RemoteRateLimiter): RateLimit =>
  (key) =>
    Effect.tryPromise(() => binding.limit({ key })).pipe(
      Effect.map((decision) => decision.success)
    );

/** In-process limits with their own tables. */
export function createLocalRateLimits(): RateLimits {
  return {
    perToken: createLocalRateLimit(TOKEN_RATE_LIMIT_MAX),
    perTokenAddress: createLocalRateLimit(TOKEN_ADDRESS_RATE_LIMIT_MAX),
    perAnonymousAddress: createLocalRateLimit(ANONYMOUS_RATE_LIMIT_MAX),
  };
}

/** Limits backed by the Worker's Cloudflare bindings. */
export function bindingRateLimits(
  rateLimiters: RemoteRateLimiters
): RateLimits {
  return {
    perToken: bindingRateLimit(rateLimiters.perToken),
    perTokenAddress: bindingRateLimit(rateLimiters.perTokenAddress),
    perAnonymousAddress: bindingRateLimit(rateLimiters.perAnonymousAddress),
  };
}
