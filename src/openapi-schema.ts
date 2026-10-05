import * as Arr from "effect/Array";
import * as EffectJsonSchema from "effect/JsonSchema";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";

import { ISO_DATE_TIME_PATTERN, UUID_PATTERN } from "./fields.ts";
import { optionalField, optionalFields } from "./optional-field.ts";
import type { JsonValue } from "./serialization.ts";

/**
 * One tool argument or result field. It decodes without services, which is
 * what the SDK's synchronous validation needs.
 */
export type ToolField = Schema.Top & {
  readonly DecodingServices: never;
  readonly EncodingServices: never;
  readonly Rebuild: ToolField;
};

/**
 * The fields of a tool's input or output object, keyed by argument name. An
 * optional argument is wrapped in `Schema.optionalKey`.
 */
export type ToolFields = Readonly<Record<string, ToolField>>;

/**
 * The subset of OpenAPI 3.1 JSON Schema the generated manifests use. The
 * generators write it from the API's OpenAPI document, so the shape is what
 * `apps/api` serves rather than anything this package chooses.
 */
export type JsonSchema = {
  readonly type?: string | readonly string[];
  readonly enum?: readonly JsonValue[];
  readonly const?: JsonValue;
  readonly format?: string;
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly properties?: Record<string, JsonSchema>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly additionalProperties?: boolean | JsonSchema;
  readonly anyOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
  readonly description?: string;
  readonly default?: JsonValue;
  /**
   * The marker `sensitive()` in `@luca/schemas` writes into the API's OpenAPI
   * document, carried through the generated output schemas. Nothing here reads
   * it. `scripts/generate-openapi-outputs.ts` reads it off the snapshot to list
   * each route's redacted fields. The type still has to admit it, or a generated
   * schema that names a lead-derived field stops type-checking.
   */
  readonly "x-luca-sensitive"?: string;
};

export type OpenApiInputSpec = {
  readonly path?: JsonSchema;
  readonly query?: JsonSchema;
  readonly body?: JsonSchema;
};

/**
 * Patterns for the string formats a tool argument is checked against. Effect
 * keeps `format` as an annotation and does not validate it, so each format the
 * server enforces is restated as a pattern. These are the three formats the
 * server checked before the move to Effect Schema; `date` and `email` stay
 * advisory and the API validates them.
 */
const FORMAT_PATTERNS = {
  uuid: UUID_PATTERN.source,
  "date-time": ISO_DATE_TIME_PATTERN.source,
  uri: "^[A-Za-z][A-Za-z0-9+.-]*:[^\\s]+$",
};

/** Whether a `format` is one {@link FORMAT_PATTERNS} enforces. */
const isEnforcedFormat = Schema.is(Schema.Literals(R.keys(FORMAT_PATTERNS)));

type Node = EffectJsonSchema.JsonSchema;

/** The value under one keyword of a {@link Node}, not yet checked. */
type Keyword = Node[string];

const isJsonLiteral = (
  value: Keyword
): value is string | number | boolean | null =>
  P.isString(value) ||
  P.isNumber(value) ||
  P.isBoolean(value) ||
  P.isNull(value);

/**
 * The shapes the API's OpenAPI 3.1 document does not use and this importer
 * does not translate, each named so a schema that starts using one fails the
 * generator with the keyword to handle rather than importing as something
 * looser than it says.
 */
const UNSUPPORTED_KEYWORDS: ReadonlyArray<
  readonly [keyword: string, appears: (node: Node) => boolean]
> = [
  ["allOf", (node) => node.allOf !== undefined],
  ["nullable (OpenAPI 3.0)", (node) => node.nullable !== undefined],
  [
    "a boolean exclusive bound (OpenAPI 3.0)",
    (node) =>
      P.isBoolean(node.exclusiveMinimum) || P.isBoolean(node.exclusiveMaximum),
  ],
  [
    "an object or array enum or const value",
    (node) => {
      const values = node.enum;
      const constant = node.const;

      return (
        (Arr.isArray(values) && !Arr.every(values, isJsonLiteral)) ||
        (constant !== undefined && !isJsonLiteral(constant))
      );
    },
  ],
  [
    "properties without type: object",
    (node) => P.isObject(node.properties) && node.type === undefined,
  ],
  [
    "an additionalProperties schema beside declared properties",
    (node) => {
      const extra = node.additionalProperties;

      return (
        P.isObject(node.properties) &&
        P.isObject(extra) &&
        !R.isEmptyRecord(extra)
      );
    },
  ],
];

function unsupportedKeywords(node: Node): readonly string[] {
  return Arr.flatMap(UNSUPPORTED_KEYWORDS, ([keyword, appears]) =>
    appears(node) ? [keyword] : []
  );
}

/**
 * The extra-key rule for an object node. A declared object without the key is
 * closed, `true` and a nested schema stay as they are, and any other value is
 * malformed and closes the object rather than opening it.
 */
