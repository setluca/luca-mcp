import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { resolveOpenApiReferences } from "../scripts/lib/openapi-refs.ts";
import { OPENAPI_INPUT_SPECS } from "../src/generated/openapi-input-specs.ts";
import { OPENAPI_INPUT_FIELDS } from "../src/generated/openapi-inputs.ts";
import { OPENAPI_OUTPUTS } from "../src/generated/openapi-outputs.ts";
import {
  openApiToolOutputFields,
  type ToolFields,
} from "../src/openapi-schema.ts";

function accepts(schema: Schema.Struct<ToolFields>, value: unknown) {
  return Option.isSome(Schema.decodeUnknownOption(schema)(value));
}

const reference = { $ref: "#/components/schemas/Name" };

const document = {
  components: { schemas: { Name: { type: "string", minLength: 1 } } },
};

describe("OpenAPI reference generation", () => {
  it("resolves repeated and nested references, preserving constraints and annotations", () => {
    expect(
      resolveOpenApiReferences(
        {
          type: "object",
          properties: {
            first: reference,
            default: reference,
            names: { type: "array", items: reference },
            described: {
              ...reference,
              description: "Name",
              "x-luca-sensitive": "lead",
            },
          },
        },
        document
      )
    ).toEqual({
      type: "object",
      properties: {
        first: { type: "string", minLength: 1 },
        default: { type: "string", minLength: 1 },
        names: { type: "array", items: { type: "string", minLength: 1 } },
        described: {
          type: "string",
          minLength: 1,
          description: "Name",
          "x-luca-sensitive": "lead",
        },
      },
    });
  });

  it("resolves escaped pointer tokens and chained references", () => {
    expect(
      resolveOpenApiReferences(
        { $ref: "#/Alias" },
        {
          Alias: { $ref: "#/a~1b~0c" },
          "a/b~c": { type: "boolean" },
        }
      )
    ).toEqual({ type: "boolean" });
  });

  it.each([
    { $ref: "https://example.test/schema.json" },
    { $ref: "#/missing" },
    { $ref: "#/toString" },
    { $ref: "#/bad~2escape" },
    { $ref: 3 },
    { ...reference, type: "number" },
    { ...reference, anyOf: [{ type: "number" }] },
  ])(
    "rejects unsupported references and conflicting constraints: %j",
    (schema) => {
      expect(() => resolveOpenApiReferences(schema, document)).toThrow();
    }
  );

  it("rejects indirect recursive schemas instead of emitting permissive validation", () => {
    expect(() =>
      resolveOpenApiReferences(
        { $ref: "#/A" },
        {
          A: { properties: { child: { $ref: "#/B" } } },
          B: { items: { $ref: "#/A" } },
        }
      )
    ).toThrow("Cyclic OpenAPI reference");
  });

  it("leaves literal data untouched", () => {
    const schema = {
      const: reference,
      default: reference,
      examples: [reference],
    };

    expect(resolveOpenApiReferences(schema, {})).toEqual(schema);
  });

  it("emits self-contained input and output schemas", () => {
    expect(resolveOpenApiReferences(OPENAPI_INPUT_SPECS, {})).toEqual(
      OPENAPI_INPUT_SPECS
    );
    expect(resolveOpenApiReferences(OPENAPI_OUTPUTS, {})).toEqual(
      OPENAPI_OUTPUTS
    );
  });

  it("validates real generated lead creation input and lead response structure", () => {
    const input = Schema.Struct(OPENAPI_INPUT_FIELDS["POST /api/leads"] ?? {});

    expect(
      accepts(input, { body: { channel: "telegram", externalUserId: "123" } })
    ).toBe(true);
    expect(accepts(input, { body: {} })).toBe(false);
    expect(
      accepts(input, { body: { channel: "other", externalUserId: "123" } })
    ).toBe(false);
    expect(
      accepts(input, { body: { channel: "telegram", externalUserId: "" } })
    ).toBe(false);

    const output = Schema.Struct(
      openApiToolOutputFields({
        body: OPENAPI_OUTPUTS["GET /api/leads/{id}"],
        untrustedContent: false,
      })
    );

    expect(accepts(output, { result: {} })).toBe(true);
    expect(accepts(output, { result: "invalid" })).toBe(false);
    expect(accepts(output, { result: { lead: { id: 42 } } })).toBe(false);
  });
});
