import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";

import type { ToolField, ToolFields } from "./openapi-schema.ts";
import { fieldsWhen } from "./optional-field.ts";
import {
  isJsonObject,
  isJsonArray,
  type JsonObject,
  type JsonValue,
} from "./serialization.ts";

/**
 * Annotation keys that reach the JSON Schema a client reads. Effect drops
 * annotations it does not know unless they are named here.
 */
function isLucaAnnotation(key: string) {
  return key.startsWith("x-luca-");
}

/** One JSON Schema object node, as Effect writes it. */
type JsonSchemaNode = JsonObject;

/** An `allOf` entry that only opens its object to other keys. */
type OpenObjectEntry = {
  readonly type: "object";
  readonly additionalProperties: JsonValue;
};

/**
 * Whether an `allOf` entry only says "this object takes other keys too". Effect
 * writes an open object that also lists properties as the object plus such an
 * entry; the key on the object says the same thing with less nesting.
 */
function isOpenObjectEntry(
  entry: JsonValue | undefined
): entry is OpenObjectEntry {
  return (
    isJsonObject(entry) &&
    entry.type === "object" &&
    "additionalProperties" in entry &&
    Arr.every(
      R.keys<string, JsonValue>(entry),
      (key) => key === "type" || key === "additionalProperties"
    )
  );
}

/**
 * Folds an open-object `allOf` entry back into its object. Every other node
 * comes back unchanged.
 */
function foldOpenObject(node: JsonSchemaNode) {
  const allOf = node.allOf;

  if (
    !isJsonArray(allOf) ||
    allOf.length !== 1 ||
    !isOpenObjectEntry(allOf[0]) ||
    "additionalProperties" in node
  ) {
    return node;
  }

  const { allOf: _folded, ...rest } = node;
  const extra = allOf[0].additionalProperties;

  return {
    ...rest,
    additionalProperties:
      isJsonObject(extra) && R.isEmptyRecord(extra) ? true : extra,
  };
}

/**
 * An `allOf` entry's keywords, flattened through any `allOf` of its own, or
 * `undefined` when it repeats a keyword and so has to stay a separate entry.
 */
function flatKeywords(entry: JsonValue): JsonSchemaNode | undefined {
  if (!isJsonObject(entry)) {
    return undefined;
  }

  const { allOf, ...own } = entry;

  if (allOf === undefined) {
    return own;
  }

  if (!isJsonArray(allOf)) {
    return undefined;
  }

  return Arr.reduce(allOf, own, (merged: JsonSchemaNode | undefined, child) => {
    const keywords = flatKeywords(child);

    return merged === undefined ||
      keywords === undefined ||
      Arr.some(R.keys(keywords), (key) => key in merged)
      ? undefined
      : { ...merged, ...keywords };
  });
}

/**
 * Lifts `allOf` entries onto their node when no keyword collides. Effect
 * writes each check, and a check group such as `isLengthBetween`, as its own
 * entry; `{ minLength: 3, maxLength: 3, description }` says what three nested
 * `allOf` levels say, in one level.
 */
function flattenAllOf(node: JsonSchemaNode): JsonSchemaNode {
  const { allOf, ...rest } = node;

  if (!isJsonArray(allOf)) {
    return node;
  }

  const keywords = flatKeywords({ allOf });

  return keywords === undefined ||
    Arr.some(R.keys(keywords), (key) => key in rest)
    ? node
    : { ...rest, ...keywords };
}

/**
 * States the safe-integer range Effect's `isInt` already enforces, on whichever
 * side the schema leaves open, so a client sees the same bounds the server
 * checks.
 */
function safeIntegerBounds(node: JsonSchemaNode) {
  if (node.type !== "integer") {
    return node;
  }

  return {
    ...node,
    ...fieldsWhen(!("minimum" in node || "exclusiveMinimum" in node), {
      minimum: Number.MIN_SAFE_INTEGER,
    }),
    ...fieldsWhen(!("maximum" in node || "exclusiveMaximum" in node), {
      maximum: Number.MAX_SAFE_INTEGER,
    }),
  };
}

/** Applies the node rewrites above through the whole tree. */
function tidy(value: JsonValue): JsonValue {
  if (isJsonArray(value)) {
    return value.map(tidy);
  }

  if (!isJsonObject(value)) {
    return value;
  }

  return safeIntegerBounds(flattenAllOf(foldOpenObject(R.map(value, tidy))));
}

