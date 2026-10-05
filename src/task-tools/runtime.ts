import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import {
  formatError,
  isAuthorizationFailure,
  type LucaError,
} from "../errors.ts";
import { NonEmptyString } from "../fields.ts";
import type { LucaApi } from "../http.ts";
import type { ToolField, ToolFields } from "../openapi-schema.ts";
import {
  type LucaOperation,
  type LucaOperationId,
  operationById,
} from "../operations.ts";
import type { ConfirmCondition } from "../operations/registry.ts";
import { optionalField } from "../optional-field.ts";
import type {
  JsonInputObject,
  JsonValue,
  JsonValueInput,
  QueryParameters,
} from "../serialization.ts";

/**
 * What a task tool is and what every task tool is built out of: the shape one
 * declares, and the request plumbing each `run` body shares. The tools
 * themselves live one file per domain beside this one, so a tool body reads as
 * the fields it maps rather than the plumbing it repeats.
 */

export type TaskToolInput = JsonInputObject & {
  readonly workspaceId?: string;
  readonly workspaceSlug?: string;
  readonly idempotencyKey?: string;
  readonly confirm?: boolean;
};

/** The path, query, and body one composed request carries. */
export type TaskRequestParts = {
  pathParams?: Record<string, string>;
  query?: QueryParameters;
  body?: JsonValueInput;
};

/**
 * Sends one request to an operation the tool composes. The id is limited to
 * the tool's `composes` list, so calling an undeclared operation does not
 * compile, and the flags derived from that list cannot miss a route.
 */
export type TaskCall<Id extends LucaOperationId> = (
  id: Id,
  parts?: TaskRequestParts
) => Effect.Effect<JsonValue, LucaError, LucaApi>;

/**
 * One intent-level tool. Whether it is read-only, needs `confirm: true`, or
 * returns untrusted text is derived from the operations in `composes`, so a
 * tool cannot claim to be safer than the routes it calls. The one stated flag,
 * `untrustedContent`, can only make a tool stricter.
 */
export interface LucaTaskTool<Id extends LucaOperationId = LucaOperationId> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: ToolFields;
  /**
   * What `run` succeeds with. The pipeline declares it as the `result` field
   * of the tool's output schema, beside the provenance marker.
   */
  readonly outputSchema: ToolField;
  /** The operations `run` may call, and the only ids `call` accepts. */
  readonly composes: readonly [Id, ...Id[]];
  /**
   * Frames the result as untrusted even when no composed operation is flagged.
   * Set it when the tool returns a field a lead or invitee can write that the
   * composed route does not mark. It can only add
   * the frame: a composed untrusted operation frames the tool whether or not
   * this is set.
   */
  readonly untrustedContent?: true;
  /**
   * Requires `confirm: true` only for the calls this accepts, when the
   * composed operations do not already gate every call. The condition reads
   * the tool's own input. A gate on a composed operation still wins and
   * applies to every call.
   */
  readonly confirm?: ConfirmCondition;
  readonly run: (
    call: TaskCall<Id>,
    input: TaskToolInput
  ) => Effect.Effect<JsonValue, LucaError, LucaApi>;
}

/**
 * Declares a task tool, inferring the id union from `composes` so `run` can
 * only call what the tool declares.
 */
export function taskTool<const Id extends LucaOperationId>(
  tool: LucaTaskTool<Id>
): LucaTaskTool {
  return tool;
}

/**
 * The `result` an operation tool declares, for a task tool that hands that
 * response back unchanged or nests it in its own output.
 */
export function operationResult(id: LucaOperationId): ToolField {
  return operationById(id).outputSchema.result ?? Schema.Unknown;
}

/**
 * A field that holds an operation's response, or the error a tool recorded in
 * its place under `errorKey`.
 */
export function resultOrError(id: LucaOperationId, errorKey: string) {
  return Schema.Union([
    operationResult(id),
    Schema.Struct({ [errorKey]: Schema.String }),
  ]);
}

function workspaceOverride(input: TaskToolInput) {
  const override = {
    ...optionalField("workspaceId", input.workspaceId),
    ...optionalField("workspaceSlug", input.workspaceSlug),
  };

  // An override naming neither field is no override at all, and sending an
  // empty one would pin the request to nothing.

  if (R.isEmptyReadonlyRecord<string, unknown>(override)) {
    return;
  }

  return override;
}

/**
 * Assemble the request a task tool sends: the resolved operation plus its
 * path/query/body, with the workspace override and idempotency key folded in
 * the same way for every tool. This is the task-tool analogue of operations.ts
 * `commonInput`. One seam owns "how a task request is built", so a tool body
 * reads as the fields it maps, not the plumbing. Pass `body: undefined` to omit
 * the body entirely (an absent optional field, never `{ body: undefined }`).
 */
