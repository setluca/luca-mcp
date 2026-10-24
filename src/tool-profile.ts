import * as Arr from "effect/Array";
import * as Order from "effect/Order";

import { confirmInput } from "./fields.ts";
import { openApiToolOutputFields, type ToolFields } from "./openapi-schema.ts";
import { operationById } from "./operations/catalog.ts";
import type {
  ConfirmCondition,
  ConfirmGate,
  LucaOperation,
} from "./operations/registry.ts";
import { optionalField } from "./optional-field.ts";
import {
  highestCapabilityScope,
  type LucaCapabilityScope,
  oauthScopeForOperation,
} from "./scopes.ts";
import type { LucaTaskTool } from "./task-tools/runtime.ts";
import { buildCache } from "./tool-cache.ts";

/**
 * What a client is told about a Luca tool, for both kinds of tool.
 *
 * A `LucaOperation` is one REST route; a task tool composes several behind one
 * intent-level call. {@link toolProfile} is where that difference ends. It
 * answers every question asked about a tool before it runs (its schemas, its
 * safety facts, the OAuth scope it needs, the hints it is registered with), so
 * the registration pipeline, the session's tool list, the operation manifest,
 * and the docs all read one answer instead of deriving their own. Running a
 * tool is `tool.ts`'s job, and nothing here sends a request.
 */

/** Either kind of Luca tool, told apart by `kind`. */
export type ToolSource = LucaOperation | LucaTaskTool;

/**
 * MCP tool annotations, so a client can reason about a tool before calling it
 * (auto-approve reads, flag destructive writes). These are hints, never a
 * security boundary. The Luca API still enforces scopes and safety server-side.
 */
type ToolAnnotations = {
  readonly title: string;
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
};

export type ToolProfile = {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: ToolFields;
  readonly outputSchema: ToolFields;
  readonly readOnly: boolean;
  /**
   * The call changes or removes something that already exists, rather than only
   * adding to it. A delete, a partial update, and a whole-resource replace all
   * qualify; creating a new record does not.
   */
  readonly mutatesExisting: boolean;
  /** Repeating the call with the same input has no further effect. */
  readonly idempotent: boolean;
  /** Absent when no call needs `confirm: true`. */
  readonly confirm?: ConfirmGate;
  readonly untrustedContent: boolean;
  /** The call can read or change something outside the coach's Luca workspace. */
  readonly openWorld: boolean;
  /**
   * The least-privilege OAuth scope that lets a connection call this tool. It
   * is what the tool declares in `securitySchemes`, what an auth error asks the
   * client to request, and what a grant-filtered session compares the grant
   * against.
   */
  readonly oauthScope: LucaCapabilityScope;
  /** Every API scope the routes behind the tool declare, sorted and deduplicated. */
  readonly apiScopes: readonly string[];
  readonly annotations: ToolAnnotations;
};

/** The facts a task tool takes from the operations it composes. */
type SafetyFacts = Pick<
  ToolProfile,
  | "readOnly"
  | "mutatesExisting"
  | "idempotent"
  | "confirm"
  | "untrustedContent"
  | "openWorld"
  | "oauthScope"
  | "apiScopes"
>;

/**
 * Cached on the identity of the catalog entry it comes from, because nothing in
 * a profile varies by caller and the Worker builds a fresh server per request.
 * See `tool-cache.ts` for what that buys and how a test empties it.
 */
const profiles = buildCache<ToolSource, ToolProfile>();

/** Everything a client is told about one tool, built once per catalog entry. */
export function toolProfile(source: ToolSource): ToolProfile {
  return profiles.get(source, () =>
    source.kind === "operation"
      ? operationProfile(source)
      : taskToolProfile(source)
  );
}

function operationProfile(operation: LucaOperation): ToolProfile {
  return withAnnotations({
    name: operation.toolName,
    title: operation.title,
    description: operationDescription(operation),
    inputSchema: operation.inputSchema,
    outputSchema: operation.outputSchema,
    readOnly: operation.readOnly,
    mutatesExisting: operation.mutatesExisting,
    idempotent: operation.idempotent,
    ...optionalField("confirm", operation.confirm),
    untrustedContent: operation.untrustedContent,
    openWorld: operation.openWorld,
    oauthScope: oauthScopeForOperation(operation),
    apiScopes: sortedScopes(operation.scopes),
  });
}

