import * as Arr from "effect/Array";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";

import {
  type JsonSchema,
  type OpenApiInputSpec,
  schemaFromOpenApi,
  type ToolFields,
} from "../../src/openapi-schema.ts";
import { optionalFields } from "../../src/optional-field.ts";

/**
 * Path parameters become top-level arguments, so a tool reads
 * `{ id, body }` rather than `{ path: { id }, body }`.
 */
function pathFields(path: JsonSchema | undefined): ToolFields {
  const required = path?.required ?? [];

  return R.map(path?.properties ?? {}, (property, key) => {
    const schema = schemaFromOpenApi(property);

    return Arr.contains(required, key) ? schema : Schema.optionalKey(schema);
  });
}

/**
 * The route-specific input fields of an operation tool: the path parameters,
 * then the route's query and body under `query` and `body`.
 *
 * `scripts/generate-openapi-inputs.ts` runs this once per route and writes the
 * result out as Effect Schema source, so the server never converts an input
 * schema at runtime.
 */
export function openApiInputFields(spec: OpenApiInputSpec): ToolFields {
  return {
    ...pathFields(spec.path),
    ...optionalFields(spec.query, (query) => ({
      query: Schema.optionalKey(schemaFromOpenApi(query)),
    })),
    ...optionalFields(spec.body, (body) => ({
      body: schemaFromOpenApi(body),
    })),
  };
}

/**
 * Every name a page cursor goes by in the manifest: `cursor` almost everywhere,
 * and `before` on the conversation-messages route. This is an allowlist of two
 * names, not inference. A schema cannot say which of a route's string query
 * fields is a cursor without a naming convention, and there are two.
 */
const CURSOR_QUERY_PARAMS = ["cursor", "before"] as const;

/**
 * The query field a route takes its page cursor in, absent when it takes none.
 *
 * Runs when `openapi-inputs.ts` is generated, so the server reads a finished
 * route-to-field map instead of shipping every query schema.
 */
export function cursorQueryParamOf(
  query: JsonSchema | undefined
): string | undefined {
  return CURSOR_QUERY_PARAMS.find(
    (name) => query?.properties?.[name] !== undefined
  );
}
