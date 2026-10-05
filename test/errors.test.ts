import { describe, expect, it } from "vitest";

import {
  formatError,
  LucaConfigError,
  LucaDecodeError,
  LucaHttpError,
  LucaNetworkError,
  LucaTimeoutError,
  LucaToolInputError,
} from "../src/errors.ts";

describe("tagged error classes", () => {
  it("pins each class's exact _tag literal", () => {
    expect(new LucaConfigError({ message: "x" })._tag).toBe("LucaConfigError");
    expect(new LucaNetworkError({ message: "x" })._tag).toBe(
      "LucaNetworkError"
    );
    expect(new LucaDecodeError({ message: "x", body: "y" })._tag).toBe(
      "LucaDecodeError"
    );
    expect(
      new LucaHttpError({
        status: 500,
        statusText: "Internal Server Error",
        body: null,
      })._tag
    ).toBe("LucaHttpError");
    expect(new LucaTimeoutError({ message: "x" })._tag).toBe(
      "LucaTimeoutError"
    );
    expect(new LucaToolInputError({ message: "x" })._tag).toBe(
      "LucaToolInputError"
    );
  });
});

describe("formatError", () => {
  it("formats typed Luca errors", () => {
    expect(
      formatError(new LucaConfigError({ message: "missing config" }))
    ).toBe("missing config");
    expect(
      formatError(new LucaNetworkError({ message: "network failed" }))
    ).toBe("network failed");
    expect(
      formatError(
        new LucaDecodeError({
          message: "bad json",
          body: "x".repeat(600),
        })
      )
    ).toBe("bad json (600 characters)");
    expect(
      formatError(
        new LucaHttpError({
          status: 429,
          statusText: "Too Many Requests",
          body: { retryAfter: 1 },
        })
      )
    ).toBe('Luca API returned 429 Too Many Requests: {"retryAfter":1}');
  });

  it("formats unknown errors", () => {
    // oxlint-disable-next-line effect/avoid-untagged-errors -- formatError must handle a plain Error, the case under test
    expect(formatError(new Error("boom"))).toBe("boom");
    expect(formatError("plain failure")).toBe("plain failure");
  });

  it("renders a thrown number or boolean unquoted", () => {
    expect(formatError(404)).toBe("404");
    expect(formatError(0)).toBe("0");
    expect(formatError(true)).toBe("true");
    expect(formatError(false)).toBe("false");
    // JSON carries neither NaN nor Infinity, so both land on null. That is the
    // honest answer for a value JSON cannot express, not a lost number.
    expect(formatError(Number.NaN)).toBe("null");
    expect(formatError(Number.POSITIVE_INFINITY)).toBe("null");
  });

  it("hands a thrown string back unquoted, which JSON would not", () => {
    // The one case that needs a branch of its own: every other value renders
    // the same whether it goes through String or through JSON.
    expect(formatError("plain failure")).toBe("plain failure");
    expect(formatError("")).toBe("");
  });

  it("renders a thrown object or array as JSON, never [object Object]", () => {
    expect(formatError({ code: "rate_limited", retryAfter: 2 })).toBe(
      '{"code":"rate_limited","retryAfter":2}'
    );
    expect(formatError(["a", 1])).toBe('["a",1]');
    expect(formatError(null)).toBe("null");
  });
});
