import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import { assert, describe, expect, it } from "vitest";

import { openApiInputFields } from "../scripts/lib/openapi-input-fields.ts";
import { OPENAPI_INPUT_SPECS } from "../src/generated/openapi-input-specs.ts";
import { OPENAPI_INPUT_FIELDS } from "../src/generated/openapi-inputs.ts";
import {
  type JsonSchema,
  type OpenApiInputSpec,
  openApiToolOutputFields,
  type ToolField,
  type ToolFields,
} from "../src/openapi-schema.ts";

function schema(spec: OpenApiInputSpec) {
  return Schema.Struct(openApiInputFields(spec));
}

/** The AST of the `body` field a spec produces. */
function bodyAst(spec: OpenApiInputSpec): SchemaAST.AST {
  const body: ToolField | undefined = openApiInputFields(spec).body;

  assert(body !== undefined, "spec produced no body field");

  return body.ast;
}

function outputSchema(
  body: JsonSchema | null | undefined,
  untrustedContent = false
) {
  return Schema.Struct(openApiToolOutputFields({ body, untrustedContent }));
}

function decoded(schema: Schema.Struct<ToolFields>, value: unknown) {
  return Schema.decodeUnknownOption(schema)(value);
}

function accepts(schema: Schema.Struct<ToolFields>, value: unknown) {
  return Option.isSome(decoded(schema, value));
}

