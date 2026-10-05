import { encodeUnknownJson } from "./json.ts";
// oxlint-disable effect/use-clock-service -- the request reads the live clock, so Retry-After dates are built from it
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { afterEach, assert, describe, expect, it, vi } from "vitest";

import { LucaConfig } from "../src/config.ts";
import {
  LucaDecodeError,
  LucaHttpError,
  LucaNetworkError,
  LucaToolInputError,
} from "../src/errors.ts";
import { LucaApi, LucaApiLive, createLucaApi } from "../src/http.ts";
import { LUCA_OPERATIONS } from "../src/operations.ts";
import { LUCA_MCP_USER_AGENT } from "../src/version.ts";

function getOperation(id: string) {
  const operation = LUCA_OPERATIONS.find((item) => item.id === id);

  assert(operation, `Missing operation: ${id}`);

  return operation;
}

function getFetchCall(fetchMock: ReturnType<typeof vi.fn>) {
  const calls = fetchMock.mock.calls as [URL, RequestInit][];
  const call = calls[0];

  assert(call, "Expected fetch to be called");

  return call;
}

/** The error `effect` fails with. A success rejects, failing the test. */
function runFailure(effect: Effect.Effect<unknown, unknown, never>) {
  return Effect.runPromise(Effect.flip(effect));
}

