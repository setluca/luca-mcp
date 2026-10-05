/**
 * The one place this package turns values into JSON text and back.
 *
 * Every JSON boundary the server has is a wire boundary it does not control:
 * MCP content blocks are specified as text, an HTTP request body is a string,
 * and a rejection Response carries a JSON body. Keeping the `JSON.*` calls and
 * the JSON schemas here means the rest of the package works in values, and a
 * change to how Luca serializes has exactly one place to happen.
 */

import * as Arr from "effect/Array";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";

export type JsonValueInput =
  | boolean
  | null
  | number
  | string
  | undefined
  | readonly JsonValueInput[]
  | JsonInputObject;

export type JsonInputObject = {
  readonly [key: string]: JsonValueInput;
};

export type QueryScalar = boolean | number | string | null | undefined;

export type QueryValue = JsonValueInput;

export type QueryParameters = Readonly<Record<string, QueryValue>>;

/** Any JSON value. */
export const JsonValue = Schema.Json;

export type JsonValue = typeof JsonValue.Type;

/** Any JSON value keyed by string. */
export const JsonObject = Schema.JsonObject;

export type JsonObject = typeof JsonObject.Type;

/**
 * Whether a JSON value is an object rather than an array or a scalar. The
 * value is JSON already, so one shallow check is enough: validating the whole
 * subtree again on every call would make a recursive walk quadratic.
 */
export function isJsonObject(
  value: JsonValue | undefined
): value is JsonObject {
  return P.isObject(value);
}

/** Recognize a JSON array while retaining the type of its elements. */
export function isJsonArray(
  value: JsonValue | undefined
): value is Schema.JsonArray {
  return Arr.isArray(value);
}

const decodeJsonText = Schema.decodeUnknownEffect(
  Schema.fromJsonString(JsonValue)
);

/**
 * Parses JSON text into a JSON value. Malformed text fails with a
 * `SchemaError` rather than throwing.
 */
export function parseJson(text: string) {
  return decodeJsonText(text);
}

/** Pretty JSON for a human- or agent-readable text block. */
export function toJsonText(value: JsonValueInput): string {
  // oxlint-disable-next-line effect/avoid-direct-json -- this file is the package's one JSON boundary. The input may hold `undefined` fields, which `JSON.stringify` drops and a `Schema.Json` encoder would reject.
  return JSON.stringify(value, null, 2) ?? "null";
}

/** Compact JSON for a wire payload: a request body, a response body, a log line. */
export function toJsonPayload(value: JsonValueInput): string {
  // oxlint-disable-next-line effect/avoid-direct-json -- this file is the package's one JSON boundary. The input may hold `undefined` fields, which `JSON.stringify` drops and a `Schema.Json` encoder would reject.
  return JSON.stringify(value) ?? "null";
}
