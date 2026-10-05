import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as SchemaAST from "effect/SchemaAST";

import {
  findOpenApiOperation,
  successBody,
} from "../scripts/lib/openapi-operation.ts";
import { sensitivePathsInJsonSchema } from "../scripts/lib/sensitive-paths.ts";
import { loadOpenApi } from "../scripts/load-openapi.ts";
import { LUCA_OPERATIONS } from "../src/operations.ts";
import type { JsonValue } from "../src/serialization.ts";

const BLANK = { type: "string", "x-luca-sensitive": "blank" };

/** The marked paths of `GET /api/read`'s 200 body, references inlined. */
function markedPaths(
  schema: JsonValue,
  schemas: Record<string, JsonValue> = {}
): readonly string[] {
  const spec = {
    paths: {
      "/api/read": {
        get: {
          responses: { 200: { content: { "application/json": { schema } } } },
        },
      },
    },
    components: { schemas },
  };

  return sensitivePathsInJsonSchema(
    Option.getOrUndefined(
      Option.map(
        findOpenApiOperation(spec, { method: "GET", path: "/api/read" }),
        successBody
      )
    )
  );
}

describe("sensitivePathsInJsonSchema", () => {
  it("names a marked field with array and record hops", () => {
    expect(
      sensitivePathsInJsonSchema({
        type: "object",
        properties: {
          id: { type: "string" },
          items: {
            type: "array",
            items: { type: "object", properties: { body: BLANK } },
          },
          byChannel: {
            type: "object",
            additionalProperties: {
              type: "object",
              properties: { phrase: BLANK },
            },
          },
        },
      })
    ).toEqual(["byChannel{}.phrase", "items[].body"]);
  });

  it("takes the union of a branch schema's branches", () => {
    // A field marked in one variant is still a field an agent can read.
    expect(
      sensitivePathsInJsonSchema({
        anyOf: [
          { type: "object", properties: { note: BLANK } },
          { type: "object", properties: { reason: BLANK } },
        ],
      })
    ).toEqual(["note", "reason"]);
  });

  it("returns nothing for a route that answers with no body", () => {
    expect(sensitivePathsInJsonSchema(undefined)).toEqual([]);
  });

  it("reads a marked field through a component reference", () => {
    expect(
      markedPaths(
        {
          type: "object",
          properties: { lead: { $ref: "#/components/schemas/Lead" } },
        },
        { Lead: { type: "object", properties: { name: BLANK } } }
      )
    ).toEqual(["lead.name"]);
  });

  it("treats a marker beside a reference as marking the whole field", () => {
    expect(
      markedPaths(
        {
          type: "object",
          properties: {
            note: {
              $ref: "#/components/schemas/Note",
              "x-luca-sensitive": "blank",
            },
          },
        },
        { Note: { type: "string" } }
      )
    ).toEqual(["note"]);
  });
});

layer(BunServices.layer)("real catalog redaction", (it) => {
  it.effect(
    "advertises exactly what apps/api/openapi.json marks as lead-derived",
    () =>
      Effect.gen(function* () {
        // `openapi:outputs:check` keeps the generated lists in step with the
        // snapshot. This reads the published marker back off every tool, so
        // a route whose list never reaches its tool fails here rather than
        // shipping a lead's words to an agent that was told they were
        // verbatim.
        const { spec } = yield* loadOpenApi();

        const advertised = R.fromEntries(
          LUCA_OPERATIONS.map((operation) => {
            const result = operation.outputSchema.result;

            const marker =
              result === undefined
                ? undefined
                : SchemaAST.resolveAt<readonly string[]>(
                    "x-luca-redacted-fields"
                  )(result.ast);

            return [operation.id, marker ?? []] as const;
          })
        );

        const marked = R.fromEntries(
          LUCA_OPERATIONS.map(
            (operation) =>
              [
                operation.id,
                sensitivePathsInJsonSchema(
                  Option.getOrUndefined(
                    Option.map(
                      findOpenApiOperation(spec, operation),
                      successBody
                    )
                  )
                ),
              ] as const
          )
        );

        expect(advertised).toEqual(marked);
      })
  );
});
