import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  formatError,
  isAuthorizationFailure,
  type LucaError,
} from "./errors.ts";
import { NonEmptyString } from "./fields.ts";
import { LucaApi } from "./http.ts";
import { logAgentSurfaceEvent } from "./observability.ts";
import {
  DEFAULT_MAX_PAGES,
  type LucaOperation,
  type LucaRequestContract,
} from "./operations.ts";
import { optionalField } from "./optional-field.ts";
import type { PageContract } from "./page-contract.ts";
import { isJsonObject, type JsonObject, JsonValue } from "./serialization.ts";

const decodeItems = Schema.decodeUnknownOption(Schema.Array(JsonValue));

const isCursor = Schema.is(NonEmptyString);

function pageItems(page: JsonObject, itemsKey: string): readonly JsonValue[] {
  return Option.getOrElse(decodeItems(page[itemsKey]), () => []);
}

/**
 * The page as something the walk can merge, or nothing when the body is not an
 * object or does not carry the array the route's page shape names. Merging a
 * shape the paginator cannot read would corrupt it.
 */
function readablePage(
  value: JsonValue,
  itemsKey: string
): Option.Option<JsonObject> {
  return isJsonObject(value) && Array.isArray(value[itemsKey])
    ? Option.some(value)
    : Option.none();
}

/**
 * The cursor to the page after this one. A page that leaves `nextCursor` out,
 * or sends it null or empty, is the last page.
 */
function cursorOf(page: JsonObject): string | undefined {
  const cursor = page.nextCursor;

  return isCursor(cursor) ? cursor : undefined;
}

/** Why a walk stopped before the cursor ran out, and how to say so. */
type Halt = {
  /** Short reason, reported as `pagination.error`. */
  readonly reason: string;
  /** What happened, as a clause in the warning. */
  readonly what: string;
  /**
   * Whether calling again with the cursor can make progress. A server that
   * repeats a cursor or sends an empty page with one would send the next call
   * round the same loop.
   */
  readonly continuable: boolean;
};

type CollectedPages = {
  readonly items: readonly JsonValue[];
  readonly pagesFetched: number;
  readonly cursor: string | undefined;
  /** Every cursor the walk has been handed, to catch a server that repeats one. */
  readonly seen: HashSet.HashSet<string>;
  /**
   * Set once a page failed, arrived in a shape the paginator cannot walk, broke
   * the cursor chain, or the walk ran out of time. The cursor that led to the
   * halt is kept, so the caller still reports the result as truncated.
   */
  readonly halt: Halt | undefined;
};

/**
 * The longest one walk may take across all of its pages. Each request is bound
 * on its own by the transport, so this caps the sum: a slow API cannot hold a
 * tool call open for ten pages at that limit each.
 */
const WALK_BUDGET_MS = 120_000;

/**
 * Everything the walk below reads, assembled once. The operation, the request
 * every page is a variation on, and the cursor's query name are all closed over
 * by `nextPage` rather than restated as fields, so the loop asks for the next
 * page by cursor alone instead of six values being threaded down through each
 * call.
 */
type Walk = {
  readonly itemsKey: string;
  readonly maxPages: number;
  /** The page after the one that sent `cursor`. */
  readonly nextPage: (cursor: string) => Effect.Effect<JsonValue, LucaError>;
};

function walkOf(
  api: LucaApi,
  operation: LucaOperation,
  pageContract: PageContract,
  baseRequest: LucaRequestContract,
  maxPages: number
): Walk {
  return {
    itemsKey: pageContract.itemsKey,
    maxPages,
    nextPage: (cursor) =>
      api.request({
        operation,
        ...baseRequest,
        query: {
          ...baseRequest.query,
          [pageContract.cursorQueryParam]: cursor,
        },
      }),
  };
}

/**
 * Follows `nextCursor` from the first page onward, merging each page's items
 * until the cursor runs out, the `maxPages` guard is hit, or the walk's time
 * budget is spent. Kept as its own Effect generator so the aggregation loop's
 * branching lives apart from the outer program's first-page setup and result
 * assembly.
 *
 * The state lives in a `Ref` so the budget can cut the loop off mid-page and
 * still hand back the pages collected so far.
 */