describe("createLucaApi", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sends auth, workspace, query, body, and idempotency headers", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(encodeUnknownJson({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );

    vi.stubGlobal("fetch", fetchMock);

    const operation = getOperation("leads.create");

    const api = createLucaApi({
      apiBaseUrl: "https://api.example.com",
      apiKey: Redacted.make("luca_test"),
      authHeader: "x-api-key",
      workspaceSlug: "default",
    });

    const result = await Effect.runPromise(
      api.request({
        operation,
        body: { channel: "telegram", externalUserId: "u_1" },
        idempotencyKey: "lead-u-1",
        workspace: { workspaceId: "00000000-0000-0000-0000-000000000000" },
      })
    );

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = getFetchCall(fetchMock);
    const headers = new Headers(init.headers);
    expect(String(url)).toBe("https://api.example.com/api/leads");
    expect(init.method).toBe("POST");
    expect(headers.get("x-api-key")).toBe("luca_test");
    expect(headers.get("x-luca-workspace-id")).toBe(
      "00000000-0000-0000-0000-000000000000"
    );
    expect(headers.get("x-luca-workspace-slug")).toBe("default");
    expect(headers.get("idempotency-key")).toBe("lead-u-1");
    expect(init.body).toBe(
      encodeUnknownJson({ channel: "telegram", externalUserId: "u_1" })
    );
  });

  it("encodes path and query parameters", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(encodeUnknownJson({ id: "lead" }), { status: 200 })
    );

    vi.stubGlobal("fetch", fetchMock);

    const operation = getOperation("leads.get");

    const api = createLucaApi({
      apiBaseUrl: "https://api.example.com",
      apiKey: Redacted.make("luca_test"),
      authHeader: "authorization",
    });

    await Effect.runPromise(
      api.request({
        operation,
        pathParams: { id: "00000000-0000-0000-0000-000000000000" },
        query: { include: "timeline" },
      })
    );

    const [url, init] = getFetchCall(fetchMock);
    const headers = new Headers(init.headers);
    expect(String(url)).toBe(
      "https://api.example.com/api/leads/00000000-0000-0000-0000-000000000000?include=timeline"
    );
    expect(headers.get("authorization")).toBe("Bearer luca_test");
  });

  it("appends array query params and filters empty values", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(encodeUnknownJson({ leads: [] }), { status: 200 })
    );

    vi.stubGlobal("fetch", fetchMock);

    const api = createLucaApi({
      apiBaseUrl: "https://api.example.com",
      apiKey: Redacted.make("luca_test"),
      authHeader: "x-api-key",
    });

    await Effect.runPromise(
      api.request({
        operation: getOperation("leads.list"),
        query: {
          tag: ["hot", "", null, "warm"],
          cursor: "",
          active: false,
          limit: 0,
        },
      })
    );

    const [url] = getFetchCall(fetchMock);
    expect(String(url)).toBe(
      "https://api.example.com/api/leads?tag=hot&tag=warm&active=false&limit=0"
    );
  });

  it("generates an idempotency key when one is not provided", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000000"
    );

    const fetchMock = vi.fn(
      async () => new Response(encodeUnknownJson({ ok: true }), { status: 200 })
    );

    vi.stubGlobal("fetch", fetchMock);

    const api = createLucaApi({
      apiBaseUrl: "https://api.example.com",
      apiKey: Redacted.make("luca_test"),
      authHeader: "x-api-key",
    });

    await Effect.runPromise(
      api.request({
        operation: getOperation("bookings.cancel"),
        pathParams: { id: "booking_1" },
      })
    );

    const [, init] = getFetchCall(fetchMock);
    expect(new Headers(init.headers).get("idempotency-key")).toBe(
      "00000000-0000-4000-8000-000000000000"
    );
  });

  it("fails with LucaHttpError for non-2xx responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(encodeUnknownJson({ code: "scope_required" }), {
            status: 403,
            statusText: "Forbidden",
            headers: { "x-request-id": "req_123" },
          })
      )
    );

    const api = createLucaApi({
      apiBaseUrl: "https://api.example.com",
      apiKey: Redacted.make("luca_test"),
      authHeader: "x-api-key",
    });

    await expect(
      runFailure(api.request({ operation: getOperation("capabilities.get") }))
    ).resolves.toEqual(
      new LucaHttpError({
        status: 403,
        statusText: "Forbidden",
        body: { code: "scope_required" },
        requestId: "req_123",
      })
    );
  });

  it("reads Retry-After in both of its forms, and neither in a third", async () => {
    // An unkeyed write is never replayed, so the error comes straight back with
    // the header already parsed onto it. That keeps this a test of the parser
    // rather than of the retry schedule.
    async function retryAfterOf(header: string | undefined) {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response("{}", {
              status: 429,
              headers: header === undefined ? {} : { "retry-after": header },
            })
        )
      );

      const api = createLucaApi({
        apiBaseUrl: "https://api.example.com",
        apiKey: Redacted.make("luca_test"),
        authHeader: "x-api-key",
      });

      const error = await runFailure(
        api.request({
          operation: getOperation("webhooks.subscriptions.create"),
          body: { url: "https://example.com/hook", events: ["lead.created"] },
        })
      );

      expect(error).toBeInstanceOf(LucaHttpError);

      return (error as LucaHttpError).retryAfterMs;
    }

    expect(await retryAfterOf("2")).toBe(2000);
    expect(await retryAfterOf(undefined)).toBeUndefined();
    // `Headers` normalizes a value of nothing but spaces down to the empty
    // string, and an empty header has to read as no header. Treated as a value
    // it coerces to zero, which would tell the retry rules the server asked for
    // no wait at all rather than for nothing.
    expect(await retryAfterOf("   ")).toBeUndefined();
    expect(await retryAfterOf("later")).toBeUndefined();
    // Not delta-seconds, and `Date.parse` would otherwise read both as dates.
    expect(await retryAfterOf("1.5")).toBeUndefined();
    expect(await retryAfterOf("-1")).toBeUndefined();

    const future = await retryAfterOf(
      new Date(Date.now() + 5000).toUTCString()
    );

    expect(future).toBeGreaterThan(3000);
    expect(future).toBeLessThanOrEqual(5000);
    // A date already past is a wait of zero, never a negative one: a negative
    // delay would sit in `Duration.millis` and read as a wait nobody asked for.
    expect(await retryAfterOf(new Date(Date.now() - 5000).toUTCString())).toBe(
      0
    );
  });

  it("keeps the raw text of a non-JSON error response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>Bad gateway</html>", {
            status: 502,
            statusText: "Bad Gateway",
          })
      )
    );

    const api = createLucaApi({
      apiBaseUrl: "https://api.example.com",
      apiKey: Redacted.make("luca_test"),
      authHeader: "x-api-key",
    });

    const error = await runFailure(
      api.request({
        operation: getOperation("webhooks.subscriptions.create"),
        body: { url: "https://example.com/hook", events: ["lead.created"] },
      })
    );

    assert(error instanceof LucaHttpError);
    expect(error.status).toBe(502);
    expect(error.body).toBe("<html>Bad gateway</html>");
  });

  it("fails with LucaDecodeError for non-JSON responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not-json", { status: 200 }))
    );

    const api = createLucaApi({
      apiBaseUrl: "https://api.example.com",
      apiKey: Redacted.make("luca_test"),
      authHeader: "x-api-key",
    });

    const error = await runFailure(
      api.request({ operation: getOperation("capabilities.get") })
    );

    // Assert the fields directly: `toEqual` on an Effect `Schema.TaggedError`
    // compares by tag and does not diff the `message`/`body` payload, so an
    // equality check alone cannot catch a blanked message string.
    expect(error).toBeInstanceOf(LucaDecodeError);
    expect((error as LucaDecodeError).message).toBe(
      "Luca API returned non-JSON content"
    );
    expect((error as LucaDecodeError).body).toBe("not-json");
  });

  it("parses empty response bodies as null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 200 }))
    );

    const api = createLucaApi({
      apiBaseUrl: "https://api.example.com",
      apiKey: Redacted.make("luca_test"),
      authHeader: "x-api-key",
    });

    await expect(
      Effect.runPromise(
        api.request({ operation: getOperation("capabilities.get") })
      )
    ).resolves.toBeNull();
  });

  it("fails with LucaNetworkError when fetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      // oxlint-disable-next-line effect/avoid-untagged-errors -- fetch rejects with a plain Error, and this stub reproduces it
      vi.fn(() => Promise.reject(new Error("network down")))
    );

    const api = createLucaApi({
      apiBaseUrl: "https://api.example.com",
      apiKey: Redacted.make("luca_test"),
      authHeader: "x-api-key",
    });

    await expect(
      runFailure(api.request({ operation: getOperation("capabilities.get") }))
    ).resolves.toBeInstanceOf(LucaNetworkError);
  });

  it("fails with LucaNetworkError when response body cannot be read", async () => {
    class BrokenBodyResponse extends Response {
      // oxlint-disable-next-line effect/avoid-untagged-errors -- a failed body read rejects with a plain Error, and this stub reproduces it
      override text = () => Promise.reject(new Error("read failed"));
    }

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new BrokenBodyResponse(null, { status: 200 }))
    );

    const api = createLucaApi({
      apiBaseUrl: "https://api.example.com",
      apiKey: Redacted.make("luca_test"),
      authHeader: "x-api-key",
    });

    await expect(
      runFailure(api.request({ operation: getOperation("capabilities.get") }))
    ).resolves.toBeInstanceOf(LucaNetworkError);
  });

  it("fails with a typed input error when required path params are missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const api = createLucaApi({
      apiBaseUrl: "https://api.example.com",
      apiKey: Redacted.make("luca_test"),
      authHeader: "x-api-key",
    });

    const error = await runFailure(
      api.request({ operation: getOperation("leads.get") })
    );

    expect(error).toBeInstanceOf(LucaToolInputError);
    expect(error).toMatchObject({ message: "Missing path parameter: id" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats an empty path param as missing rather than encoding it", async () => {
    // An empty id would otherwise collapse the route to the collection URL and
    // silently address the wrong endpoint, so it has to fail like an absent one.
    const api = createLucaApi({
      apiBaseUrl: "https://api.example.com",
      apiKey: Redacted.make("luca_test"),
      authHeader: "x-api-key",
    });

    await expect(
      runFailure(
        api.request({
          operation: getOperation("leads.get"),
          pathParams: { id: "" },
        })
      )
    ).resolves.toMatchObject({
      _tag: "LucaToolInputError",
      message: "Missing path parameter: id",
    });
  });

  it("exposes the LucaApi context tag under its stable key", () => {
    expect(LucaApi.key).toBe("@luca/mcp/LucaApi");
  });

  it("drops undefined and null scalar query values but keeps a real value", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(encodeUnknownJson({ leads: [] }), { status: 200 })
    );

    vi.stubGlobal("fetch", fetchMock);

    const api = createLucaApi({
      apiBaseUrl: "https://api.example.com",
      apiKey: Redacted.make("luca_test"),
      authHeader: "x-api-key",
    });

    await Effect.runPromise(
      api.request({
        operation: getOperation("leads.list"),
        query: { channel: undefined, q: null, cursor: "next" },
      })
    );

    const [url] = getFetchCall(fetchMock);
    expect(String(url)).toBe("https://api.example.com/api/leads?cursor=next");
  });

  it("sets content-type and JSON body for a POST with a body", async () => {
    const fetchMock = vi.fn(
      async () => new Response(encodeUnknownJson({ ok: true }), { status: 200 })
    );

    vi.stubGlobal("fetch", fetchMock);

    const api = createLucaApi({
      apiBaseUrl: "https://api.example.com",
      apiKey: Redacted.make("luca_test"),
      authHeader: "x-api-key",
    });

    await Effect.runPromise(
      api.request({
        operation: getOperation("leads.create"),
        body: { channel: "telegram", externalUserId: "u_2" },
      })
    );

    const [, init] = getFetchCall(fetchMock);
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(init.body).toBe(
      encodeUnknownJson({ channel: "telegram", externalUserId: "u_2" })
    );
  });

  it("omits content-type and body for a POST-shaped operation with no body", async () => {
    const fetchMock = vi.fn(
      async () => new Response(encodeUnknownJson({ ok: true }), { status: 200 })
    );

    vi.stubGlobal("fetch", fetchMock);

    const api = createLucaApi({
      apiBaseUrl: "https://api.example.com",
      apiKey: Redacted.make("luca_test"),
      authHeader: "x-api-key",
    });

    await Effect.runPromise(
      api.request({
        operation: getOperation("leads.importPreview"),
        body: undefined,
      })
    );

    const [, init] = getFetchCall(fetchMock);
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBeNull();
    expect(init.body).toBeUndefined();
    // The `body` key must be absent, not present-but-undefined: with a body
    // guard that ignored the undefined check, `JSON.stringify(undefined)` would
    // spread a `body: undefined` key that `toBeUndefined` cannot distinguish.
    expect("body" in init).toBe(false);
  });

  it("omits content-type and body for a GET even when a body is supplied", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(encodeUnknownJson({ id: "lead" }), { status: 200 })
    );

    vi.stubGlobal("fetch", fetchMock);

    const api = createLucaApi({
      apiBaseUrl: "https://api.example.com",
      apiKey: Redacted.make("luca_test"),
      authHeader: "x-api-key",
    });

    await Effect.runPromise(
      api.request({
        operation: getOperation("leads.get"),
        pathParams: { id: "00000000-0000-0000-0000-000000000000" },
        body: { ignored: true },
      })
    );

    const [, init] = getFetchCall(fetchMock);
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBeNull();
    expect(init.body).toBeUndefined();
  });

  it("does not set an idempotency-key header when the operation does not require one", async () => {
    const fetchMock = vi.fn(
      async () => new Response(encodeUnknownJson({ ok: true }), { status: 200 })
    );

    vi.stubGlobal("fetch", fetchMock);

    const api = createLucaApi({
      apiBaseUrl: "https://api.example.com",
      apiKey: Redacted.make("luca_test"),
      authHeader: "x-api-key",
    });

    await Effect.runPromise(
      api.request({
        operation: getOperation("leads.importPreview"),
        body: { rows: [] },
      })
    );

    const [, init] = getFetchCall(fetchMock);
    expect(new Headers(init.headers).get("idempotency-key")).toBeNull();
  });

  it("sets default accept and user-agent headers", async () => {
    const fetchMock = vi.fn(
      async () => new Response(encodeUnknownJson({ ok: true }), { status: 200 })
    );

    vi.stubGlobal("fetch", fetchMock);

    const api = createLucaApi({
      apiBaseUrl: "https://api.example.com",
      apiKey: Redacted.make("luca_test"),
      authHeader: "x-api-key",
    });

    await Effect.runPromise(
      api.request({ operation: getOperation("capabilities.get") })
    );

    const [, init] = getFetchCall(fetchMock);
    const headers = new Headers(init.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("user-agent")).toBe(LUCA_MCP_USER_AGENT);
    expect(headers.get("user-agent")).not.toBe("luca-mcp/0.1.0");
  });

  it("reports the exact message when the response body cannot be read", async () => {
    class BrokenBodyResponse extends Response {
      // oxlint-disable-next-line effect/avoid-untagged-errors -- a failed body read rejects with a plain Error, and this stub reproduces it
      override text = () => Promise.reject(new Error("read failed"));
    }

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new BrokenBodyResponse(null, { status: 200 }))
    );

    const api = createLucaApi({
      apiBaseUrl: "https://api.example.com",
      apiKey: Redacted.make("luca_test"),
      authHeader: "x-api-key",
    });

    const error = await runFailure(
      api.request({ operation: getOperation("capabilities.get") })
    );

    expect(error).toBeInstanceOf(LucaNetworkError);
    expect((error as LucaNetworkError).message).toBe(
      "Could not read Luca API response body"
    );
  });

  it("keeps the status and Retry-After when an error body cannot be read", async () => {
    class BrokenBodyResponse extends Response {
      // oxlint-disable-next-line effect/avoid-untagged-errors -- a failed body read rejects with a plain Error, and this stub reproduces it
      override text = () => Promise.reject(new Error("read failed"));
    }

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new BrokenBodyResponse(null, {
            status: 429,
            headers: { "retry-after": "7" },
          })
      )
    );

    const api = createLucaApi({
      apiBaseUrl: "https://api.example.com",
      apiKey: Redacted.make("luca_test"),
      authHeader: "x-api-key",
    });

    const error = await runFailure(
      api.request({
        operation: getOperation("webhooks.subscriptions.create"),
        body: { url: "https://example.com/hook", events: ["lead.created"] },
      })
    );

    expect(error).toBeInstanceOf(LucaHttpError);
    expect(error).toMatchObject({
      status: 429,
      body: null,
      retryAfterMs: 7000,
    });
  });

  it("cuts a non-JSON error body to 500 characters", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(`<html>${"x".repeat(2000)}</html>`, { status: 404 })
      )
    );

    const api = createLucaApi({
      apiBaseUrl: "https://api.example.com",
      apiKey: Redacted.make("luca_test"),
      authHeader: "x-api-key",
    });

    const error = await runFailure(
      api.request({ operation: getOperation("capabilities.get") })
    );

    expect(error).toBeInstanceOf(LucaHttpError);
    expect((error as LucaHttpError).body).toBe(`<html>${"x".repeat(494)}`);
  });

  it("leaves the query string out of a network error", async () => {
    vi.stubGlobal(
      "fetch",
      // oxlint-disable-next-line effect/avoid-untagged-errors -- fetch rejects with a plain Error, and this stub reproduces it
      vi.fn(() => Promise.reject(new Error("network down")))
    );

    const api = createLucaApi({
      apiBaseUrl: "https://api.example.com",
      apiKey: Redacted.make("luca_test"),
      authHeader: "x-api-key",
    });

    const error = await runFailure(
      api.request({
        operation: getOperation("leads.list"),
        query: { q: "Ana Souza" },
      })
    );

    expect(error).toBeInstanceOf(LucaNetworkError);
    expect((error as LucaNetworkError).message).toBe(
      "Could not reach Luca API at https://api.example.com/api/leads"
    );
  });

  it("reports the exact message including the URL when fetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      // oxlint-disable-next-line effect/avoid-untagged-errors -- fetch rejects with a plain Error, and this stub reproduces it
      vi.fn(() => Promise.reject(new Error("network down")))
    );

    const api = createLucaApi({
      apiBaseUrl: "https://api.example.com",
      apiKey: Redacted.make("luca_test"),
      authHeader: "x-api-key",
    });

    const error = await runFailure(
      api.request({ operation: getOperation("capabilities.get") })
    );

    expect(error).toBeInstanceOf(LucaNetworkError);
    expect((error as LucaNetworkError).message).toBe(
      "Could not reach Luca API at https://api.example.com/api/capabilities"
    );
  });
});

describe("LucaApiLive", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("builds a client from the config in context and uses its base url", async () => {
    const fetchMock = vi.fn(
      async () => new Response(encodeUnknownJson({ ok: true }), { status: 200 })
    );

    vi.stubGlobal("fetch", fetchMock);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* LucaApi;

        return yield* api.request({
          operation: getOperation("capabilities.get"),
        });
      }).pipe(
        Effect.provide(LucaApiLive),
        Effect.provideService(LucaConfig, {
          apiBaseUrl: "https://layer.example.com",
          apiKey: Redacted.make("luca_layer"),
          authHeader: "authorization",
        })
      )
    );

    expect(result).toEqual({ ok: true });
    const [url, init] = getFetchCall(fetchMock);
    expect(url.toString()).toBe("https://layer.example.com/api/capabilities");
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer luca_layer"
    );
  });
});
