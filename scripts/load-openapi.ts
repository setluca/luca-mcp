import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { JsonValue, parseJson } from "../src/serialization.ts";

const OPENAPI_URL = "https://api.setluca.com/openapi.json";

/** A checked-in Luca API contract, resolved from this script's directory. */
function apiFile(name: string) {
  return Effect.map(Path.Path, (path) =>
    path.resolve(import.meta.dirname, "../contracts", name)
  );
}

type LoadedOpenApi = {
  readonly spec: JsonValue;
  readonly source: string;
};

const fetchLiveOpenApi = Effect.gen(function* () {
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
  const response = yield* client.get(OPENAPI_URL);

  const spec = yield* HttpClientResponse.schemaBodyJson(JsonValue)(response);

  return { spec, source: OPENAPI_URL };
}).pipe(Effect.provide(FetchHttpClient.layer));

/**
 * Loads the Luca OpenAPI document. Defaults to the sibling
 * `contracts/openapi.json` snapshot so codegen and drift checks are
 * offline and branch-atomic. Pass `--live` to fetch the deployed
 * document instead.
 */
export function loadOpenApi(argv: readonly string[] = process.argv) {
  if (Arr.contains(argv, "--live")) {
    return fetchLiveOpenApi;
  }

  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const source = yield* apiFile("openapi.json");
    const spec = yield* parseJson(yield* fs.readFileString(source));

    return { spec, source } satisfies LoadedOpenApi;
  });
}

export type ApiKeyPolicyEntry = {
  /** Stable operation id, the key the MCP route catalog is built on. */
  readonly id: string;
  readonly method: string;
  /** The route's OpenAPI path template, `/api/bookings/{id}/outcome`. */
  readonly path: string;
  readonly scopes: readonly string[];
  readonly requireIdempotency?: boolean | undefined;
};

type LoadedApiKeyPolicies = {
  readonly policies: readonly ApiKeyPolicyEntry[];
  readonly source: string;
};

const decodeApiKeyPolicies = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        method: Schema.String,
        path: Schema.String,
        scopes: Schema.Array(Schema.String),
        requireIdempotency: Schema.optionalKey(Schema.Boolean),
      })
    )
  )
);

/**
 * Loads the serialized API-key authorization allowlist emitted by
 * Luca's `apps/api/scripts/api-key-policies.ts`. Local-only: no deployed endpoint
 * publishes the raw allowlist, and reading it from the checked-in snapshot keeps
 * the reachability check offline and branch-atomic.
 */
export const loadApiKeyPolicies = Effect.fn("loadApiKeyPolicies")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const source = yield* apiFile("api-key-policies.json");

  const policies = yield* decodeApiKeyPolicies(
    yield* fs.readFileString(source)
  );

  return { policies, source } satisfies LoadedApiKeyPolicies;
});
