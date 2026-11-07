import { createHash } from "node:crypto";

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Order from "effect/Order";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";

import {
  isJsonObject,
  JsonObject,
  JsonValue,
} from "../../src/serialization.ts";
import {
  INSPECTOR_EXIT,
  type InspectorConnection,
  type ListingMethod,
  type ProtocolEra,
  runInspector,
} from "./inspector.ts";

/**
 * What the server tells a client, as the MCP Inspector CLI reads it, kept in
 * `tool-surface.json`. A change to a hint, a title, a description, or a schema
 * then shows up in the pull request that makes it, and a server that lists
 * something else than its release fails the check against that file.
 *
 * Hints and text are kept whole so a reviewer can read them. Schemas are hashed:
 * the generated schema files already show what changed, and this file only has
 * to prove that the server still serves them.
 */
const ListedTool = Schema.Struct({
  name: Schema.String,
  title: Schema.String,
  description: Schema.String,
  annotations: JsonObject,
  inputSchema: JsonValue,
  outputSchema: JsonValue,
  _meta: JsonValue,
});

/** What `initialize` answers, leaving out `protocolVersion`, which varies by era. */
const SurfaceListings = Schema.Struct({
  initialize: Schema.Struct({
    serverInfo: JsonObject,
    capabilities: JsonObject,
    instructions: Schema.String,
  }),
  tools: Schema.Struct({ tools: Schema.Array(ListedTool) }),
  prompts: Schema.Struct({
    prompts: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        title: Schema.String,
        description: Schema.String,
        arguments: Schema.optionalKey(JsonValue),
      })
    ),
  }),
  resources: Schema.Struct({
    resources: Schema.Array(
      Schema.Struct({
        uri: Schema.String,
        name: Schema.String,
        title: Schema.String,
        description: Schema.String,
        mimeType: Schema.String,
      })
    ),
  }),
  resourceTemplates: Schema.Struct({
    resourceTemplates: Schema.Array(
      Schema.Struct({
        uriTemplate: Schema.String,
        name: Schema.String,
        title: Schema.String,
        description: Schema.String,
        mimeType: Schema.String,
      })
    ),
  }),
});

export type SurfaceListings = typeof SurfaceListings.Type;

const decodeListings = Schema.decodeUnknownEffect(SurfaceListings);

/** The Inspector CLI could not read one of the server's listings. */
class SurfaceReadError extends Schema.TaggedError<
  SurfaceReadError,
  { readonly brand: unique symbol }
>()("SurfaceReadError", { message: Schema.String }) {}

const DRIFT_VALUE_LIMIT = 160;

const ERAS: readonly ProtocolEra[] = ["legacy", "modern"];

function digest(value: JsonValue): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 16);
}

function keyedBy<T>(
  items: readonly T[],
  key: (item: T) => string
): Readonly<Record<string, T>> {
  return R.fromEntries(
    Arr.sort(
      items.map((item) => [key(item), item] as const),
      Order.mapInput(Order.String, ([name]: readonly [string, T]) => name)
    )
  );
}

/** The contents of `tool-surface.json` for one set of listings. */
export function surfaceOf(listings: SurfaceListings) {
  return {
    server: listings.initialize,
    tools: R.map(
      keyedBy(listings.tools.tools, (tool) => tool.name),
      (tool) => ({
        title: tool.title,
        description: tool.description,
        annotations: tool.annotations,
        inputSchema: digest(tool.inputSchema),
        outputSchema: digest(tool.outputSchema),
        meta: digest(tool._meta),
      })
    ),
    prompts: keyedBy(listings.prompts.prompts, (prompt) => prompt.name),
    resources: keyedBy(
      listings.resources.resources,
      (resource) => resource.uri
    ),
    resourceTemplates: keyedBy(
      listings.resourceTemplates.resourceTemplates,
      (template) => template.uriTemplate
    ),
  };
}

function leaves(
  value: JsonValue,
  path: string
): readonly (readonly [string, string])[] {
  // An empty object is a value too: `capabilities.completions: {}` is how a
  // server says it supports completions.
  return isJsonObject(value) && !R.isEmptyRecord(value)
    ? R.toEntries(value).flatMap(([key, child]) =>
        leaves(child, path === "" ? key : `${path} > ${key}`)
      )
    : [[path, JSON.stringify(value)]];
}

function shown(value: string | undefined): string {
  if (value === undefined) {
    return "none";
  }

  return value.length > DRIFT_VALUE_LIMIT
    ? `${value.slice(0, DRIFT_VALUE_LIMIT)}...`
    : value;
}

/** One line per value that differs. Empty means the two surfaces match. */
export function surfaceDrift(
  expected: JsonValue,
  actual: JsonValue
): readonly string[] {
  const want = new Map(leaves(expected, ""));
  const have = new Map(leaves(actual, ""));

  return Arr.dedupe([...want.keys(), ...have.keys()])
    .toSorted()
    .flatMap((path) =>
      want.get(path) === have.get(path)
        ? []
        : [
            `${path}: expected ${shown(want.get(path))}, server has ${shown(have.get(path))}`,
          ]
    );
}

function listing(
  connection: InspectorConnection,
  method: ListingMethod,
  era: ProtocolEra
) {
  return Effect.gen(function* () {
    const outcome = yield* Effect.tryPromise({
      try: () => runInspector(connection, { method }, era),
      catch: (cause) => new SurfaceReadError({ message: String(cause) }),
    });

    if (outcome.exitCode !== INSPECTOR_EXIT.ok) {
      return yield* new SurfaceReadError({
        message: `${method} (${era}) exited ${outcome.exitCode}: ${outcome.text}`,
      });
    }

    return isJsonObject(outcome.output) ? outcome.output.result : undefined;
  });
}

/**
 * Reads every listing at once. One pass over both eras costs about 34 requests,
 * inside the 60 a minute the hosted server allows a token.
 */
export function readSurface(connection: InspectorConnection, era: ProtocolEra) {
  return Effect.all(
    {
      initialize: listing(connection, "initialize", era),
      tools: listing(connection, "tools/list", era),
      prompts: listing(connection, "prompts/list", era),
      resources: listing(connection, "resources/list", era),
      resourceTemplates: listing(connection, "resources/templates/list", era),
    },
    { concurrency: "unbounded" }
  ).pipe(Effect.flatMap(decodeListings), Effect.map(surfaceOf));
}

/** Every line where either protocol era's answer differs from `expected`. */
export function driftAcrossEras(
  connection: InspectorConnection,
  expected: JsonValue
) {
  return Effect.forEach(
    ERAS,
    (era) =>
      Effect.map(readSurface(connection, era), (actual) =>
        surfaceDrift(expected, actual).map((line) => `[${era}] ${line}`)
      ),
    { concurrency: "unbounded" }
  ).pipe(Effect.map(Arr.flatten));
}
