import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { LucaConfigError } from "./errors.ts";
import { optionalField } from "./optional-field.ts";

export type AuthHeader = "x-api-key" | "authorization";

const TRAILING_SLASHES = /\/+$/;

/** How long one HTTP attempt may run before it is cancelled and retried. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export type LucaConfig = {
  readonly apiBaseUrl: string;
  /** Redacted so a logged or inspected config never prints the key. */
  readonly apiKey: Redacted.Redacted<string>;
  readonly authHeader: AuthHeader;
  readonly workspaceId?: string;
  readonly workspaceSlug?: string;
  readonly requestTimeoutMs?: number;
};

export const LucaConfig = Context.Service<LucaConfig>("@luca/mcp/LucaConfig");

function nonEmpty(value: string | undefined) {
  // An all-whitespace variable is the same as an unset one, so it collapses to
  // undefined and lets every caller's `??` fallback take over.
  return value?.trim() || undefined;
}

/** A variable's trimmed value, undefined when it is unset or blank. */
function optionalVar(name: string) {
  return Config.option(Config.String(name)).pipe(
    Config.map((value) => nonEmpty(Option.getOrUndefined(value)))
  );
}

function trimmedSecret(secret: Redacted.Redacted<string>) {
  return Option.map(
    Option.fromNullishOr(nonEmpty(Redacted.value(secret))),
    (value) => Redacted.make(value)
  );
}

/** A secret variable, trimmed and still redacted; None when unset or blank. */
function optionalSecret(name: string) {
  return Config.option(Config.Redacted(name)).pipe(
    Config.map(Option.flatMap(trimmedSecret))
  );
}

/** The URL with any trailing slashes removed, so paths can be appended to it. */
export function withoutTrailingSlashes(url: string) {
  return url.replace(TRAILING_SLASHES, "");
}

function normalizeBaseUrl(value: string | undefined) {
  return withoutTrailingSlashes(value ?? "https://api.setluca.com");
}

/**
 * Every spelling of LUCA_AUTH_HEADER we accept, mapped to the header the client
 * actually sends. "bearer" is here because it is what people write when they
 * mean the Authorization header, and refusing it would be a papercut.
 */

const AUTH_HEADER_ALIASES = HashMap.fromIterable<string, AuthHeader>([
  ["x-api-key", "x-api-key"],
  ["authorization", "authorization"],
  ["bearer", "authorization"],
]);

const decodeTimeoutMs = Schema.decodeUnknownOption(
  Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0))
);

/**
 * The per-attempt timeout a variable asks for, absent when it is unset or is
 * not a positive whole number of milliseconds. Absent means the caller's
 * default applies, so a typo degrades to the default rather than to no timeout
 * at all.
 */
function parseTimeoutMs(value: string | undefined): number | undefined {
  return Option.getOrUndefined(decodeTimeoutMs(value));
}

function parseAuthHeader(value: string | undefined) {
  const alias = value?.toLowerCase() ?? "x-api-key";

  return Effect.fromNullishOr(
    Option.getOrUndefined(HashMap.get(AUTH_HEADER_ALIASES, alias))
  ).pipe(
    Effect.mapError(
      () =>
        new LucaConfigError({
          message: "LUCA_AUTH_HEADER must be x-api-key or authorization",
        })
    )
  );
}

/** LUCA_API_KEY, or the older LUCA_API_TOKEN when it is unset. */
const ApiKeyConfig = Config.all([
  optionalSecret("LUCA_API_KEY"),
  optionalSecret("LUCA_API_TOKEN"),
]).pipe(Config.map(([apiKey, legacy]) => Option.orElse(apiKey, () => legacy)));

const RemoteSettingsConfig = Config.all({
  apiBaseUrl: optionalVar("LUCA_API_BASE_URL"),
  authHeader: optionalVar("LUCA_AUTH_HEADER"),
  requestTimeoutMs: optionalVar("LUCA_REQUEST_TIMEOUT_MS"),
});

const WorkspaceConfig = Config.all({
  workspaceId: optionalVar("LUCA_WORKSPACE_ID"),
  workspaceSlug: optionalVar("LUCA_WORKSPACE_SLUG"),
});

/** Reads `config` from `env`, failing as {@link LucaConfigError}. */
function readFrom<A>(
  config: Config.Config<A>,
  env: Record<string, string | undefined>
) {
  return config
    .parse(ConfigProvider.fromEnvRecord(env))
    .pipe(
      Effect.mapError(
        (error) => new LucaConfigError({ message: error.message })
      )
    );
}

function requireApiKey(env: Record<string, string | undefined>) {
  return readFrom(ApiKeyConfig, env).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new LucaConfigError({
              message: "Set LUCA_API_KEY to a Luca developer API key.",
            })
          ),
        onSome: Effect.succeed,
      })
    )
  );
}

/** The API settings that are the same whichever coach is calling. */
export type RemoteSettings = Pick<
  LucaConfig,
  "apiBaseUrl" | "authHeader" | "requestTimeoutMs"
>;

/** The variables {@link loadRemoteSettings} reads. */
export type RemoteSettingsEnv = {
  readonly LUCA_API_BASE_URL?: string | undefined;
  readonly LUCA_AUTH_HEADER?: string | undefined;
  readonly LUCA_REQUEST_TIMEOUT_MS?: string | undefined;
};

/**
 * Read the API settings that don't depend on the API key. The Worker reads
 * them once and gives them to every token it resolves, so a remote call
 * reaches the API exactly as a stdio call would. An unknown LUCA_AUTH_HEADER
 * fails with {@link LucaConfigError}.
 */
export function loadRemoteSettings(
  env: RemoteSettingsEnv
): Effect.Effect<RemoteSettings, LucaConfigError> {
  return readFrom(RemoteSettingsConfig, env).pipe(
    Effect.flatMap((vars) =>
      parseAuthHeader(vars.authHeader).pipe(
        Effect.map((authHeader) => ({
          apiBaseUrl: normalizeBaseUrl(vars.apiBaseUrl),
          authHeader,
          ...optionalField(
            "requestTimeoutMs",
            parseTimeoutMs(vars.requestTimeoutMs)
          ),
        }))
      )
    )
  );
}

/**
 * Read the stdio server's configuration from the environment. A missing API
 * key or an unknown LUCA_AUTH_HEADER fails with {@link LucaConfigError}; every
 * other variable falls back to its default when unset or malformed.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env
): Effect.Effect<LucaConfig, LucaConfigError> {
  return Effect.all(
    {
      apiKey: requireApiKey(env),
      settings: loadRemoteSettings(env),
      workspace: readFrom(WorkspaceConfig, env),
    },
    { concurrency: 1 }
  ).pipe(
    Effect.map(({ apiKey, settings, workspace }) => ({
      ...settings,
      apiKey,
      ...optionalField("workspaceId", workspace.workspaceId),
      ...optionalField("workspaceSlug", workspace.workspaceSlug),
    }))
  );
}

/** The stdio server's configuration, read from `process.env` when built. */
export const LucaConfigLive = Layer.effect(
  LucaConfig,
  Effect.suspend(() => loadConfig())
);
