import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";

import {
  isJsonObject,
  JsonObject,
  type JsonValue,
} from "../../src/serialization.ts";
import { resolveOpenApiReferences } from "./openapi-refs.ts";

/** A request or response body. Only the JSON media type matters to MCP. */
const OpenApiBody = Schema.Struct({
  content: Schema.optional(
    Schema.Struct({
      "application/json": Schema.optional(
        Schema.Struct({ schema: Schema.optional(JsonObject) })
      ),
    })
  ),
});

const OpenApiParameter = Schema.Struct({
  name: Schema.String,
  in: Schema.String,
  required: Schema.optional(Schema.Boolean),
  schema: Schema.optional(JsonObject),
});

export type OpenApiParameter = typeof OpenApiParameter.Type;

/** The parts of one OpenAPI operation the scripts read, with references inlined. */
const OpenApiOperation = Schema.Struct({
  parameters: Schema.optional(Schema.Array(OpenApiParameter)),
  requestBody: Schema.optional(OpenApiBody),
  responses: Schema.optional(Schema.Record(Schema.String, OpenApiBody)),
});

export type OpenApiOperation = typeof OpenApiOperation.Type;

const decodeOperation = Schema.decodeUnknownSync(OpenApiOperation);

/**
 * The OpenAPI operation behind a route, with every local `$ref` inlined, or
 * nothing when the document has no such route. A route that is present but
 * malformed throws, because a script reading it would report nonsense.
 */
export function findOpenApiOperation(
  spec: JsonValue,
  route: { readonly method: string; readonly path: string }
): Option.Option<OpenApiOperation> {
  const paths = isJsonObject(spec) ? spec.paths : undefined;
  const pathItem = isJsonObject(paths) ? paths[route.path] : undefined;

  const operation = isJsonObject(pathItem)
    ? pathItem[route.method.toLowerCase()]
    : undefined;

  return isJsonObject(operation)
    ? Option.some(decodeOperation(resolveOpenApiReferences(operation, spec)))
    : Option.none();
}

/** The JSON Schema of a body, or `undefined` when it has no JSON content. */
export function jsonBody(
  body: typeof OpenApiBody.Type | undefined
): JsonObject | undefined {
  return body?.content?.["application/json"]?.schema;
}

/**
 * The JSON Schema of the response an MCP tool call returns: the lowest 2xx
 * that has a JSON body. Status codes are integer-like keys, which JavaScript
 * iterates in ascending order. `undefined` means the route answers with no
 * body, such as a 204.
 */
export function successBody(
  operation: OpenApiOperation
): JsonObject | undefined {
  return Option.getOrUndefined(
    Arr.findFirst(
      R.toEntries(operation.responses ?? {}),
      ([status, response]) =>
        status.startsWith("2")
          ? Option.fromUndefinedOr(jsonBody(response))
          : Option.none()
    )
  );
}
