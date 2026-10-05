import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { TestClock } from "effect/testing";
import { afterEach, assert, describe, expect, it, vi } from "vitest";

import {
  LucaDecodeError,
  LucaHttpError,
  LucaNetworkError,
  LucaTimeoutError,
} from "../src/errors.ts";
import { createLucaApi } from "../src/http.ts";
import { LUCA_OPERATIONS } from "../src/operations.ts";
import { mayRetry, type RetryPolicy } from "../src/resilience.ts";
import { encodeUnknownJson } from "./json.ts";

function getOperation(id: string) {
  const operation = LUCA_OPERATIONS.find((item) => item.id === id);

  assert(operation, `Missing operation: ${id}`);

  return operation;
}

const READ: RetryPolicy = { method: "GET", idempotencyKey: undefined };

const UNKEYED_WRITE: RetryPolicy = {
  method: "POST",
  idempotencyKey: undefined,
};

const KEYED_WRITE: RetryPolicy = { method: "POST", idempotencyKey: "key-1" };

function httpError(status: number, retryAfterMs?: number) {
  return new LucaHttpError({
    status,
    statusText: "",
    body: null,
    // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- The empty spread intentionally omits optional fields when absent.
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

/** Any stand-in for `fetch`: the client calls the global, so only the stub's results matter. */
type FetchStub = (...args: never[]) => Promise<Response>;

function api(fetchImpl: FetchStub, timeoutMs = 1000) {
  vi.stubGlobal("fetch", fetchImpl);

  return createLucaApi({
    apiBaseUrl: "https://api.example.com",
    apiKey: Redacted.make("luca_test"),
    authHeader: "x-api-key",
    requestTimeoutMs: timeoutMs,
  });
}

/**
 * Runs an effect with the backoff sleeps skipped rather than slept through.
 * `TestClock.adjust` only moves the clock for fibers already waiting on it, so
 * the effect is forked first and the clock is walked forward in steps large
 * enough to clear every delay the schedule can produce.
 */
function runFast<A, E>(effect: Effect.Effect<A, E, never>) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.result(effect));

      yield* Effect.forEach(
        Array.from({ length: 10 }),
        () => TestClock.adjust(Duration.seconds(5)),
        { concurrency: 1, discard: true }
      );

      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer()))
  );
}

describe("mayRetry", () => {
  it("replays a read for any failure that says nothing about the handler", () => {
    expect(
      mayRetry(READ, new LucaNetworkError({ message: "socket closed" }))
    ).toBe(true);
    expect(mayRetry(READ, new LucaTimeoutError({ message: "slow" }))).toBe(
      true
    );

    Arr.forEach([429, 502, 503, 504], (status) => {
      expect(mayRetry(READ, httpError(status))).toBe(true);
    });
  });

  it("replays a HEAD as freely as a GET", () => {
    // No route in the catalog answers HEAD today. The rule is about the method
    // having no effect to repeat, not about which routes happen to exist.
    expect(
      mayRetry(
        { method: "HEAD", idempotencyKey: undefined },
        new LucaNetworkError({ message: "socket closed" })
      )
    ).toBe(true);
  });

  it("never replays a 500", () => {
    // A 502, 503, or 504 means the request never reached the handler. A 500
    // means the handler ran and threw, possibly after writing.
    expect(mayRetry(READ, httpError(500))).toBe(false);
    expect(mayRetry(KEYED_WRITE, httpError(500))).toBe(false);
  });

  it("never replays a failure the server already answered", () => {
    expect(mayRetry(READ, httpError(404))).toBe(false);
    expect(
      mayRetry(READ, new LucaDecodeError({ message: "bad", body: "<html>" }))
    ).toBe(false);
  });

  it("replays a write only when it carries an idempotency key", () => {
    const error = new LucaNetworkError({ message: "socket closed" });
    expect(mayRetry(UNKEYED_WRITE, error)).toBe(false);
    expect(mayRetry(KEYED_WRITE, error)).toBe(true);
  });

  it("gives up when the server asks for a wait longer than we will hold", () => {
    expect(mayRetry(READ, httpError(429, 2000))).toBe(true);
    expect(mayRetry(READ, httpError(429, 60_000))).toBe(false);
  });
});

