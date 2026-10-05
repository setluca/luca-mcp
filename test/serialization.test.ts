import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  isJsonObject,
  JsonObject,
  JsonValue,
  parseJson,
  toJsonPayload,
  toJsonText,
} from "../src/serialization.ts";

describe("toJsonText", () => {
  it("indents so a human or an agent can read the block", () => {
    expect(toJsonText({ a: 1, b: [2] })).toBe(
      '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}'
    );
  });

  it('answers "null" for a value JSON.stringify refuses to render', () => {
    // `JSON.stringify(undefined)` is `undefined`, not a string. Without the
    // fallback the text block would carry the literal word "undefined", which
    // is not JSON and would fail any client that parses it.
    expect(toJsonText(undefined)).toBe("null");
    expect(toJsonText(null)).toBe("null");
  });
});

describe("toJsonPayload", () => {
  it("stays compact, because this is what goes on the wire", () => {
    expect(toJsonPayload({ a: 1, b: [2] })).toBe('{"a":1,"b":[2]}');
  });

  it('answers "null" for a value JSON.stringify refuses to render', () => {
    expect(toJsonPayload(undefined)).toBe("null");
    expect(toJsonPayload(null)).toBe("null");
  });
});

describe("parseJson", () => {
  it("parses JSON text", () => {
    expect(Effect.runSync(parseJson('{"a":[1,null,true]}'))).toEqual({
      a: [1, null, true],
    });
  });

  it("fails on malformed input instead of throwing", () => {
    const exit = Effect.runSyncExit(parseJson("{"));

    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("JsonValue", () => {
  it("accepts every JSON shape, nested", () => {
    const value = { a: [1, "two", true, null, { b: {} }] };
    expect(Schema.decodeUnknownSync(JsonValue)(value)).toEqual(value);
  });

  it("rejects a value JSON cannot carry", () => {
    expect(Schema.is(JsonValue)(undefined)).toBe(false);
    expect(Schema.is(JsonObject)([1, 2])).toBe(false);
    expect(isJsonObject([1, 2])).toBe(false);
  });
});
