import * as Arr from "effect/Array";
import * as HashSet from "effect/HashSet";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";

import {
  isJsonObject,
  toJsonPayload,
  type JsonObject,
  type JsonValue,
} from "../../src/serialization.ts";

/**
 * The OpenAPI document holds a reference that cannot be inlined: malformed,
 * missing, cyclic, or carrying a sibling key the generator would drop.
 */
class OpenApiReferenceError extends Schema.TaggedError<OpenApiReferenceError>()(
  "OpenApiReferenceError",
  { message: Schema.String }
) {}

function referenceError(message: string) {
  return new OpenApiReferenceError({ message });
}

const isLocalReference = Schema.is(
  Schema.String.check(Schema.isStartingWith("#/"))
);

const schemaMapKeys = HashSet.make(
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas"
);

const literalKeys = HashSet.make(
  "const",
  "enum",
  "default",
  "example",
  "examples"
);

function referenceTarget(document: JsonValue, reference: string): JsonObject {
  const target = Arr.reduce(
    reference.slice(2).split("/"),
    // SAFETY: widening to include `undefined`, the value a missing key yields.
    document as JsonValue | undefined,
    (current, part) => {
      if (/~(?:[^01]|$)/.test(part)) {
        throw referenceError(`Invalid OpenAPI reference: ${reference}`);
      }

      const key = part.replace(/~1/g, "/").replace(/~0/g, "~");

      return isJsonObject(current) && Object.hasOwn(current, key)
        ? current[key]
        : undefined;
    }
  );

  if (!isJsonObject(target)) {
    throw referenceError(`Missing or invalid OpenAPI reference: ${reference}`);
  }

  return target;
}

/** Inline local references at generation time; runtime schemas contain no references. */
export function resolveOpenApiReferences(
  value: JsonValue,
  document: JsonValue,
  ancestors: HashSet.HashSet<string> = HashSet.empty()
): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) =>
      resolveOpenApiReferences(item, document, ancestors)
    );
  }

  if (!isJsonObject(value)) {
    return value;
  }

  if (Object.hasOwn(value, "$ref")) {
    const reference = value.$ref;

    if (!isLocalReference(reference)) {
      throw referenceError(
        `Invalid OpenAPI reference: ${toJsonPayload(reference)}`
      );
    }

    if (HashSet.has(ancestors, reference)) {
      throw referenceError(`Cyclic OpenAPI reference: ${reference}`);
    }

    const target = referenceTarget(document, reference);
    const { $ref: _reference, ...siblings } = value;

    Arr.forEach(R.keys(siblings), (key) => {
      if (
        key !== "description" &&
        key !== "summary" &&
        key !== "x-luca-sensitive"
      ) {
        throw referenceError(
          `Unsupported OpenAPI reference sibling ${key}: ${reference}`
        );
      }
    });

    return resolveOpenApiReferences(
      { ...target, ...siblings },
      document,
      HashSet.add(ancestors, reference)
    );
  }

  return R.fromEntries(
    R.toEntries(value).map(([key, child]) => {
      if (HashSet.has(literalKeys, key)) {
        return [key, child] as const;
      }

      if (HashSet.has(schemaMapKeys, key) && isJsonObject(child)) {
        return [
          key,
          R.fromEntries(
            R.toEntries(child).map(
              ([name, schema]) =>
                [
                  name,
                  resolveOpenApiReferences(schema, document, ancestors),
                ] as const
            )
          ),
        ] as const;
      }

      return [
        key,
        resolveOpenApiReferences(child, document, ancestors),
      ] as const;
    })
  );
}