describe("resilient requests", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sends a read again after a network failure", async () => {
    const fetchMock = vi
      .fn()
      // oxlint-disable-next-line effect/avoid-untagged-errors -- fetch rejects with a plain Error, and this stub reproduces it
      .mockRejectedValueOnce(new Error("socket closed"))
      .mockResolvedValue(new Response(encodeUnknownJson({ ok: true })));

    const result = await runFast(
      api(fetchMock).request({
        operation: getOperation("leads.get"),
        pathParams: { id: "00000000-0000-0000-0000-000000000000" },
      })
    );

    expect(Result.isSuccess(result)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("waits out a Retry-After before replaying a 429", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("{}", { status: 429, headers: { "retry-after": "2" } })
      )
      .mockResolvedValue(new Response(encodeUnknownJson({ ok: true })));

    const result = await runFast(
      api(fetchMock).request({
        operation: getOperation("leads.get"),
        pathParams: { id: "00000000-0000-0000-0000-000000000000" },
      })
    );

    expect(Result.isSuccess(result)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("replays a 429 with no Retry-After on its own backoff", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 429 }))
      .mockResolvedValue(new Response(encodeUnknownJson({ ok: true })));

    const result = await runFast(
      api(fetchMock).request({
        operation: getOperation("leads.get"),
        pathParams: { id: "00000000-0000-0000-0000-000000000000" },
      })
    );

    expect(Result.isSuccess(result)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reads the HTTP-date form of Retry-After", async () => {
    // The request reads Effect's Clock, and runFast starts the TestClock at
    // the epoch, so this date is two seconds after "now".
    // oxlint-disable-next-line effect/use-clock-service -- builds a fixed header value, not a reading of the current time
    const soon = new Date(2000).toUTCString();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("{}", { status: 503, headers: { "retry-after": soon } })
      )
      .mockResolvedValue(new Response(encodeUnknownJson({ ok: true })));

    const result = await runFast(
      api(fetchMock).request({
        operation: getOperation("leads.get"),
        pathParams: { id: "00000000-0000-0000-0000-000000000000" },
      })
    );

    expect(Result.isSuccess(result)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports a 429 the server told us to come back for much later", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response("{}", { status: 429, headers: { "retry-after": "3600" } })
      );

    const result = await runFast(
      api(fetchMock).request({
        operation: getOperation("leads.get"),
        pathParams: { id: "00000000-0000-0000-0000-000000000000" },
      })
    );

    expect(Result.isFailure(result)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sits through a Retry-After that lands exactly on the cap, then replays", async () => {
    // Ten seconds is the longest wait we hold, and the cap is inclusive: the
    // replay happens, and not one moment before the server said to come back.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("{}", { status: 429, headers: { "retry-after": "10" } })
      )
      .mockResolvedValue(new Response(encodeUnknownJson({ ok: true })));

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.result(
            api(fetchMock).request({
              operation: getOperation("leads.get"),
              pathParams: { id: "00000000-0000-0000-0000-000000000000" },
            })
          )
        );

        yield* TestClock.adjust(Duration.seconds(9));
        expect(fetchMock).toHaveBeenCalledTimes(1);
        yield* TestClock.adjust(Duration.seconds(5));

        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer()))
    );

    expect(Result.isSuccess(result)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails the last attempt at once rather than sitting out its Retry-After", async () => {
    // Every answer asks for five seconds. Three replays wait fifteen in all,
    // and the fourth failure has no replay after it, so nothing waits on it.
    const fetchMock = vi.fn(
      async () =>
        new Response("{}", { status: 503, headers: { "retry-after": "5" } })
    );

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          api(fetchMock).request({
            operation: getOperation("leads.get"),
            pathParams: { id: "00000000-0000-0000-0000-000000000000" },
          })
        );

        yield* Effect.forEach(
          Arr.makeBy(3, () => Duration.seconds(5)),
          (step) => TestClock.adjust(step),
          { concurrency: 1, discard: true }
        );
        yield* Effect.yieldNow;

        return fiber.pollUnsafe();
      }).pipe(Effect.provide(TestClock.layer()))
    );

    expect(exit?._tag).toBe("Failure");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("sends a 500 exactly once", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 500 }));

    const result = await runFast(
      api(fetchMock).request({
        operation: getOperation("leads.get"),
        pathParams: { id: "00000000-0000-0000-0000-000000000000" },
      })
    );

    expect(Result.isFailure(result)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("replays a keyed write under the key the first attempt carried", async () => {
    const fetchMock = vi
      .fn()
      // oxlint-disable-next-line effect/avoid-untagged-errors -- fetch rejects with a plain Error, and this stub reproduces it
      .mockRejectedValueOnce(new Error("socket closed"))
      .mockResolvedValue(new Response(encodeUnknownJson({ id: "lead" })));

    const result = await runFast(
      api(fetchMock).request({
        operation: getOperation("leads.create"),
        body: { channel: "telegram", externalUserId: "u_1" },
      })
    );

    expect(Result.isSuccess(result)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // SAFETY: the mock records exactly what the client passed fetch.
    const calls = fetchMock.mock.calls as [URL, RequestInit][];

    const keys = calls.map((call) =>
      new Headers(call[1].headers).get("idempotency-key")
    );

    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it("mints a fresh key each time the same write program runs", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response(encodeUnknownJson({ id: "lead" })))
      );

    const program = api(fetchMock).request({
      operation: getOperation("leads.create"),
      body: { channel: "telegram", externalUserId: "u_1" },
    });

    await runFast(program);
    await runFast(program);

    // SAFETY: the mock records exactly what the client passed fetch.
    const calls = fetchMock.mock.calls as [URL, RequestInit][];

    const keys = calls.map((call) =>
      new Headers(call[1].headers).get("idempotency-key")
    );

    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBeTruthy();
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("sends an unkeyed write exactly once", async () => {
    // oxlint-disable-next-line effect/avoid-untagged-errors -- fetch rejects with a plain Error, and this stub reproduces it
    const fetchMock = vi.fn().mockRejectedValue(new Error("socket closed"));

    // This route does not require an idempotency key, so nothing is minted and
    // a replay would land as a second, separate write.
    const result = await runFast(
      api(fetchMock).request({
        operation: getOperation("webhooks.subscriptions.create"),
        body: { url: "https://example.com/hook", events: ["lead.created"] },
      })
    );

    expect(Result.isFailure(result)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up on an unkeyed write at once rather than waiting out its Retry-After", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response("{}", { status: 429, headers: { "retry-after": "8" } })
      );

    const settled = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.result(
            api(fetchMock).request({
              operation: getOperation("webhooks.subscriptions.create"),
              body: {
                url: "https://example.com/hook",
                events: ["lead.created"],
              },
            })
          )
        );

        yield* TestClock.adjust(Duration.seconds(1));
        // A write with no key is never replayed, so the eight seconds the
        // server asked for would be eight seconds spent to fail anyway.
        const polled = fiber.pollUnsafe();
        yield* TestClock.adjust(Duration.seconds(30));
        yield* Fiber.join(fiber);

        return polled;
      }).pipe(Effect.provide(TestClock.layer()))
    );

    expect(settled).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails a hung request with a timeout rather than hanging", async () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));

    const result = await runFast(
      api(fetchMock, 1000).request({
        operation: getOperation("leads.get"),
        pathParams: { id: "00000000-0000-0000-0000-000000000000" },
      })
    );

    assert(Result.isFailure(result), "a hung request must fail");
    expect(result.failure).toBeInstanceOf(LucaTimeoutError);
    // The message names the bound that was crossed, so a caller reading the
    // error knows the request was abandoned rather than answered.
    expect(result.failure.message).toBe(
      "Luca API did not answer within 1000ms"
    );
  });

  it("tells the caller a hung unkeyed write has an unknown outcome", async () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));

    const result = await runFast(
      api(fetchMock, 1000).request({
        operation: getOperation("webhooks.subscriptions.create"),
        body: { url: "https://example.com/hook", events: ["lead.created"] },
      })
    );

    assert(Result.isFailure(result), "a hung write must fail");
    expect(result.failure.message).toContain("The outcome is unknown");
    expect(result.failure.message).toContain(
      "Check whether it took effect before sending it again."
    );
  });

  it("names the key that makes a second send safe for a hung keyed write", async () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));

    const result = await runFast(
      api(fetchMock, 1000).request({
        operation: getOperation("leads.create"),
        body: { channel: "telegram", externalUserId: "u_1" },
        idempotencyKey: "retry-me",
      })
    );

    assert(Result.isFailure(result), "a hung write must fail");
    expect(result.failure.message).toContain('idempotencyKey "retry-me"');
  });

  it("caps the whole call at the deadline, retries and waits included", async () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));

    const result = await runFast(
      api(fetchMock, 30_000).request({
        operation: getOperation("leads.get"),
        pathParams: { id: "00000000-0000-0000-0000-000000000000" },
      })
    );

    assert(Result.isFailure(result), "a hung request must fail");
    expect(result.failure.message).toBe(
      "Luca API did not answer within 45000ms"
    );
    // The first attempt timed out at 30s and the replay was cut at 45s, so
    // no third attempt ever started.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports the last 503 when the deadline cuts a retried call short", async () => {
    const busy = () =>
      new Response("upstream busy", {
        status: 503,
        statusText: "Service Unavailable",
        headers: { "retry-after": "10" },
      });

    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => busy())
      .mockImplementationOnce(async () => busy())
      .mockImplementationOnce(async () => busy())
      .mockImplementation(() => new Promise<Response>(() => undefined));

    const result = await runFast(
      api(fetchMock, 30_000).request({
        operation: getOperation("leads.get"),
        pathParams: { id: "00000000-0000-0000-0000-000000000000" },
      })
    );

    assert(Result.isFailure(result), "the deadline must fail the call");
    expect(result.failure).toBeInstanceOf(LucaTimeoutError);
    expect(result.failure.message).toContain(
      "Luca API did not answer within 45000ms"
    );
    expect(result.failure.message).toContain("Last failure:");
    expect(result.failure.message).toContain("503 Service Unavailable");
    expect(result.failure.message).toContain("upstream busy");
  });

  it("replays a 503 whose body is HTML", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("<html><body>Bad gateway</body></html>", {
          status: 503,
          headers: { "content-type": "text/html" },
        })
      )
      .mockResolvedValue(new Response(encodeUnknownJson({ ok: true })));

    const result = await runFast(
      api(fetchMock).request({
        operation: getOperation("leads.get"),
        pathParams: { id: "00000000-0000-0000-0000-000000000000" },
      })
    );

    expect(Result.isSuccess(result)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the Retry-After of a plain-text 429", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("slow down", {
        status: 429,
        headers: { "retry-after": "60" },
      })
    );

    const result = await runFast(
      api(fetchMock).request({
        operation: getOperation("leads.get"),
        pathParams: { id: "00000000-0000-0000-0000-000000000000" },
      })
    );

    assert(Result.isFailure(result), "a 60s wait is past the cap");
    assert(result.failure instanceof LucaHttpError);
    expect(result.failure.status).toBe(429);
    expect(result.failure.retryAfterMs).toBe(60_000);
    expect(result.failure.body).toBe("slow down");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("waits out the Retry-After of a plain-text 429 within the cap", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("slow down", {
          status: 429,
          headers: { "retry-after": "2" },
        })
      )
      .mockResolvedValue(new Response(encodeUnknownJson({ ok: true })));

    const result = await runFast(
      api(fetchMock).request({
        operation: getOperation("leads.get"),
        pathParams: { id: "00000000-0000-0000-0000-000000000000" },
      })
    );

    expect(Result.isSuccess(result)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refuses redirects so the API key stays on the configured host", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}"));

    await runFast(
      api(fetchMock).request({
        operation: getOperation("leads.get"),
        pathParams: { id: "00000000-0000-0000-0000-000000000000" },
      })
    );

    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("error");
  });
});
