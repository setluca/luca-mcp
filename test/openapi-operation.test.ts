import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";

import {
  findOpenApiOperation,
  successBody,
} from "../scripts/lib/openapi-operation.ts";

const ITEM = { type: "object", properties: { id: { type: "string" } } };

const SPEC = {
  paths: {
    "/api/items": {
      get: {
        parameters: [
          { name: "limit", in: "query", schema: { type: "number" } },
        ],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Item" },
              },
            },
          },
        },
      },
      delete: { responses: { "204": { description: "Deleted" } } },
    },
  },
  components: { schemas: { Item: ITEM } },
};

describe("findOpenApiOperation", () => {
  it("decodes the route with its references inlined", () => {
    const operation = findOpenApiOperation(SPEC, {
      method: "GET",
      path: "/api/items",
    });

    expect(Option.map(operation, successBody)).toEqual(Option.some(ITEM));
  });

  it("finds nothing for a route the document lacks", () => {
    expect(
      findOpenApiOperation(SPEC, { method: "POST", path: "/api/items" })
    ).toEqual(Option.none());
  });
});

describe("successBody", () => {
  it("takes the first 2xx that has a JSON body", () => {
    expect(
      successBody({
        responses: {
          "400": {
            content: { "application/json": { schema: { type: "object" } } },
          },
          "202": {},
          "200": { content: { "application/json": { schema: ITEM } } },
        },
      })
    ).toEqual(ITEM);
  });

  it("is undefined for a route that answers with no body", () => {
    const operation = findOpenApiOperation(SPEC, {
      method: "DELETE",
      path: "/api/items",
    });

    expect(Option.map(operation, successBody)).toEqual(Option.some(undefined));
  });
});