export function taskRequest(
  operation: LucaOperation,
  input: TaskToolInput,
  parts: TaskRequestParts = {}
) {
  return {
    operation,
    ...optionalField("pathParams", parts.pathParams),
    ...optionalField("query", parts.query),
    ...optionalField("body", parts.body),
    ...optionalField("idempotencyKey", input.idempotencyKey),
    ...optionalField("workspace", workspaceOverride(input)),
  };
}

/**
 * The only part of a listing page a composing tool reads for itself: the ids of
 * the items it then fans out over. Decoding that alone leaves the raw page
 * intact for the caller, returned exactly as the API sent it, while the ids the
 * tool acts on are validated rather than asserted.
 */
const ListingIds = Schema.Struct({
  items: Schema.optional(
    Schema.Array(Schema.Struct({ id: Schema.optional(Schema.String) }))
  ),
});

const decodeListingIds = Schema.decodeUnknownOption(ListingIds);

/**
 * Ids of the first `limit` items on a listing page. A page whose fields we
 * cannot read, or whose items carry no id, contributes nothing. The tool still
 * returns the page itself rather than failing over a fan-out it cannot do.
 */
export function listingIds(page: JsonValue, limit: number): readonly string[] {
  // Both fallbacks below are empty arrays, and substituting a one-item array
  // for either is an equivalent mutation rather than an untested branch: a
  // substituted item carries no `id`, so the `filter` at the end of this
  // function drops it and the result is the same empty id list. Substituting
  // `undefined` for the outer fallback is a real change and is covered by the
  // undecodable-page test.
  const items = decodeListingIds(page).pipe(
    // Stryker disable next-line ArrayDeclaration: a substituted item has no id and is filtered out below
    Option.map((decoded) => decoded.items ?? []),
    // Stryker disable next-line ArrayDeclaration: a substituted item has no id and is filtered out below
    Option.getOrElse((): readonly { readonly id?: string }[] => [])
  );

  return items
    .slice(0, limit)
    .map((item) => item.id)
    .filter((id): id is string => id !== undefined);
}

/**
 * A request body carrying a single text field, or no body at all when the input
 * is absent or blank. Sending an empty string would mean something different to
 * the API than leaving the field off.
 */
export function textBody(
  key: string,
  value: JsonValueInput
): JsonInputObject | undefined {
  return Option.fromNullishOr(value).pipe(
    Option.map(String),
    Option.filter((text) => Str.isNonEmpty(text)),
    Option.map((text) => ({ [key]: text })),
    Option.getOrUndefined
  );
}

/** Reads a numeric tool input, falling back when it is absent or not a number. */
export function numberInput(value: JsonValueInput, fallback: number): number {
  return P.isNumber(value) ? value : fallback;
}

/**
 * A required string argument. The registered tool schema has already checked
 * it, so a non-string here is a bug in this package and dies as a defect.
 */
export function stringInput(value: JsonValueInput): string {
  return decodeString(value);
}

const decodeString = Schema.decodeUnknownSync(Schema.String);

/**
 * The `idempotencyKey` input of a task tool that writes. An empty key is
 * refused by the schema rather than read as "no key", because a keyed call
 * skips checks a fresh call runs.
 */
export function idempotencyKeyInput(description: string) {
  return {
    idempotencyKey: Schema.optionalKey(
      NonEmptyString.annotate({ description })
    ),
  } satisfies ToolFields;
}

/**
 * A failure a partial-result tool can report in place of one section, or a
 * failure that has to end the tool call. A refused token or a missing scope
 * fails every other request in the tool too, and only a failed tool result
 * carries the challenge that sends the client back through sign-in.
 */
export const isPartialFailure = (error: LucaError) =>
  !isAuthorizationFailure(error);

/**
 * One section of a partial-result tool, as a `Result` the tool folds into its
 * report. An authorization failure stays in the error channel, see
 * {@link isPartialFailure}.
 */
export function sectionResult<A, R>(
  effect: Effect.Effect<A, LucaError, R>
): Effect.Effect<Result.Result<A, LucaError>, LucaError, R> {
  return effect.pipe(
    Effect.map((value) => Result.succeed(value)),
    Effect.catchIf(isPartialFailure, (error) =>
      Effect.succeed(Result.fail(error))
    )
  );
}

/**
 * A request whose failure comes back as a field under `errorKey` instead of
 * ending the tool call. A tool that files two independent writes keeps the
 * second one reachable when the first fails, so the agent reads what failed
 * instead of retrying the half that already landed. An authorization failure
 * still ends the call, see {@link isPartialFailure}.
 */
export function failureAsField<R>(
  errorKey: string,
  effect: Effect.Effect<JsonValue, LucaError, R>
): Effect.Effect<JsonValue, LucaError, R> {
  return Effect.catchIf(effect, isPartialFailure, (error) =>
    Effect.succeed<JsonValue>({ [errorKey]: formatError(error) })
  );
}
