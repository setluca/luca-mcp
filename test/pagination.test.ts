import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as R from "effect/Record";
import { TestClock } from "effect/testing";
import { assert, describe, expect, it, onTestFinished, vi } from "vitest";

import { formatError, LucaHttpError, LucaTimeoutError } from "../src/errors.ts";
import { LucaApi, type LucaRequest } from "../src/http.ts";
import { LUCA_OPERATIONS, type LucaOperation } from "../src/operations.ts";
import type { PageContract } from "../src/page-contract.ts";
import { paginatedProgram } from "../src/pagination.ts";
import type { JsonValueInput } from "../src/serialization.ts";
import { parseJsonRecord, toJsonValue } from "./helpers.ts";

/**
 * `bookings.list` is a real paginating operation from the manifest, reused
 * here as the fixture operation so these tests exercise `paginatedProgram`
 * with the same `LucaOperation` shape the server registers, without spinning
 * up an `McpServer` or a client.
 */
const BOOKINGS_LIST = LUCA_OPERATIONS.find(
  (operation) => operation.id === "bookings.list"
);

assert(BOOKINGS_LIST, "expected bookings.list in LUCA_OPERATIONS");

const OPERATION: LucaOperation = BOOKINGS_LIST;

/** The page shape of an operation the manifest says walks. */
function pageContractOf(operation: LucaOperation): PageContract {
  assert(operation.pageContract, `expected ${operation.id} to paginate`);

  return operation.pageContract;
}

type PageByCursor = Record<string, JsonValueInput>;

function apiOf(handler: (request: LucaRequest) => JsonValueInput): LucaApi {
  return {
    request: (request) =>
      Effect.succeed(handler(request)).pipe(Effect.map(toJsonValue)),
  };
}

function cursorFrom(request: LucaRequest): string | undefined {
  return request.query?.cursor as string | undefined;
}

function pageFor(
  pages: PageByCursor,
  cursor: string | undefined
): JsonValueInput {
  return pages[cursor ?? "start"];
}

function runPaginated(
  handler: (request: LucaRequest) => JsonValueInput,
  maxPages?: number
) {
  return Effect.runPromise(
    paginatedProgram(OPERATION, pageContractOf(OPERATION), {}, maxPages).pipe(
      Effect.provide(Layer.succeed(LucaApi, apiOf(handler)))
    )
  );
}

function loggedTruncationEvents(logSpy: ReturnType<typeof vi.spyOn>) {
  return logSpy.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((line: string) => line.includes("mcp.pagination.truncated"))
    .map((line: string) => parseJsonRecord(line));
}