function taskToolProfile(tool: LucaTaskTool): ToolProfile {
  const safety = composeSafety(
    tool.composes.map((id) => toolProfile(operationById(id))),
    tool
  );

  return withAnnotations({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema:
      safety.confirm === undefined
        ? tool.inputSchema
        : { ...tool.inputSchema, ...confirmInput },
    outputSchema: {
      ...openApiToolOutputFields({
        body: null,
        untrustedContent: safety.untrustedContent,
      }),
      result: tool.outputSchema,
    },
    ...safety,
  });
}

/**
 * The safety facts of a call that runs every one of `parts`, so a task tool
 * cannot claim to be safer than the routes it calls. What the tool states for
 * itself (`own`) can only make it stricter.
 */
function composeSafety(
  parts: readonly ToolProfile[],
  own: Pick<LucaTaskTool, "untrustedContent" | "confirm">
): SafetyFacts {
  return {
    readOnly: parts.every((part) => part.readOnly),
    // A task tool overwrites or removes existing state when any write it
    // composes does.
    mutatesExisting: parts.some((part) => part.mutatesExisting),
    // Repeating a task tool has no further effect only when that holds for
    // every operation it composes.
    idempotent: parts.every((part) => part.idempotent),
    ...optionalField("confirm", composeConfirm(parts, own.confirm)),
    untrustedContent:
      own.untrustedContent === true ||
      parts.some((part) => part.untrustedContent),
    // A task tool reaches as far as the furthest operation it composes.
    openWorld: parts.some((part) => part.openWorld),
    // It runs every operation it composes, so it needs the highest scope any
    // of them needs.
    oauthScope: highestCapabilityScope(parts.map((part) => part.oauthScope)),
    apiScopes: sortedScopes(parts.flatMap((part) => part.apiScopes)),
  };
}

/**
 * One approval covers the whole call. A composed write gated for every call
 * gates the task tool every time. A composed write gated only for some inputs
 * cannot be evaluated here, because the tool's own input is not the input that
 * write receives. The tool then has to name its own narrower gate, and without
 * one it is gated every time.
 */
function composeConfirm(
  parts: readonly ToolProfile[],
  own: ConfirmCondition | undefined
): ConfirmGate | undefined {
  if (parts.some((part) => part.confirm === "always")) {
    return "always";
  }

  const conditional = parts.some((part) => part.confirm !== undefined);

  return conditional ? (own ?? "always") : own;
}

function sortedScopes(scopes: readonly string[]): readonly string[] {
  return Arr.sort(Arr.dedupe(scopes), Order.String);
}

/**
 * A profile with the hints it is registered with, read off its own facts. Both
 * kinds of tool answer through here, which is the point: the two used to answer
 * separately, and the task-tool answer reported every tool as non-destructive.
 */
function withAnnotations(facts: Omit<ToolProfile, "annotations">): ToolProfile {
  return {
    ...facts,
    annotations: {
      title: facts.title,
      readOnlyHint: facts.readOnly,
      // MCP defines the non-destructive half as additive-only, so anything that
      // overwrites or removes existing state reads true here: a delete, a
      // PATCH, a PUT replace, or a write whose real-world effect we gate on a
      // confirm. A create is a write and still reads false, because nothing it
      // touches existed before the call.
      destructiveHint:
        !facts.readOnly &&
        (facts.confirm !== undefined || facts.mutatesExisting),
      // Stated per operation: every read, plus the writes a repeat cannot move
      // further, such as a delete, a dismiss, or a whole-value replace. It
      // never leans on the idempotency key, which the HTTP layer mints fresh
      // when the caller leaves it out.
      idempotentHint: facts.idempotent,
      // Every call goes to the Luca API, but most only touch the coach's own
      // workspace. The hint is true only when the call can reach past it: a
      // lead's inbox, an outside URL, or a connected calendar or CRM.
      openWorldHint: facts.openWorld,
    },
  };
}

function operationDescription(operation: LucaOperation) {
  const lines = [
    operation.description,
    "",
    `Luca operation: ${operation.method} ${operation.path}`,
    `Required scopes: ${operation.scopes.join(", ")}`,
    `Required OAuth scope: ${oauthScopeForOperation(operation)}; data sensitivity: ${operation.requiredScope.dataSensitivity}`,
    operation.idempotencyRequired
      ? "Requires Idempotency-Key. Provide idempotencyKey for safe retries, or the server will generate one."
      : "Does not require idempotency.",
  ];

  if (operation.confirm !== undefined) {
    const when =
      operation.confirm === "always"
        ? ""
        : ` when ${operation.confirm.description}`;

    lines.push(
      `Destructive${when}: has a real-world side effect. You must pass confirm: true; the call is rejected without it.`
    );
  }

  lines.push(
    "Use workspaceId or workspaceSlug to override the default workspace configured by environment."
  );

  return lines.join("\n");
}