function collectRemainingPages(walk: Walk, first: JsonObject) {
  const { itemsKey } = walk;
  const firstCursor = cursorOf(first);

  const initial: CollectedPages = {
    items: pageItems(first, itemsKey),
    cursor: firstCursor,
    pagesFetched: 1,
    seen: HashSet.fromIterable(firstCursor === undefined ? [] : [firstCursor]),
    halt: undefined,
  };

  return Ref.make(initial).pipe(
    Effect.flatMap((ref) =>
      walkPages(walk, ref).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(WALK_BUDGET_MS),
          orElse: () =>
            Ref.get(ref).pipe(
              Effect.map((state) =>
                haltWalk(state, {
                  reason: "time_budget_exceeded",
                  what: `the ${WALK_BUDGET_MS / 1000}s time budget for walking pages ran out before page ${state.pagesFetched + 1} arrived`,
                  continuable: true,
                })
              )
            ),
        })
      )
    )
  );
}

/** The page-by-page loop, writing each step to `ref` so a cut-off keeps it. */
function walkPages(walk: Walk, ref: Ref.Ref<CollectedPages>) {
  return Effect.gen(function* () {
    // oxlint-disable-next-line effect/imperative-loops -- condition-driven loop over a mutable cursor; not a collection transform
    while (true) {
      const state = yield* Ref.get(ref);

      if (
        state.halt !== undefined ||
        state.cursor === undefined ||
        state.pagesFetched >= walk.maxPages
      ) {
        return state;
      }

      // A failed later page must not throw away the pages already fetched.
      // The result says it is partial and carries the cursor to retry from.
      const page = yield* Effect.result(walk.nextPage(state.cursor));

      // A refused token or a missing scope fails the call instead. A partial
      // list would read as "page 3 is down", and only a failed tool result
      // carries the challenge that sends the client back through sign-in.
      if (Result.isFailure(page) && isAuthorizationFailure(page.failure)) {
        return yield* Effect.fail(page.failure);
      }

      yield* Ref.set(
        ref,
        Result.match(page, {
          onFailure: (error) => failedPage(state, formatError(error)),
          onSuccess: (body) => foldPage(state, body, walk.itemsKey),
        })
      );
    }
  });
}

function failedPage(state: CollectedPages, reason: string): CollectedPages {
  return haltWalk(state, {
    reason,
    what: `page ${state.pagesFetched + 1} failed (${reason})`,
    continuable: true,
  });
}

/**
 * One more page folded into the walk's accumulated state, or a halt when the
 * page came back in a shape the paginator cannot read or broke the cursor
 * chain.
 */
function foldPage(
  state: CollectedPages,
  page: JsonValue,
  itemsKey: string
): CollectedPages {
  return readablePage(page, itemsKey).pipe(
    Option.match({
      onNone: () =>
        haltWalk(state, {
          reason: "unreadable_page",
          what: `page ${state.pagesFetched + 1} came back in a shape that could not be read (unreadable_page)`,
          continuable: true,
        }),
      onSome: (readable) => mergePage(state, readable, itemsKey),
    })
  );
}

/** The walk stopped where it stands, keeping the cursor that led to the halt. */
function haltWalk(state: CollectedPages, halt: Halt): CollectedPages {
  return { ...state, halt };
}

/**
 * The walk carried one page further. A server that answers an empty page with a
 * cursor, or hands back a cursor it already sent, would have the walk spin until
 * `maxPages`, so either one halts it instead.
 */
function mergePage(
  state: CollectedPages,
  page: JsonObject,
  itemsKey: string
): CollectedPages {
  const items = pageItems(page, itemsKey);
  const cursor = cursorOf(page);

  const advanced: CollectedPages = {
    items: [...state.items, ...items],
    cursor,
    pagesFetched: state.pagesFetched + 1,
    seen: cursor === undefined ? state.seen : HashSet.add(state.seen, cursor),
    halt: undefined,
  };

  if (cursor === undefined) {
    return advanced;
  }

  if (HashSet.has(state.seen, cursor)) {
    return haltWalk(advanced, {
      reason: "repeated_cursor",
      what: `page ${advanced.pagesFetched} sent back a cursor the walk had already followed (repeated_cursor)`,
      continuable: false,
    });
  }

  return Arr.isReadonlyArrayNonEmpty(items)
    ? advanced
    : haltWalk(advanced, {
        reason: "empty_page_with_cursor",
        what: `page ${advanced.pagesFetched} was empty but offered another cursor (empty_page_with_cursor)`,
        continuable: false,
      });
}