describe("openApiInputFields", () => {
  it("maps enum, const, and required object fields", () => {
    const input = schema({
      body: {
        type: "object",
        required: ["channel", "kind"],
        properties: {
          channel: { type: "string", enum: ["telegram", "whatsapp"] },
          kind: { const: "lead" },
          displayName: { type: "string" },
        },
      },
    });

    expect(
      accepts(input, {
        body: { channel: "telegram", kind: "lead" },
      })
    ).toBe(true);
    expect(
      accepts(input, {
        body: { channel: "email", kind: "lead" },
      })
    ).toBe(false);
    expect(accepts(input, { body: { channel: "telegram" } })).toBe(false);
  });

  it("maps string formats and constraints", () => {
    const input = schema({
      body: {
        type: "object",
        required: ["id", "url", "at", "code"],
        properties: {
          id: { type: "string", format: "uuid" },
          url: { type: "string", format: "uri" },
          at: { type: "string", format: "date-time" },
          code: {
            type: "string",
            pattern: "^lead_[0-9]+$",
            minLength: 6,
            maxLength: 12,
          },
        },
      },
    });

    expect(
      accepts(input, {
        body: {
          id: "00000000-0000-4000-8000-000000000000",
          url: "https://api.setluca.com/docs",
          at: "2026-07-01T12:00:00Z",
          code: "lead_123",
        },
      })
    ).toBe(true);
    expect(
      accepts(input, {
        body: {
          id: "not-a-uuid",
          url: "not-a-url",
          at: "not-a-date",
          code: "bad",
        },
      })
    ).toBe(false);
  });

  it("maps numeric bounds and arrays", () => {
    const input = schema({
      body: {
        type: "object",
        required: ["score", "weights"],
        properties: {
          score: {
            type: "integer",
            minimum: 0,
            exclusiveMaximum: 100,
          },
          weights: {
            type: "array",
            minItems: 1,
            maxItems: 2,
            items: { type: "number", exclusiveMinimum: 0 },
          },
        },
      },
    });

    expect(accepts(input, { body: { score: 99, weights: [0.1, 2] } })).toBe(
      true
    );
    expect(accepts(input, { body: { score: 100, weights: [1] } })).toBe(false);
    expect(accepts(input, { body: { score: 1, weights: [0] } })).toBe(false);
  });

  it("maps the 3.1 numeric spelling of an exclusive bound", () => {
    // Luca's OpenAPI document is 3.1, which writes an exclusive bound as a
    // number in a field of its own rather than as a boolean flag beside
    // `minimum`. Reading only the boolean form dropped every one of them —
    // `reminderOffsetsMinutes` and its siblings accepted 0 and -5 here and
    // were refused by the API instead.
    const input = schema({
      body: {
        type: "object",
        required: ["offsets", "ratio"],
        properties: {
          offsets: {
            type: "array",
            items: { type: "integer", exclusiveMinimum: 0 },
          },
          ratio: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
        },
      },
    });

    expect(accepts(input, { body: { offsets: [1, 30], ratio: 0.5 } })).toBe(
      true
    );
    // The bound itself is out, which is what makes it exclusive.
    expect(accepts(input, { body: { offsets: [0], ratio: 0.5 } })).toBe(false);
    expect(accepts(input, { body: { offsets: [-5], ratio: 0.5 } })).toBe(false);
    expect(accepts(input, { body: { offsets: [1], ratio: 0 } })).toBe(false);
    expect(accepts(input, { body: { offsets: [1], ratio: 1 } })).toBe(false);
  });

  it("keeps an inclusive bound inclusive when an exclusive one sits beside it", () => {
    // A 3.1 document may carry both: `minimum` is the inclusive bound and
    // `exclusiveMinimum` a separate, stricter one. The stricter of the two is
    // the one that has to survive.
    const input = schema({
      body: {
        type: "object",
        required: ["a", "b"],
        properties: {
          a: { type: "integer", minimum: 5 },
          b: { type: "integer", minimum: 0, exclusiveMinimum: 2 },
        },
      },
    });

    expect(accepts(input, { body: { a: 5, b: 3 } })).toBe(true);
    expect(accepts(input, { body: { a: 4, b: 3 } })).toBe(false);
    expect(accepts(input, { body: { a: 5, b: 2 } })).toBe(false);
  });

  it("maps nullable fields and mixed-type unions", () => {
    const input = schema({
      body: {
        type: "object",
        required: ["externalId", "value"],
        properties: {
          externalId: { type: ["string", "null"] },
          value: { type: ["string", "number"] },
        },
      },
    });

    expect(accepts(input, { body: { externalId: null, value: "x" } })).toBe(
      true
    );
    expect(accepts(input, { body: { externalId: "id", value: 1 } })).toBe(true);
    expect(accepts(input, { body: { externalId: "id", value: false } })).toBe(
      false
    );
  });

  it("maps anyOf and oneOf", () => {
    const input = schema({
      body: {
        type: "object",
        required: ["id", "payload"],
        properties: {
          id: { type: "string" },
          payload: {
            anyOf: [{ type: "string" }, { type: "number" }],
          },
          mode: {
            oneOf: [{ const: "dry-run" }, { const: "live" }],
          },
        },
      },
    });

    expect(
      accepts(input, { body: { id: "sync", payload: 1, mode: "dry-run" } })
    ).toBe(true);
    expect(accepts(input, { body: { id: "sync", payload: false } })).toBe(
      false
    );
    expect(accepts(input, { body: { payload: "missing-id" } })).toBe(false);
  });

  it("maps an additionalProperties schema on a map-shaped object", () => {
    const input = schema({
      body: { type: "object", additionalProperties: { type: "number" } },
    });

    expect(accepts(input, { body: { score: 1 } })).toBe(true);
    expect(accepts(input, { body: { score: "high" } })).toBe(false);
  });

  it("rejects null when a field is not marked nullable", () => {
    const input = schema({ body: { type: "string" } });

    expect(accepts(input, { body: null })).toBe(false);
  });

  it.each([
    ["allOf", { allOf: [{ type: "string" }] }],
    ["nullable", { type: "string", nullable: true }],
    ["boolean exclusive bound", { type: "integer", exclusiveMinimum: true }],
    ["object or array enum", { enum: [{ a: 1 }] }],
    ["properties without type", { properties: { a: { type: "string" } } }],
    [
      "additionalProperties schema",
      {
        type: "object",
        properties: { a: { type: "string" } },
        additionalProperties: { type: "number" },
      },
    ],
  ])("refuses a shape it does not translate: %s", (keyword, body) => {
    // Luca's document uses none of these. Translating them by guesswork once
    // widened inputs silently, so a new one has to fail the build instead.
    expect(() =>
      // oxlint-disable-next-line effect/avoid-any -- the test feeds shapes the JsonSchema type rules out on purpose
      openApiInputFields({ body: body as unknown as JsonSchema })
    ).toThrow(new RegExp(keyword.split(" ")[0] ?? keyword));
  });

  it("filters null out of a type array while keeping the other types and nullability", () => {
    const input = schema({ body: { type: ["string", "number", "null"] } });

    expect(accepts(input, { body: null })).toBe(true);
    expect(accepts(input, { body: "x" })).toBe(true);
    expect(accepts(input, { body: 1 })).toBe(true);
    expect(accepts(input, { body: true })).toBe(false);
  });

  it("rejects everything for an empty enum with a never-type schema", () => {
    const input = schema({
      body: { type: "object", properties: { flag: { enum: [] } } },
    });

    expect(accepts(input, { body: {} })).toBe(true);
    expect(accepts(input, { body: { flag: "anything" } })).toBe(false);
    expect(accepts(input, { body: { flag: null } })).toBe(false);
  });

  it("accepts anything for a type the mapper does not know", () => {
    const input = schema({
      body: { type: "not-a-json-schema-type", description: "odd" },
    });

    expect(accepts(input, { body: 1 })).toBe(true);
    expect(accepts(input, { body: { nested: true } })).toBe(true);
  });

  it("unions every member of a three-type array, not just the first two", () => {
    const input = schema({
      body: { type: ["string", "integer", "boolean"] },
    });

    expect(accepts(input, { body: "a" })).toBe(true);
    expect(accepts(input, { body: 1 })).toBe(true);
    expect(accepts(input, { body: true })).toBe(true);
    expect(accepts(input, { body: { nested: true } })).toBe(false);
  });

  it("uses a union of string literals for an all-string enum", () => {
    const input = schema({ body: { enum: ["telegram", "whatsapp"] } });

    const ast = bodyAst({ body: { enum: ["telegram", "whatsapp"] } });

    expect(SchemaAST.isUnion(ast) && ast.types.every(SchemaAST.isLiteral)).toBe(
      true
    );
    expect(accepts(input, { body: "telegram" })).toBe(true);
    expect(accepts(input, { body: "email" })).toBe(false);
  });

  it("uses a literal union for a mixed-type enum", () => {
    const input = schema({ body: { enum: ["a", 2] } });

    expect(SchemaAST.isUnion(bodyAst({ body: { enum: ["a", 2] } }))).toBe(true);
    expect(accepts(input, { body: "a" })).toBe(true);
    expect(accepts(input, { body: 2 })).toBe(true);
    expect(accepts(input, { body: 3 })).toBe(false);
  });

  it("uses a literal union for an all-number enum", () => {
    const input = schema({ body: { enum: [1, 2] } });

    expect(SchemaAST.isUnion(bodyAst({ body: { enum: [1, 2] } }))).toBe(true);
    expect(accepts(input, { body: 1 })).toBe(true);
    expect(accepts(input, { body: 2 })).toBe(true);
    expect(accepts(input, { body: 3 })).toBe(false);
  });

  it("uses a single literal for a one-value non-string enum", () => {
    const input = schema({ body: { enum: [42] } });

    expect(SchemaAST.isLiteral(bodyAst({ body: { enum: [42] } }))).toBe(true);
    expect(accepts(input, { body: 42 })).toBe(true);
    expect(accepts(input, { body: 43 })).toBe(false);
  });

  it("enforces the uuid format in isolation", () => {
    const input = schema({
      body: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", format: "uuid" } },
      },
    });

    expect(
      accepts(input, { body: { id: "00000000-0000-4000-8000-000000000000" } })
    ).toBe(true);
    expect(accepts(input, { body: { id: "not-a-uuid" } })).toBe(false);
  });

  it("enforces the uri format in isolation", () => {
    const input = schema({
      body: {
        type: "object",
        required: ["url"],
        properties: { url: { type: "string", format: "uri" } },
      },
    });

    expect(
      accepts(input, { body: { url: "https://api.setluca.com/docs" } })
    ).toBe(true);
    expect(accepts(input, { body: { url: "not-a-url" } })).toBe(false);
  });

  it("enforces the date-time format with an offset in isolation", () => {
    const input = schema({
      body: {
        type: "object",
        required: ["at"],
        properties: { at: { type: "string", format: "date-time" } },
      },
    });

    expect(accepts(input, { body: { at: "2026-07-01T12:00:00+02:00" } })).toBe(
      true
    );
    expect(accepts(input, { body: { at: "not-a-date" } })).toBe(false);
  });

  it.each([
    "2026-02-31T12:00:00Z",
    "2026-04-31T12:00:00Z",
    "2026-02-29T12:00:00Z",
    "1900-02-29T12:00:00Z",
    "2026-13-01T12:00:00Z",
    "2026-07-01T24:00:00Z",
    "2026-07-01T12:60:00Z",
    "2026-07-01T12:00:00+24:00",
  ])("rejects %s, which names no real moment", (at) => {
    // `Date` rolls 31 February over to 3 March, so a format check that
    // parses instead of matching the calendar would let these through.
    const input = schema({
      body: {
        type: "object",
        required: ["at"],
        properties: { at: { type: "string", format: "date-time" } },
      },
    });

    expect(accepts(input, { body: { at } })).toBe(false);
  });

  it.each([
    "2024-02-29T12:00:00Z",
    "2000-02-29T12:00:00Z",
    "2026-12-31T23:59:59.999-05:30",
  ])("accepts %s, which does exist", (at) => {
    const input = schema({
      body: {
        type: "object",
        required: ["at"],
        properties: { at: { type: "string", format: "date-time" } },
      },
    });

    expect(accepts(input, { body: { at } })).toBe(true);
  });

  it("enforces string length boundaries in isolation", () => {
    const input = schema({
      body: {
        type: "object",
        required: ["code"],
        properties: { code: { type: "string", minLength: 3, maxLength: 5 } },
      },
    });

    expect(accepts(input, { body: { code: "ab" } })).toBe(false);
    expect(accepts(input, { body: { code: "abc" } })).toBe(true);
    expect(accepts(input, { body: { code: "abcde" } })).toBe(true);
    expect(accepts(input, { body: { code: "abcdef" } })).toBe(false);
  });

  it("enforces a string pattern in isolation", () => {
    const input = schema({
      body: {
        type: "object",
        required: ["code"],
        properties: { code: { type: "string", pattern: "^lead_[0-9]+$" } },
      },
    });

    expect(accepts(input, { body: { code: "lead_123" } })).toBe(true);
    expect(accepts(input, { body: { code: "nope" } })).toBe(false);
  });

  it("enforces array minItems and maxItems as distinct bounds", () => {
    const minInput = schema({
      body: {
        type: "object",
        required: ["tags"],
        properties: {
          tags: { type: "array", items: { type: "string" }, minItems: 1 },
        },
      },
    });

    expect(accepts(minInput, { body: { tags: [] } })).toBe(false);
    expect(accepts(minInput, { body: { tags: ["a"] } })).toBe(true);

    const maxInput = schema({
      body: {
        type: "object",
        required: ["tags"],
        properties: {
          tags: { type: "array", items: { type: "string" }, maxItems: 2 },
        },
      },
    });

    expect(accepts(maxInput, { body: { tags: ["a"] } })).toBe(true);
    expect(accepts(maxInput, { body: { tags: ["a", "b", "c"] } })).toBe(false);
  });

  it("treats integer type as an integer-only constraint", () => {
    const input = schema({
      body: {
        type: "object",
        required: ["count"],
        properties: { count: { type: "integer" } },
      },
    });

    expect(accepts(input, { body: { count: 3 } })).toBe(true);
    expect(accepts(input, { body: { count: 3.5 } })).toBe(false);
  });

  it("maps boolean type strictly", () => {
    const input = schema({
      body: {
        type: "object",
        required: ["active"],
        properties: { active: { type: "boolean" } },
      },
    });

    expect(accepts(input, { body: { active: true } })).toBe(true);
    expect(accepts(input, { body: { active: "true" } })).toBe(false);
  });

  it("treats properties as optional by default when required is omitted", () => {
    const input = schema({
      body: {
        type: "object",
        properties: { "Stryker was here": { type: "string" } },
      },
    });

    expect(accepts(input, { body: {} })).toBe(true);
  });

  it("preserves additional properties when additionalProperties is true", () => {
    const input = schema({
      body: {
        type: "object",
        properties: { name: { type: "string" } },
        additionalProperties: true,
      },
    });

    expect(decoded(input, { body: { name: "x", extra: 1 } })).toEqual(
      Option.some({ body: { name: "x", extra: 1 } })
    );
  });

  it("does not treat a non-object additionalProperties value as a nested schema", () => {
    const input = schema({
      body: {
        type: "object",
        properties: { name: { type: "string" } },
        // @ts-expect-error Exercises malformed generated OpenAPI input.
        additionalProperties: "unexpected",
      },
    });

    expect(decoded(input, { body: { name: "x", extra: 1 } })).toEqual(
      Option.some({ body: { name: "x" } })
    );
  });

  it("enforces const literal values in isolation", () => {
    const input = schema({
      body: {
        type: "object",
        required: ["kind"],
        properties: { kind: { const: "lead" } },
      },
    });

    expect(accepts(input, { body: { kind: "lead" } })).toBe(true);
    expect(accepts(input, { body: { kind: "customer" } })).toBe(false);
  });

  it("treats a single anyOf variant as that variant", () => {
    // Effect keeps a one-member union rather than collapsing it, so this checks
    // what the field admits instead of the node it builds.
    const input = schema({ body: { anyOf: [{ type: "string" }] } });

    expect(accepts(input, { body: "x" })).toBe(true);
    expect(accepts(input, { body: 5 })).toBe(false);
  });

  it("falls back to an unknown scalar type for a malformed type-array entry", () => {
    const input = schema({
      body: {
        // @ts-expect-error Exercises a malformed generated type array.
        type: [undefined],
      },
    });

    expect(accepts(input, { body: "anything" })).toBe(true);
    expect(accepts(input, { body: 42 })).toBe(true);
  });
});