/** The annotations {@link restoreAnnotations} puts back. */
const RESTORED_ANNOTATIONS = ["title", "description", "format"] as const;

/**
 * Puts back each property's title, description, and format where Effect
 * dropped them. Effect reads annotations off the schema's last check, and a
 * check with no JSON Schema form, such as the time-zone check on
 * `IanaTimeZone`, takes them down with it. Walks struct properties only, which
 * is where these annotations sit.
 */
function restoreAnnotations(ast: SchemaAST.AST, value: JsonValue): JsonValue {
  const properties = isJsonObject(value) ? value.properties : undefined;

  if (
    !isJsonObject(value) ||
    !isJsonObject(properties) ||
    !SchemaAST.isObjects(ast)
  ) {
    return value;
  }

  return R.set<string, JsonValue, string, JsonValue>(
    value,
    "properties",
    R.map(properties, (property, key) => {
      const signature = Arr.findFirst(
        ast.propertySignatures,
        (candidate) => candidate.name === key
      );

      if (Option.isNone(signature)) {
        return property;
      }

      const restored = restoreAnnotations(signature.value.type, property);
      const annotations = SchemaAST.resolve(signature.value.type) ?? {};

      if (!isJsonObject(restored)) {
        return restored;
      }

      return Arr.reduce(RESTORED_ANNOTATIONS, restored, (node, key) => {
        const annotation = annotations[key];

        return P.isString(annotation) && !(key in node)
          ? R.set<string, JsonValue, string, string>(node, key, annotation)
          : node;
      });
    })
  );
}

/**
 * The JSON Schema a client reads for `schema`. An object closes to the keys it
 * declares, since the decoder drops the rest before a handler sees them.
 */
function jsonSchemaOf(schema: Schema.Top) {
  const document = Schema.toJsonSchemaDocument(schema, {
    includeAnnotationKey: isLucaAnnotation,
    onExcessProperty: "error",
  });

  const root = {
    ...document.schema,
    ...fieldsWhen(!R.isEmptyRecord(document.definitions), {
      $defs: document.definitions,
    }),
  };

  // SAFETY: Effect builds the document from JSON values only, though its type
  // leaves keyword values open. Both passes map an object node to an object
  // node.
  return restoreAnnotations(
    schema.ast,
    tidy(root as JsonValue)
  ) as JsonSchemaNode;
}

/**
 * Runs `build` on the first call and returns that result from then on. The
 * catalog defines hundreds of schemas at import, and a client lists the tools
 * it needs, so each JSON Schema is built when the SDK first asks for it.
 */
function lazily<A>(build: () => A): () => A {
  let built: { readonly value: A } | undefined;

  return () => {
    built ??= { value: build() };

    return built.value;
  };
}

/**
 * The shape a schema reaches the MCP SDK in: Effect validates the arguments,
 * and the JSON Schema clients see is generated from the same Effect schema,
 * with Luca's `x-luca-*` markers kept.
 *
 * `Schema.toStandardJSONSchemaV1` would do the same, but it takes no options
 * and drops the markers, so the JSON half is built here instead.
 */
export function toStandardSchema<S extends ToolField>(
  schema: S,
  parseOptions?: SchemaAST.ParseOptions
): StandardSchemaWithJSON<S["Encoded"], S["Type"]> & {
  readonly schema: S;
} {
  const standard = Schema.toStandardSchemaV1(schema, { parseOptions })[
    "~standard"
  ];

  return {
    schema,
    "~standard": {
      ...standard,
      jsonSchema: {
        input: lazily(() => jsonSchemaOf(schema)),
        output: lazily(() => jsonSchemaOf(Schema.toType(schema))),
      },
    },
  };
}

/** A tool's result object as a {@link toStandardSchema}. */
export function toolSchema<const Fields extends ToolFields>(fields: Fields) {
  return toStandardSchema(Schema.Struct(fields));
}

/**
 * A tool's argument object as a {@link toStandardSchema}. A key the schema does
 * not declare, at any depth, fails the call with an issue naming it: the JSON
 * Schema a client reads already closes every object, and dropping a misspelt
 * field in silence would run the call without it.
 */
export function toolInputSchema<const Fields extends ToolFields>(
  fields: Fields
) {
  return toStandardSchema(Schema.Struct(fields), { onExcessProperty: "error" });
}