/**
 * Bounded server-side auto-pagination for list tools. Follows nextCursor up to
 * maxPages, merging the items array, then returns a single aggregated result.
 * If more pages remain past the guard, the result is explicitly marked
 * `truncated` and carries a `nextCursor` to continue from, so a partial result
 * always says it is one.
 */
export function paginatedProgram(
  operation: LucaOperation,
  pageContract: PageContract,
  baseRequest: LucaRequestContract,
  requestedMaxPages: number | undefined
) {
  return Effect.gen(function* () {
    const api = yield* LucaApi;

    const walk = walkOf(
      api,
      operation,
      pageContract,
      baseRequest,
      requestedMaxPages ?? DEFAULT_MAX_PAGES
    );

    const first = yield* api.request({ operation, ...baseRequest });

    // A first page that carries no `nextCursor` key at all, or none of the
    // array its page shape names, is returned exactly as the API sent it.
    const walkable = readablePage(first, pageContract.itemsKey).pipe(
      Option.filter((page) => "nextCursor" in page)
    );

    return yield* Option.match(walkable, {
      onNone: () => Effect.succeed(first),
      onSome: (page) =>
        collectRemainingPages(walk, page).pipe(
          Effect.map((collected) =>
            aggregatePages(operation, page, pageContract.itemsKey, collected)
          )
        ),
    });
  });
}

/** The single merged result a paginated tool answers with. */
function aggregatePages(
  operation: LucaOperation,
  first: JsonObject,
  itemsKey: string,
  collected: CollectedPages
) {
  const truncated = collected.cursor !== undefined;
  logPaginationTruncation(operation, collected.pagesFetched, truncated);

  return {
    // Placed first so it leads the JSON text a model reads. A list that stopped
    // on a failed page must not read as the whole list.
    ...optionalField(
      "warning",
      collected.halt === undefined
        ? undefined
        : incompleteWarning(collected, collected.halt, itemsKey)
    ),
    // Preserve every non-item, non-cursor top-level field from the first page
    // (e.g. analytics totals on comment-event lists). The first page's own
    // `nextCursor` is dropped in favor of the aggregated `pagination` below,
    // and the item array is replaced with the merged one.
    ...passthroughFields(first, itemsKey),
    [itemsKey]: collected.items,
    pagination: {
      pagesFetched: collected.pagesFetched,
      truncated,
      nextCursor: collected.cursor ?? null,
      ...optionalField("error", collected.halt?.reason),
    },
  };
}

/** What a caller reads first when the walk stopped early. */
function incompleteWarning(
  collected: CollectedPages,
  halt: Halt,
  itemsKey: string
) {
  const continueFrom =
    collected.cursor === undefined || !halt.continuable
      ? ""
      : ` Call again with cursor "${collected.cursor}" to fetch the rest.`;

  return `INCOMPLETE LIST: ${halt.what}. \`${itemsKey}\` holds only the ${collected.items.length} items from the first ${collected.pagesFetched} page(s); do not treat it as the full list.${continueFrom}`;
}

/** Top-level first-page fields to carry through, minus items and nextCursor. */
function passthroughFields(first: JsonObject, itemsKey: string): JsonObject {
  // Dropping the `key !== itemsKey` guard is unobservable: the sole caller
  // spreads this result and then re-assigns `[itemsKey]: items` immediately
  // after (see the aggregation assembly), so any items value copied through here
  // is overwritten before it can reach the output.
  return R.filter(
    first,
    // Stryker disable next-line ConditionalExpression: the items key is overwritten by the caller, so excluding it here changes nothing
    (_value, key) => key !== itemsKey && key !== "nextCursor"
  );
}

function logPaginationTruncation(
  operation: LucaOperation,
  pagesFetched: number,
  truncated: boolean
) {
  if (!truncated) {
    return;
  }

  logAgentSurfaceEvent("mcp.pagination.truncated", {
    toolName: operation.toolName,
    pages: pagesFetched,
  });
}
