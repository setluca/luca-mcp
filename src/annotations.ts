import * as HashSet from "effect/HashSet";

import type { ConfirmGate, LucaOperation } from "./operations/registry.ts";
import { optionalField } from "./optional-field.ts";

/**
 * What a client is told about a tool before it calls it.
 *
 * These rules are neither the catalog's nor the pipeline's. A `LucaOperation`
 * knows its own method and flags but not what a client should infer from them,
 * and the registration pipeline reads the answer without deciding it. Both
 * kinds of Luca tool ask this module the same question, which is the point: the
 * two used to answer it separately, and the task-tool answer reported every
 * tool as non-destructive.
 */
export type LucaToolAnnotations = {
  readonly title: string;
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
};

/**
 * The facts an annotation is computed from. Stated as plain booleans rather
 * than as an operation, because a task tool composes several routes and has no
 * single method to read them off, and the two kinds of tool must answer the
 * same question the same way.
 */
export type ToolAnnotationSource = {
  readonly title: string;
  readonly readOnly: boolean;
  /**
   * The call changes or removes something that already exists, rather than only
   * adding to it. A delete, a partial update, and a whole-resource replace all
   * qualify; creating a new record does not.
   */
  readonly mutatesExisting: boolean;
  /** Absent when no call needs `confirm: true`. */
  readonly confirm?: ConfirmGate;
  /** The call can read or change something outside the coach's Luca workspace. */
  readonly openWorld: boolean;
};

/**
 * The annotation facts of one REST route, read off its method and flags. The
 * tool built from an operation carries these same facts, so the manifest and
 * the registered tool cannot disagree.
 */
export function operationAnnotationSource(
  operation: LucaOperation
): ToolAnnotationSource {
  return {
    title: operation.title,
    readOnly: operation.readOnly,
    mutatesExisting: operation.mutatesExisting,
    ...optionalField("confirm", operation.confirm),
    openWorld: operation.openWorld,
  };
}

/** The annotations an operation's tool is registered with. */
export function operationAnnotations(
  operation: LucaOperation
): LucaToolAnnotations {
  return toolAnnotations(operationAnnotationSource(operation));
}

/**
 * MCP tool annotations, so a client can reason about a tool before calling it
 * (auto-approve reads, flag destructive writes). These are hints, never a
 * security boundary. The Luca API still enforces scopes and safety server-side.
 */
export function toolAnnotations(
  source: ToolAnnotationSource
): LucaToolAnnotations {
  return {
    title: source.title,
    readOnlyHint: source.readOnly,
    // MCP defines the non-destructive half as additive-only, so anything that
    // overwrites or removes existing state reads true here: a delete, a PATCH,
    // a PUT replace, or a write whose real-world effect we gate on a confirm.
    // A create is a write and still reads false, because nothing it touches
    // existed before the call.
    destructiveHint:
      !source.readOnly &&
      (source.confirm !== undefined || source.mutatesExisting),
    // The idempotency key is optional in the MCP input. The HTTP layer mints a
    // new key when it is absent, so two otherwise identical writes can still
    // have different effects. Only advertise the unconditional read guarantee
    // until the key becomes a required tool argument.
    idempotentHint: source.readOnly,
    // Every call goes to the Luca API, but most only touch the coach's own
    // workspace. The hint is true only when the call can reach past it: a
    // lead's inbox, an outside URL, or a connected calendar or CRM.
    openWorldHint: source.openWorld,
  };
}

/**
 * The HTTP methods that change state a caller already had. POST is absent on
 * purpose: it creates, and a create has nothing prior to overwrite.
 */

const MUTATING_METHODS: HashSet.HashSet<string> = HashSet.fromIterable([
  "DELETE",
  "PATCH",
  "PUT",
]);

/** True when this route's method changes or removes an existing record. */
export function mutatesExisting(method: string): boolean {
  return HashSet.has(MUTATING_METHODS, method);
}
