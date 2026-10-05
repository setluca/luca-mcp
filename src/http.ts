import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
// oxlint-disable effect/avoid-native-fetch -- MCP remote API transport; its tests assert the native fetch request shape
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { DEFAULT_REQUEST_TIMEOUT_MS, LucaConfig } from "./config.ts";
import {
  LucaDecodeError,
  type LucaError,
  LucaHttpError,
  LucaNetworkError,
  LucaToolInputError,
} from "./errors.ts";
import type { LucaOperation } from "./operations.ts";
import { optionalField } from "./optional-field.ts";
import { resilient } from "./resilience.ts";
import { parseJson, toJsonPayload } from "./serialization.ts";
import type {
  JsonValue,
  JsonValueInput,
  QueryParameters,
  QueryScalar,
} from "./serialization.ts";
import { LUCA_MCP_USER_AGENT } from "./version.ts";

export type WorkspaceOverride = {
  readonly workspaceId?: string;
  readonly workspaceSlug?: string;
};

export type LucaRequest = {
  readonly operation: LucaOperation;
  readonly pathParams?: Record<string, string>;
  readonly query?: QueryParameters;
  readonly body?: JsonValueInput;
  readonly idempotencyKey?: string;
  readonly workspace?: WorkspaceOverride;
};

export interface LucaApi {
  readonly request: (
    input: LucaRequest
  ) => Effect.Effect<JsonValue, LucaError, never>;
}

export const LucaApi = Context.Service<LucaApi>("@luca/mcp/LucaApi");

function isPresent(value: QueryScalar): value is string | number | boolean {
  return value !== undefined && value !== null && value !== "";
}

const PATH_PARAM = /\{([^}]+)\}/g;

/**
 * The operation path with each `{param}` filled in and encoded. An absent or
 * empty param fails rather than collapsing the route onto a different
 * endpoint, such as the collection URL in place of one record.
 */
function encodePath(
  path: string,
  params: Record<string, string> | undefined
): Effect.Effect<string, LucaToolInputError> {
  const valueOf = (key: string) =>
    Option.fromNullishOr(params?.[key]).pipe(Option.filter(Str.isNonEmpty));

  const missing = Arr.findFirst(
    Arr.map(Arr.fromIterable(path.matchAll(PATH_PARAM)), ([, key = ""]) => key),
    (key) => Option.isNone(valueOf(key))
  );

  if (Option.isSome(missing)) {
    return Effect.fail(
      new LucaToolInputError({
        message: `Missing path parameter: ${missing.value}`,
      })
    );
  }

  return Effect.succeed(
    path.replaceAll(PATH_PARAM, (_, key: string) =>
      encodeURIComponent(Option.getOrElse(valueOf(key), () => ""))
    )
  );
}

function appendQuery(url: URL, query: QueryParameters | undefined) {
  // oxlint-disable-next-line effect/imperative-loops -- loop mutates surrounding state per item in a way a combinator cannot express without changing timing
  for (const [key, value] of R.toEntries(query ?? {})) {
    // A scalar is a one-element list here, so array and single-value params take
    // the same path: append every value the caller actually set.
    const values = Array.isArray(value) ? value : [value];

    Arr.forEach(values.filter(isPresent), (item) => {
      url.searchParams.append(key, String(item));
    });
  }
}

function buildUrl(config: LucaConfig, input: LucaRequest) {
  return encodePath(input.operation.path, input.pathParams).pipe(
    Effect.map((path) => {
      const url = new URL(path, `${config.apiBaseUrl}/`);
      appendQuery(url, input.query);

      return url;
    })
  );
}

/** The API key, under whichever header this config authenticates with. */
function authFields(config: LucaConfig): Record<string, string> {
  return Match.value(config.authHeader).pipe(
    Match.when("authorization", () => ({
      authorization: `Bearer ${Redacted.value(config.apiKey)}`,
    })),
    Match.orElse(() => ({ "x-api-key": Redacted.value(config.apiKey) }))
  );
}

const RETRY_AFTER_MS_PER_SECOND = 1000;

/** Delta-seconds: a whole, non-negative number of seconds. */
const decodeRetryAfterSeconds = Schema.decodeUnknownOption(
  Schema.NumberFromString.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0)
  )
);

const HTTP_DATE_START = /^[a-z]/i;

/**
 * The wait a `Retry-After` header asks for, in milliseconds. The header comes
 * in two forms, delta-seconds and an HTTP date, and both are read here so the
 * retry rules never have to look at a header again. An unreadable value is the
 * same as no header: the client falls back to its own backoff.
 */
