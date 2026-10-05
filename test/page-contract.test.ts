import { describe, expect, it } from "vitest";

import { cursorQueryParamOf } from "../scripts/lib/openapi-input-fields.ts";
import type { JsonSchema } from "../src/openapi-schema.ts";
import {
  itemsKeyOf,
  pageContractFor,
  pageContractOf,
} from "../src/page-contract.ts";

describe("pageContractFor", () => {
  it("reads both halves off the generated schemas for a paginating route", () => {
    expect(pageContractFor("GET", "/api/leads")).toEqual({
      cursorQueryParam: "cursor",
      itemsKey: "leads",
    });
  });

  it("uses the conversation-messages cursor name, which is not `cursor`", () => {
    expect(pageContractFor("GET", "/api/conversations/{id}/messages")).toEqual({
      cursorQueryParam: "before",
      itemsKey: "messages",
    });
  });

  it("answers nothing for a route with no cursor in its response", () => {
    expect(
      pageContractFor("GET", "/api/leads/field-definitions")
    ).toBeUndefined();
  });

  it("answers nothing for a route the manifest does not describe", () => {
    // Neither generated map has an entry, so both halves read off `undefined`.
    // This is the case that proves the optional reads are load-bearing: without
    // them, building the catalog would throw rather than report "no page".
    expect(pageContractFor("GET", "/api/not-a-route")).toBeUndefined();
    expect(pageContractFor("POST", "/api/leads")).toBeUndefined();
  });
});

describe("cursorQueryParamOf", () => {
  it("names `cursor` when the query declares it", () => {
    expect(
      cursorQueryParamOf({ type: "object", properties: { cursor: {} } })
    ).toBe("cursor");
  });

  it("names `before`, the other cursor the manifest uses", () => {
    expect(
      cursorQueryParamOf({ type: "object", properties: { before: {} } })
    ).toBe("before");
  });

  it("prefers `cursor` when a route somehow declares both", () => {
    expect(
      cursorQueryParamOf({
        type: "object",
        properties: { before: {}, cursor: {} },
      })
    ).toBe("cursor");
  });

  it("names nothing for a query with other fields, no query, or no properties", () => {
    expect(
      cursorQueryParamOf({ type: "object", properties: { status: {} } })
    ).toBeUndefined();
    // A route with no query block at all, and one whose query block declares no
    // properties. Neither is hypothetical: the generated manifest is written
    // from whatever apps/api serves, so the reads have to hold for both.
    expect(cursorQueryParamOf(undefined)).toBeUndefined();
    expect(cursorQueryParamOf({ type: "object" })).toBeUndefined();
  });
});

describe("itemsKeyOf", () => {
  const page = (properties: Record<string, JsonSchema>): JsonSchema => ({
    type: "object",
    properties,
  });

  it("names the first array field a page declares", () => {
    expect(
      itemsKeyOf(
        page({ nextCursor: { type: "string" }, items: { type: "array" } })
      )
    ).toBe("items");
  });

  it("skips non-array fields to find the records", () => {
    expect(
      itemsKeyOf(
        page({
          nextCursor: { type: "string" },
          total: { type: "number" },
          leads: { type: "array" },
        })
      )
    ).toBe("leads");
  });

  it("refuses to guess between two arrays nobody named", () => {
    // Declaration order used to be the tie-break, which would start merging
    // the wrong array the day the API adds one above the records.
    expect(() =>
      itemsKeyOf(
        page({
          nextCursor: { type: "string" },
          items: { type: "array" },
          errors: { type: "array" },
        })
      )
    ).toThrow("several arrays (items, errors)");
  });

  it("takes the declared array when a page carries two", () => {
    expect(
      itemsKeyOf(
        page({
          nextCursor: { type: "string" },
          filters: { type: "array" },
          items: { type: "array" },
        }),
        "items"
      )
    ).toBe("items");
  });

  it("rejects a declared key the page does not carry as an array", () => {
    expect(() =>
      itemsKeyOf(
        page({ nextCursor: { type: "string" }, items: { type: "array" } }),
        "records"
      )
    ).toThrow('"records" is not an array field');
  });

  it("never names nextCursor itself, even when it is the only field", () => {
    expect(itemsKeyOf(page({ nextCursor: { type: "array" } }))).toBeUndefined();
  });

  it("steps over a property the manifest declares with no schema at all", () => {
    // `relaxJsonSchema` drops structure it cannot represent, so a property can
    // arrive with nothing under it. Reading `.type` off that directly throws
    // while the catalog is still being built.
    expect(
      itemsKeyOf({
        type: "object",
        properties: {
          nextCursor: { type: "string" },
          // SAFETY: a schema-less property is what a relaxed manifest can hold;
          // the declared type cannot express it.
          // oxlint-disable-next-line effect/avoid-any -- the test feeds a value the type rules out on purpose
          legacy: null as unknown as JsonSchema,
          items: { type: "array" },
        },
      })
    ).toBe("items");
  });

  it("names nothing for a page with a cursor but no array", () => {
    expect(
      itemsKeyOf(
        page({ nextCursor: { type: "string" }, total: { type: "number" } })
      )
    ).toBeUndefined();
  });

  it("names nothing for a body with no cursor, no properties, or no body", () => {
    expect(itemsKeyOf(page({ items: { type: "array" } }))).toBeUndefined();
    expect(itemsKeyOf({ type: "object" })).toBeUndefined();
    expect(itemsKeyOf({ type: "array" })).toBeUndefined();
    expect(itemsKeyOf(null)).toBeUndefined();
    expect(itemsKeyOf(undefined)).toBeUndefined();
  });
});

describe("pageContractOf", () => {
  const cursorPage: JsonSchema = {
    type: "object",
    properties: { nextCursor: { type: "string" }, items: { type: "array" } },
  };

  it("answers with both halves when both are there", () => {
    expect(pageContractOf("cursor", cursorPage)).toEqual({
      cursorQueryParam: "cursor",
      itemsKey: "items",
    });
  });

  it("withholds a shape when the response hands back no cursor", () => {
    expect(pageContractOf("cursor", { type: "object" })).toBeUndefined();
  });

  it("withholds a shape when the request takes no cursor", () => {
    expect(pageContractOf(undefined, cursorPage)).toBeUndefined();
  });

  it("names the conversations array on the route that also lists channels", () => {
    expect(pageContractFor("GET", "/api/conversations")?.itemsKey).toBe(
      "conversations"
    );
  });

  it("withholds a shape when neither half is there", () => {
    expect(pageContractOf(undefined, undefined)).toBeUndefined();
  });
});