describe("openApiToolOutputFields", () => {
  it("relaxes anyOf variants recursively and drops their format constraints", () => {
    const output = outputSchema({
      anyOf: [{ type: "string", format: "uuid" }, { type: "integer" }],
    });

    expect(accepts(output, { result: "not-a-uuid" })).toBe(true);
    expect(accepts(output, { result: 7 })).toBe(true);
    expect(accepts(output, { result: true })).toBe(false);
  });

  it("relaxes oneOf variants recursively", () => {
    const output = outputSchema({
      oneOf: [{ type: "string", format: "uuid" }, { type: "integer" }],
    });

    expect(accepts(output, { result: "not-a-uuid" })).toBe(true);
    expect(accepts(output, { result: 7 })).toBe(true);
    expect(accepts(output, { result: true })).toBe(false);
  });

  it("requires the untrusted provenance fields when untrustedContent is true", () => {
    const output = outputSchema({ type: "string" }, true);

    expect(
      accepts(output, {
        result: "x",
        provenance: { untrusted: true, note: "n" },
      })
    ).toBe(true);
    expect(
      accepts(output, {
        result: "x",
        provenance: { untrusted: false, note: "n" },
      })
    ).toBe(false);
    expect(accepts(output, { result: "x", provenance: {} })).toBe(false);
  });

  it("does not validate a provenance field when untrustedContent is false", () => {
    const output = outputSchema({ type: "string" }, false);

    expect(
      accepts(output, { result: "x", provenance: { untrusted: false } })
    ).toBe(true);
  });

  it("validates the result field against the relaxed body schema", () => {
    const output = outputSchema({ type: "integer" });

    expect(accepts(output, { result: 5 })).toBe(true);
    expect(accepts(output, { result: "not-a-number" })).toBe(false);
  });

  it("relaxes required properties, length constraints, and additionalProperties on nested object fields", () => {
    const output = outputSchema({
      properties: { "Stryker was here": { type: "string", minLength: 5 } },
      required: ["Stryker was here"],
    });

    expect(accepts(output, { result: {} })).toBe(true);
    expect(accepts(output, { result: { "Stryker was here": "ab" } })).toBe(
      true
    );
    expect(accepts(output, { result: { "Stryker was here": 5 } })).toBe(false);
    expect(accepts(output, { result: "not-an-object" })).toBe(false);

    expect(
      decoded(output, { result: { "Stryker was here": "ab", extra: 1 } })
    ).toEqual(Option.some({ result: { "Stryker was here": "ab", extra: 1 } }));
  });

  it("keeps an explicit type on the relaxed schema even when properties are also present", () => {
    const output = outputSchema({
      type: "string",
      properties: { extra: { type: "string" } },
    });

    expect(accepts(output, { result: "hello" })).toBe(true);
    expect(accepts(output, { result: { extra: "x" } })).toBe(false);
  });
});

describe("openApiInputFields with no query or body", () => {
  it("returns only the path fields", () => {
    const fields: ToolFields = openApiInputFields({
      path: { type: "object", properties: { id: { type: "string" } } },
    });

    expect(R.keys(fields)).toEqual(["id"]);
  });
});

describe("generated input fields", () => {
  /**
   * The generated source is Effect's printout of the conversion above. This
   * proves the printout lost nothing a client sees: every route's fields carry
   * the same JSON Schema as converting the route's spec here.
   */
  it("advertise what converting each route's spec advertises", () => {
    const routes: Readonly<Record<string, OpenApiInputSpec>> =
      OPENAPI_INPUT_SPECS;

    expect(R.keys(OPENAPI_INPUT_FIELDS)).toEqual(R.keys(routes));

    Arr.forEach(R.toEntries(routes), ([route, spec]) => {
      const generated = OPENAPI_INPUT_FIELDS[route];

      assert(generated !== undefined, `no generated fields for ${route}`);

      expect(
        Schema.toJsonSchemaDocument(Schema.Struct(generated)),
        route
      ).toEqual(Schema.toJsonSchemaDocument(schema(spec)));
    });
  });
});
