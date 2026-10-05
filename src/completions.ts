import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";

import type { LucaError } from "./errors.ts";
import { LucaApi } from "./http.ts";
import type { LucaOperation } from "./operations.ts";
import type { JsonValue } from "./serialization.ts";

/**
 * Argument completion for the two ids a coach types by hand. MCP completes
 * prompt arguments and resource-template variables; there is no tool-argument
 * completion in the protocol, so a tool's enum fields stay documented in their
 * own JSON Schema and only these two names get a live source.
 *
 * Ids only. A completion list is rendered by the client, so offering a lead's
 * name or a message would put lead-authored text somewhere the untrusted
 * framing every tool result carries does not reach.
 *
 * Each name maps to the list operation its ids are read from. The field those
 * ids arrive in is not named here. That comes from the operation's own page
 * shape, so a route that renames its array cannot leave this file behind.
 */
const COMPLETION_SOURCES = {
  leadId: "leads.list",
  conversationId: "conversations.list",
} as const satisfies Record<string, string>;

/** The template variable and prompt argument names a completion exists for. */
export type CompletionVariable = keyof typeof COMPLETION_SOURCES;

/**
 * One page is all a completion reads, and it is the API's own cap. The SDK
 * hands a callback no abort signal and works out `total` and `hasMore` from the
 * array it gets back, so a source with more ids than this page cannot say so.
 */
const COMPLETION_PAGE_SIZE = 100;

/**
 * Reads a list page down to the ids in one array field, ignoring every other
 * field on the page and every other field on a record. A page that arrives in
 * any other shape decodes to nothing, which the caller offers as no
 * suggestions.
 */
function idsDecoder(itemsKey: string): (page: JsonValue) => readonly string[] {
  const decode = Schema.decodeUnknownOption(
    Schema.Struct({
      [itemsKey]: Schema.Array(Schema.Struct({ id: Schema.String })),
    })
  );

  return (page) =>
    Option.match(decode(page), {
      onNone: () => [],
      // Read through the values rather than the key: the struct declares
      // exactly one field, so a page that decoded carries that field's records
      // and nothing else. Indexing by `itemsKey` would say the same thing while
      // reading as though the key might be missing.
      onSome: (decoded) =>
        R.values(decoded)
          .flat()
          .map((record) => record.id),
    });
}

/**
 * A callback shaped for both {@link ResourceTemplate}'s `complete` map and
 * `completable()`, which agree on this signature.
 */
export type CompletionCallback = (
  value: string | undefined
) => Promise<string[]>;

/** One completion callback per completable variable. */
export type CompletionCallbacksByVariable = Record<
  CompletionVariable,
  CompletionCallback
>;

/**
 * The completion callbacks for one server, closed over the layer that serves
 * the reads.
 *
 * A failed read answers with no suggestions rather than an error. A completion
 * fires on a keystroke, so a transient 500 would otherwise surface as a failure
 * for something the next character retries anyway.
 */
export function completionCallbacks(
  operationById: (id: string) => LucaOperation,
  lucaLayer: Layer.Layer<LucaApi, LucaError, never>
): CompletionCallbacksByVariable {
  function callbackFor(operationId: string): CompletionCallback {
    const operation = operationById(operationId);
    // A completion source has to be a list route: the ids come out of the
    // page's own array field, and a route that does not paginate carries none.
    // Naming one that cannot serve them is a wiring mistake, so it is refused
    // while the server is being built rather than on a keystroke.
    const itemsKey = operation.pageContract?.itemsKey;

    if (itemsKey === undefined) {
      // oxlint-disable-next-line effect/avoid-untagged-errors -- raw failure on an invariant or interop path; not a caller-recoverable domain failure
      throw new Error(
        `Completion source ${operationId} carries no list of records to read ids from`
      );
    }

    const idsOn = idsDecoder(itemsKey);

    return (value) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const api = yield* LucaApi;

          const page = yield* api.request({
            operation,
            ...operation.buildRequest({
              query: { limit: COMPLETION_PAGE_SIZE },
            }),
          });

          // Ids are UUIDs, which print in either case, and a client may type
          // the capitals it copied from elsewhere.
          const typed = (value ?? "").toLowerCase();

          return idsOn(page).filter((id) => id.toLowerCase().startsWith(typed));
        }).pipe(
          Effect.provide(lucaLayer),
          // A failed read answers with no suggestions. A defect is left alone:
          // that one is our own bug, and an empty list is exactly how it would
          // stay hidden.
          Effect.orElseSucceed((): string[] => [])
        )
      );
  }

  return R.map(COMPLETION_SOURCES, callbackFor);
}

/** Whether `name` is a template variable or prompt argument we can complete. */
export function isCompletionVariable(name: string): name is CompletionVariable {
  return Object.hasOwn(COMPLETION_SOURCES, name);
}

/**
 * The `complete` map for one URI template: every `{variable}` in it that has a
 * source. Returns undefined when none do, so a template with nothing to
 * complete registers without the key at all.
 */
export function templateCompletions(
  template: string,
  callbacks: Record<CompletionVariable, CompletionCallback>
): Record<string, CompletionCallback> | undefined {
  const variables = Arr.filter(
    Arr.map(
      Arr.fromIterable(template.matchAll(/\{([^}]+)\}/g)),
      ([, name = ""]) => name
    ),
    isCompletionVariable
  );

  return Arr.isReadonlyArrayNonEmpty(variables)
    ? R.fromEntries(Arr.map(variables, (name) => [name, callbacks[name]]))
    : undefined;
}