function closeObject(node: Node): Node {
  const extra = node.additionalProperties;

  if (P.isBoolean(extra) || P.isObject(extra)) {
    return node;
  }

  return extra === undefined && !P.isObject(node.properties)
    ? node
    : { ...node, additionalProperties: false };
}

function formatPattern(node: Node): Node {
  const format = node.format;

  if (!isEnforcedFormat(format) || node.pattern !== undefined) {
    return node;
  }

  return { ...node, pattern: FORMAT_PATTERNS[format] };
}

/**
 * Rewrites one JSON Schema node before Effect translates it, so the imported
 * schema checks what this server has always checked:
 *
 * - `oneOf` is read as `anyOf`. Every `oneOf` in the manifest is a tagged
 *   union, so the two agree on real input, and `anyOf` cannot reject a value
 *   for matching two variants.
 * - An object that declares properties and says nothing about others is
 *   closed, and so is one with a malformed `additionalProperties`.
 * - The enforced formats gain the pattern from {@link FORMAT_PATTERNS}.
 *
 * A node using a shape {@link unsupportedKeywords} names throws instead.
 * Every step leaves its own output alone, so running it twice on a node is the
 * same as running it once.
 */
function tightenNode(node: Node): Node {
  const unsupported = unsupportedKeywords(node);

  if (Arr.isReadonlyArrayNonEmpty(unsupported)) {
    // oxlint-disable-next-line effect/avoid-untagged-errors -- a schema the importer cannot translate is a build-time programming error, not a runtime failure
    throw new Error(
      `Unsupported OpenAPI schema shape: ${unsupported.join(", ")}. Teach src/openapi-schema.ts to translate it.`
    );
  }

  const { oneOf, ...rest } = node;

  return formatPattern(
    closeObject(oneOf === undefined ? rest : { ...rest, anyOf: oneOf })
  );
}

function importNode(node: Node): ToolField {
  // SAFETY: a schema translated from JSON Schema is built from plain
  // structural schemas and checks, none of which require a service.
  return SchemaRepresentation.fromJsonSchemaDocument(
    EffectJsonSchema.fromSchemaOpenApi3_1(node),
    { patterns: "apply", onEnter: tightenNode }
  ) as ToolField;
}

/**
 * The Effect Schema for one OpenAPI JSON Schema node. Patterns in the document
 * are applied, and {@link tightenNode} runs on every node first.
 *
 * Tool inputs go through this when `src/generated/openapi-inputs.ts` is
 * generated, not at runtime, so a change here needs `bun run openapi:generate`.
 * `openapi:inputs:check` fails until it runs.
 */
export function schemaFromOpenApi(schema: JsonSchema): ToolField {
  return importNode(tightenNode(schema));
}

/** The node's type, with `object` assumed for a node that declares properties. */
function relaxedType(schema: JsonSchema): Pick<JsonSchema, "type"> {
  const declared =
    schema.type ?? (schema.properties === undefined ? undefined : "object");

  return declared === undefined ? {} : { type: declared };
}

/**
 * Relax a response JSON schema to a **structural, type-only** schema for output
 * validation. The goal is a check that fails loud on a genuinely malformed
 * payload (a field typed as the wrong primitive, `result` that is not an object
 * at all) while never rejecting a well-formed real result.
 *
 * So it keeps each field's base `type` but drops value-level
 * constraints, meaning `format`, `pattern`, length and range bounds, `enum`,
 * and array-item schemas, and makes every object open with no required
 * properties. Those constraints are the false-positive risk: they would fail a
 * real tool call on a non-v4 uuid, an enum that drifted, or an omitted optional
 * field, and they also break the pagination merge (which drops `nextCursor`
 * and adds a `pagination` block).
 */
function relaxJsonSchema(schema: JsonSchema): JsonSchema {
  return {
    ...relaxedType(schema),
    ...optionalFields(schema.properties, (properties) => ({
      properties: R.map(properties, relaxJsonSchema),
      required: [],
      additionalProperties: true,
    })),
    ...optionalField("anyOf", schema.anyOf?.map(relaxJsonSchema)),
    ...optionalField("oneOf", schema.oneOf?.map(relaxJsonSchema)),
  };
}

const UntrustedProvenance = Schema.Struct({
  untrusted: Schema.Literal(true),
  note: Schema.String,
});

/**
 * The `structuredContent` fields for a tool: `{ result }`, plus an optional
 * `provenance` marker for operations that carry lead-authored text. `result` is
 * the operation's success-response body, relaxed by {@link relaxJsonSchema} so
 * real results validate while malformed ones fail loud.
 */
export function openApiToolOutputFields(input: {
  readonly body: JsonSchema | null | undefined;
  readonly untrustedContent: boolean;
}): ToolFields {
  const result = input.body
    ? schemaFromOpenApi(relaxJsonSchema(input.body))
    : Schema.Unknown;

  return input.untrustedContent
    ? { result, provenance: Schema.optionalKey(UntrustedProvenance) }
    : { result };
}