describe("paginatedProgram", () => {
  it("returns a single page with no nextCursor field untouched", async () => {
    const result = await runPaginated(() => ({ bookings: [1, 2, 3] }));
    expect(result).toEqual({ bookings: [1, 2, 3] });
  });

  it("walks multiple pages and merges their items", async () => {
    const pages = {
      start: { bookings: [1], nextCursor: "c1" },
      c1: { bookings: [2], nextCursor: "c2" },
      c2: { bookings: [3], nextCursor: null },
    } satisfies PageByCursor;

    const result = await runPaginated((request) =>
      pageFor(pages, cursorFrom(request))
    );

    expect(result).toEqual({
      bookings: [1, 2, 3],
      pagination: { pagesFetched: 3, truncated: false, nextCursor: null },
    });
  });

  it("stops at the maxPages guard and marks the result truncated with a continuation cursor", async () => {
    const requests: LucaRequest[] = [];

    const result = await runPaginated((request) => {
      requests.push(request);
      const page = Number(cursorFrom(request) ?? "0");

      return { bookings: [page], nextCursor: `${page + 1}` };
    }, 3);

    expect(result).toEqual({
      bookings: [0, 1, 2],
      pagination: { pagesFetched: 3, truncated: true, nextCursor: "3" },
    });
    expect(requests).toHaveLength(3);
  });

  it("halts the walk and keeps the cursor when a later page arrives in an unreadable shape", async () => {
    const requests: LucaRequest[] = [];

    const result = await runPaginated((request) => {
      requests.push(request);

      return cursorFrom(request) === undefined
        ? { bookings: [1], nextCursor: "c1" }
        : "not-a-page";
    });

    expect(result).toEqual({
      warning:
        'INCOMPLETE LIST: page 2 came back in a shape that could not be read (unreadable_page). `bookings` holds only the 1 items from the first 1 page(s); do not treat it as the full list. Call again with cursor "c1" to fetch the rest.',
      bookings: [1],
      pagination: {
        pagesFetched: 1,
        truncated: true,
        nextCursor: "c1",
        error: "unreadable_page",
      },
    });
    expect(requests).toHaveLength(2);
  });

  it("halts on a cursor the walk already followed", async () => {
    const requests: LucaRequest[] = [];

    const result = await runPaginated((request) => {
      requests.push(request);

      return { bookings: [requests.length], nextCursor: "c1" };
    });

    expect(requests).toHaveLength(2);
    expect(result).toMatchObject({
      bookings: [1, 2],
      pagination: {
        pagesFetched: 2,
        truncated: true,
        nextCursor: "c1",
        error: "repeated_cursor",
      },
    });
    expect(R.keys(result as Record<string, unknown>)[0]).toBe("warning");
    // Calling again with that cursor would walk the same loop.
    expect((result as { warning: string }).warning).not.toContain("Call again");
  });

  it("halts on an empty page that still offers a cursor", async () => {
    const requests: LucaRequest[] = [];

    const result = await runPaginated((request) => {
      requests.push(request);

      return cursorFrom(request) === undefined
        ? { bookings: [1], nextCursor: "c1" }
        : { bookings: [], nextCursor: "c2" };
    });

    expect(requests).toHaveLength(2);
    expect(result).toMatchObject({
      bookings: [1],
      pagination: {
        pagesFetched: 2,
        truncated: true,
        nextCursor: "c2",
        error: "empty_page_with_cursor",
      },
    });
    expect(R.keys(result as Record<string, unknown>)[0]).toBe("warning");
  });

  it("returns the pages collected so far when the walk runs past its time budget", async () => {
    // Each page after the first takes 50s, so two fit in the 120s budget and
    // the third is cut off in flight.
    const api: LucaApi = {
      request: (request) => {
        const page = Number(cursorFrom(request)?.slice(1) ?? "0");

        return page === 0
          ? Effect.succeed({ bookings: [1], nextCursor: "c1" })
          : Effect.sleep("50 seconds").pipe(
              Effect.as({
                bookings: [page + 1],
                nextCursor: `c${page + 1}`,
              })
            );
      },
    };

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          paginatedProgram(OPERATION, pageContractOf(OPERATION), {}, 50)
        );

        yield* TestClock.adjust(Duration.minutes(3));

        return yield* Fiber.join(fiber);
      }).pipe(
        Effect.provide(Layer.succeed(LucaApi, api)),
        Effect.provide(TestClock.layer())
      )
    );

    expect(result).toMatchObject({
      bookings: [1, 2, 3],
      pagination: {
        pagesFetched: 3,
        error: "time_budget_exceeded",
        truncated: true,
        nextCursor: "c3",
      },
    });
    expect(R.keys(result as Record<string, unknown>)[0]).toBe("warning");
  });

  it("ends the walk at a later page that leaves nextCursor out", async () => {
    const pages = {
      start: { bookings: [1], nextCursor: "c1" },
      c1: { bookings: [2] },
    } satisfies PageByCursor;

    const requests: LucaRequest[] = [];

    const result = await runPaginated((request) => {
      requests.push(request);

      return pageFor(pages, cursorFrom(request));
    });

    expect(result).toEqual({
      bookings: [1, 2],
      pagination: { pagesFetched: 2, truncated: false, nextCursor: null },
    });
    expect(requests).toHaveLength(2);
  });

  it("keeps the fetched pages and reports the error when a later page fails", async () => {
    const failure = new LucaTimeoutError({ message: "page 2 timed out" });

    const api: LucaApi = {
      request: (request) =>
        cursorFrom(request) === undefined
          ? Effect.succeed({ bookings: [1], nextCursor: "c1" })
          : Effect.fail(failure),
    };

    const result = await Effect.runPromise(
      paginatedProgram(OPERATION, pageContractOf(OPERATION), {}, 5).pipe(
        Effect.provide(Layer.succeed(LucaApi, api))
      )
    );

    expect(result).toEqual({
      warning: `INCOMPLETE LIST: page 2 failed (${formatError(failure)}). \`bookings\` holds only the 1 items from the first 1 page(s); do not treat it as the full list. Call again with cursor "c1" to fetch the rest.`,
      bookings: [1],
      pagination: {
        pagesFetched: 1,
        truncated: true,
        nextCursor: "c1",
        error: formatError(failure),
      },
    });
    // The warning leads the object, so it leads the JSON text a model reads.
    expect(R.keys(result as Record<string, unknown>)[0]).toBe("warning");
  });

  it.each([
    { name: "a 401", status: 401, body: { error: { code: "unauthorized" } } },
    {
      name: "a 403 for a missing scope",
      status: 403,
      body: { error: { code: "scope_required" } },
    },
  ])(
    "fails the walk when a later page gets $name",
    async ({ status, body }) => {
      // A partial list would hide a token that needs the coach to sign in again.
      const failure = new LucaHttpError({
        status,
        statusText: "Refused",
        body,
      });

      const api: LucaApi = {
        request: (request) =>
          cursorFrom(request) === undefined
            ? Effect.succeed({ bookings: [1], nextCursor: "c1" })
            : Effect.fail(failure),
      };

      const exit = await Effect.runPromiseExit(
        paginatedProgram(OPERATION, pageContractOf(OPERATION), {}, 5).pipe(
          Effect.provide(Layer.succeed(LucaApi, api))
        )
      );

      expect(exit).toStrictEqual(Exit.fail(failure));
    }
  );

  it("merges the array its page shape names when a page carries more than one", async () => {
    // The items array is the one the route's response schema declares first,
    // decided before the request went out. Every other array rides along as a
    // passthrough field.
    const pages = {
      start: { bookings: [1, 2], tags: ["a"], nextCursor: "c1" },
      c1: { bookings: [3], tags: ["b"], nextCursor: null },
    } satisfies PageByCursor;

    const result = await runPaginated((request) =>
      pageFor(pages, cursorFrom(request))
    );

    expect(result).toEqual({
      bookings: [1, 2, 3],
      tags: ["a"],
      pagination: { pagesFetched: 2, truncated: false, nextCursor: null },
    });
  });

  it("sends the cursor under the query name the route declares", async () => {
    const messages = LUCA_OPERATIONS.find(
      (operation) => operation.id === "conversations.messages"
    );

    assert(messages, "expected conversations.messages in LUCA_OPERATIONS");

    const requests: LucaRequest[] = [];

    // oxlint-disable-next-line anti-slop/no-known-value-widening -- Keeps the declared key set open; values are consumed through typed accessors.
    const pages: PageByCursor = {
      start: { messages: [1], nextCursor: "c1" },
      c1: { messages: [2], nextCursor: null },
    };

    await Effect.runPromise(
      paginatedProgram(messages, pageContractOf(messages), {}, undefined).pipe(
        Effect.provide(
          Layer.succeed(
            LucaApi,
            apiOf((request) => {
              requests.push(request);
              // SAFETY: This test fixture reads back exactly what the paginator sent.
              const before = request.query?.before as string | undefined;

              return pageFor(pages, before);
            })
          )
        )
      )
    );

    expect(requests).toHaveLength(2);
    expect(requests[1]?.query).toMatchObject({ before: "c1" });
    expect(requests[1]?.query).not.toHaveProperty("cursor");
  });

  it("returns the raw page when it carries no array to merge", async () => {
    const requests: LucaRequest[] = [];
    const page = { nextCursor: "c1", total: 7 };

    const result = await runPaginated((request) => {
      requests.push(request);

      return page;
    });

    expect(result).toEqual(page);
    // Nothing to aggregate means the walk stops rather than inventing a shape.
    expect(requests).toHaveLength(1);
  });

  it("carries a non-item top-level field from the first page through to the aggregated result", async () => {
    const pages = {
      start: { bookings: [1, 2], nextCursor: "c1", total: 7 },
      c1: { bookings: [3], nextCursor: null },
    } satisfies PageByCursor;

    const result = await runPaginated((request) =>
      pageFor(pages, cursorFrom(request))
    );

    expect(result).toEqual({
      total: 7,
      bookings: [1, 2, 3],
      pagination: { pagesFetched: 2, truncated: false, nextCursor: null },
    });
  });

  it("logs mcp.pagination.truncated only when the walk actually truncates", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    onTestFinished(() => {
      logSpy.mockRestore();
    });

    const completePages = {
      start: { bookings: [1], nextCursor: "c1" },
      c1: { bookings: [2], nextCursor: null },
    } satisfies PageByCursor;

    await runPaginated((request) =>
      pageFor(completePages, cursorFrom(request))
    );
    expect(loggedTruncationEvents(logSpy)).toHaveLength(0);

    logSpy.mockClear();

    await runPaginated(
      (request) =>
        cursorFrom(request) === undefined
          ? { bookings: [1], nextCursor: "c1" }
          : { bookings: [2], nextCursor: "c2" },
      1
    );
    const events = loggedTruncationEvents(logSpy);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "mcp.pagination.truncated",
      toolName: OPERATION.toolName,
      pages: 1,
    });
  });
});
