import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as R from "effect/Record";

import { OPENAPI_CURSOR_QUERY_PARAMS } from "./generated/openapi-inputs.ts";
import { OPENAPI_OUTPUTS } from "./generated/openapi-outputs.ts";
import type { JsonSchema } from "./openapi-schema.ts";

/**
 * What one page of a list route looks like: the query field a cursor goes back
 * in, and the field the records arrive in.
 *
 * The cursor field is worked out when `openapi-inputs.ts` is generated, and the
 * items field is read off the generated output schema when the catalog is built. An operation either has a page shape or does not paginate, so the
 * paginator never has to work either half out from an incoming body. The two
 * answers cannot disagree because there is only one.
 */
export type PageContract = {
  readonly cursorQueryParam: string;
  readonly itemsKey: string;
};

const CURSOR_QUERY_PARAMS_BY_ROUTE = HashMap.fromIterable<string, string>(
  R.toEntries(OPENAPI_CURSOR_QUERY_PARAMS)
);

const OUTPUTS_BY_ROUTE = HashMap.fromIterable<string, JsonSchema | null>(
  R.toEntries(OPENAPI_OUTPUTS)
);

/**
 * The records field for a page whose body declares more than one array. Every
 * other paging route declares exactly one, so it needs no entry here.
 */
// oxlint-disable-next-line anti-slop/no-known-value-widening -- looked up by a route string built at runtime, so the keys must stay open
const ITEMS_KEY_BY_ROUTE: Readonly<Record<string, string>> = {
  // `availableChannels` is the filter's option list, not a page of records.
  "GET /api/conversations": "conversations",
};

/**
 * The array field a page carries its records in, absent when the body hands
 * back no cursor or declares no array.
 *
 * A body with one array has an obvious answer. A body with more than one needs
 * `declared` to name it: guessing by declaration order would start merging the
 * wrong array the day the API adds a field above the records. An undeclared
 * tie, or a declared key the body does not carry as an array, throws while the
 * catalog is built, so the mistake fails every test instead of reaching a
 * client.
 */
export function itemsKeyOf(
  body: JsonSchema | null | undefined,
  declared?: string
): string | undefined {
  if (body?.type !== "object" || body.properties?.nextCursor === undefined) {
    return;
  }

  const arrays = R.toEntries(body.properties)
    .filter(([key, schema]) => key !== "nextCursor" && schema?.type === "array")
    .map(([key]) => key);

  if (declared !== undefined) {
    if (!arrays.includes(declared)) {
      // oxlint-disable-next-line effect/avoid-untagged-errors -- a stale catalog entry is a programming error, not a runtime failure
      throw new Error(
        `Page items key "${declared}" is not an array field of this response (arrays: ${arrays.join(", ") || "none"}).`
      );
    }

    return declared;
  }

  if (arrays.length > 1) {
    // oxlint-disable-next-line effect/avoid-untagged-errors -- an ambiguous page shape is a programming error, not a runtime failure
    throw new Error(
      `A paged response declares several arrays (${arrays.join(", ")}). Name its records field in ITEMS_KEY_BY_ROUTE.`
    );
  }

  return arrays[0];
}

/**
 * The page shape of a route, absent when the route does not paginate.
 *
 * Walking a list needs both halves: a body that hands back a cursor and an
 * array to merge, and a query field to send the cursor in. Guessing from the
 * operation id used to answer this, and was wrong fourteen times: twelve routes
 * that answer with a plain array and no cursor, and two that paginate under an
 * id that does not end in `.list`.
 */
export function pageContractFor(
  method: string,
  path: string
): PageContract | undefined {
  const route = `${method} ${path}`;

  return pageContractOf(
    Option.getOrUndefined(HashMap.get(CURSOR_QUERY_PARAMS_BY_ROUTE, route)),
    Option.getOrUndefined(HashMap.get(OUTPUTS_BY_ROUTE, route)),
    ITEMS_KEY_BY_ROUTE[route]
  );
}

/**
 * The page shape a cursor query field and a response schema describe, absent
 * when either half is missing. Split from {@link pageContractFor} so both halves can be
 * withheld independently: the manifest happens to carry no route that takes a
 * cursor and answers without one, and that asymmetry is a fact about today's
 * API rather than a rule this function may assume.
 */
export function pageContractOf(
  cursorQueryParam: string | undefined,
  body: JsonSchema | null | undefined,
  declaredItemsKey?: string
): PageContract | undefined {
  const itemsKey = itemsKeyOf(body, declaredItemsKey);

  if (cursorQueryParam === undefined || itemsKey === undefined) {
    return;
  }

  return { cursorQueryParam, itemsKey };
}