function retryAfterMs(response: Response, now: number): number | undefined {
  // `Headers` has already trimmed the value, so a header of nothing but spaces
  // arrives as the empty string and is treated as no header at all.
  const header = response.headers.get("retry-after");

  if (!header) {
    return;
  }

  const seconds = decodeRetryAfterSeconds(header);

  if (Option.isSome(seconds)) {
    return seconds.value * RETRY_AFTER_MS_PER_SECOND;
  }

  // Every HTTP date form opens with a day name. Without this check `Date.parse`
  // would read a malformed delta such as "1.5" or "-1" as a calendar date.
  if (!HTTP_DATE_START.test(header)) {
    return;
  }

  // oxlint-disable-next-line effect/use-clock-service -- parse stored timestamp
  const at = Date.parse(header);

  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** The JSON payload of a request; absent for a GET or a bodiless call. */
function requestBody(input: LucaRequest): Option.Option<string> {
  return Option.liftPredicate(
    input,
    (candidate) =>
      candidate.operation.method !== "GET" && candidate.body !== undefined
  ).pipe(Option.map((candidate) => toJsonPayload(candidate.body)));
}

function buildRequestInit(
  config: LucaConfig,
  input: LucaRequest,
  requestIdempotencyKey: string | undefined
): RequestInit {
  // The body decides its own content-type header, so both are read from the one
  // value rather than from two independent recomputations of "does this have a
  // body" that could drift apart.
  const body = requestBody(input);

  const headers = new Headers({
    accept: "application/json",
    "user-agent": LUCA_MCP_USER_AGENT,
    ...authFields(config),
    ...optionalField(
      "x-luca-workspace-id",
      input.workspace?.workspaceId ?? config.workspaceId
    ),
    ...optionalField(
      "x-luca-workspace-slug",
      input.workspace?.workspaceSlug ?? config.workspaceSlug
    ),
    ...optionalField(
      "content-type",
      Option.getOrUndefined(Option.map(body, () => "application/json"))
    ),
    ...optionalField("idempotency-key", requestIdempotencyKey),
  });

  return {
    method: input.operation.method,
    headers,
    ...optionalField("body", Option.getOrUndefined(body)),
  };
}

/**
 * The most of a non-JSON error body a tool error carries. A gateway's HTML page
 * says no more past this, and the whole page would crowd the agent's context.
 */
const MAX_RAW_ERROR_BODY_LENGTH = 500;

/**
 * The body of an error response: its JSON when it parses, else the raw text
 * cut to {@link MAX_RAW_ERROR_BODY_LENGTH} characters. An empty body is null,
 * as it is on success.
 */
function errorBody(text: string) {
  return Option.liftPredicate(text, (raw) => Str.isNonEmpty(raw)).pipe(
    Option.match({
      onNone: () => Effect.succeed<JsonValue>(null),
      onSome: (raw) =>
        parseJson(raw).pipe(
          Effect.orElseSucceed((): JsonValue =>
            raw.slice(0, MAX_RAW_ERROR_BODY_LENGTH)
          )
        ),
    })
  );
}

/**
 * The URL a network error names: origin and path only. The query string can
 * carry a search term such as a lead's name, which a tool error must not echo.
 */
const describeUrl = (url: URL) => `${url.origin}${url.pathname}`;

/** One trip to the API, with no retry and no timeout of its own. */
function sendOnce(
  config: LucaConfig,
  input: LucaRequest,
  requestIdempotencyKey: string | undefined
) {
  return Effect.gen(function* () {
    const url = yield* buildUrl(config, input);
    const init = buildRequestInit(config, input, requestIdempotencyKey);

    const response = yield* Effect.tryPromise({
      try: (signal) =>
        // fallow-ignore-next-line security-sink -- the origin is the configured Luca api base url and the path comes from the generated operation manifest with its params encoded, so a tool argument can never move the destination host
        fetch(url, {
          ...init,
          // A redirect would carry the API key to a host we never named.
          redirect: "error",
          signal,
        }),
      catch: (cause) =>
        new LucaNetworkError({
          message: `Could not reach Luca API at ${describeUrl(url)}`,
          cause,
        }),
    });

    const readText = Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) =>
        new LucaNetworkError({
          message: "Could not read Luca API response body",
          cause,
        }),
    });

    if (!response.ok) {
      // The status and `Retry-After` are read before the body is. A gateway
      // answers 502, 503 and 504 with HTML and a rate limiter may answer 429
      // with plain text; neither is a decode failure, and both must reach the
      // retry rules with their status and wait intact. A body that cannot be
      // read is treated as empty for the same reason.
      const now = yield* Clock.currentTimeMillis;
      const waitMs = retryAfterMs(response, now);
      const text = yield* readText.pipe(Effect.orElseSucceed(() => ""));

      return yield* Effect.fail(
        new LucaHttpError({
          status: response.status,
          statusText: response.statusText,
          body: yield* errorBody(text),
          ...optionalField("requestId", response.headers.get("x-request-id")),
          ...optionalField("retryAfterMs", waitMs),
        })
      );
    }

    const text = yield* readText;

    // An empty body is not a decode failure. Several endpoints answer with
    // no content at all, and null is the JSON value that stands for it.
    return yield* Option.liftPredicate(text, (raw) => Str.isNonEmpty(raw)).pipe(
      Option.match({
        onNone: () => Effect.succeed(null),
        onSome: (raw) =>
          parseJson(raw).pipe(
            Effect.mapError(
              () =>
                new LucaDecodeError({
                  message: "Luca API returned non-JSON content",
                  body: raw,
                })
            )
          ),
      })
    );
  });
}

export function createLucaApi(config: LucaConfig): LucaApi {
  const timeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return {
    // The key each attempt carries is minted by `resilient`, which also decides
    // whether a failure may be replayed under it.
    request: (input) =>
      resilient(input, timeoutMs, (key) => sendOnce(config, input, key)),
  };
}

export const LucaApiLive = Layer.effect(
  LucaApi,
  Effect.gen(function* () {
    const config = yield* LucaConfig;

    return createLucaApi(config);
  })
);
