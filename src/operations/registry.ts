import * as Arr from "effect/Array";
import * as HashSet from "effect/HashSet";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { mutatesExisting } from "../annotations.ts";
import {
  confirmInput,
  NonEmptyString,
  WORKSPACE_INPUT_FIELDS,
} from "../fields.ts";
import { OPENAPI_INPUT_FIELDS } from "../generated/openapi-inputs.ts";
import {
  OPENAPI_OUTPUTS,
  OPENAPI_REDACTED_FIELDS,
} from "../generated/openapi-outputs.ts";
import { type LucaRouteId, ROUTE_CATALOG } from "../generated/route-catalog.ts";
import {
  type JsonSchema,
  type ToolFields,
  openApiToolOutputFields,
} from "../openapi-schema.ts";
import { fieldsWhen, optionalField } from "../optional-field.ts";
import { type PageContract, pageContractFor } from "../page-contract.ts";
import { effectiveCapability } from "../scopes.ts";
import type {
  JsonInputObject,
  JsonObject,
  JsonValueInput,
  QueryParameters,
} from "../serialization.ts";

export type LucaMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export const LUCA_OPERATION_GROUPS = {
  capabilities: {
    title: "Capabilities",
    description: "Public API capabilities and boundary discovery.",
  },
  leads: {
    title: "Leads",
    description: "Lead identity, consent, notes, custom fields, and imports.",
  },
  conversations: {
    title: "Conversations",
    description: "Conversation search and message context.",
  },
  reviewQueue: {
    title: "Review Queue",
    description: "Human review queue visibility.",
  },
  bookings: {
    title: "Bookings",
    description: "Booking creation, scheduling, and cancellation.",
  },
  callEvents: {
    title: "Call Events",
    description:
      "What happened on a call: outcome, coach feedback, summary, and CRM push.",
  },
  campaigns: {
    title: "Campaigns",
    description:
      "Campaign drafts, enrollment, analytics, comments, and simulations.",
  },
  broadcasts: {
    title: "Broadcasts",
    description:
      "Broadcast draft, approval, launch, pause, retry, and cancel flows.",
  },
  webhooks: {
    title: "Webhooks",
    description:
      "Webhook subscriptions, deliveries, events, signatures, and replays.",
  },
  integrations: {
    title: "Integrations",
    description: "CRM connections, OAuth, mappings, sync runs, and event logs.",
  },
  voice: {
    title: "Voice",
    description:
      "The voice fingerprint and the corpus behind it, read-only. Corpus text is blanked for a redacted-tier key.",
  },
  coach: {
    title: "Coach",
    description:
      "The coach's own configuration: profile, niche and offer, objection playbook, post-call preferences. Read-only.",
  },
  usage: {
    title: "Usage",
    description: "Message-pool and model-spend counters for the current plan.",
  },
  safety: {
    title: "Account Safety",
    description: "Per-channel account health and send pacing.",
  },
  channels: {
    title: "Channels",
    description:
      "Connected channel accounts, which channels can be connected, and what each provider supports. Read-only.",
  },
  insights: {
    title: "Insights",
    description:
      "The proactive-insights feed and the acknowledgements that clear it.",
  },
  learning: {
    title: "Teach Luca",
    description:
      "The profile questions Luca still owes an answer to, and answering them.",
  },
  knowledge: {
    title: "Knowledge",
    description:
      "Profile suggestions extracted from the coach's own knowledge sources.",
  },
  memory: {
    title: "Memory",
    description:
      "What Luca remembers about a lead or the business, and how to correct it.",
  },
  cadences: {
    title: "Cadences",
    description: "Silent-lead rescue cadence control.",
  },
  reports: {
    title: "Reports",
    description: "Digest reports over the coach's workspace.",
  },
  analytics: {
    title: "Analytics",
    description:
      "Business intelligence, funnel analytics, revenue attribution, and coach performance metrics.",
  },
} as const;

export type LucaOperationGroup = keyof typeof LUCA_OPERATION_GROUPS;

/**
 * The id of a route this server may expose: one the API-key allowlist grants,
 * whose prefix before the first dot names a real group. Both halves are
 * checked at the `op()` call site, so a tool naming a route the API does not
 * grant, or one filed under a group that does not exist, is a compile error
 * rather than a check-script report.
 */
export type LucaOperationId = LucaRouteId & `${LucaOperationGroup}.${string}`;

/**
 * An operation tool's arguments. Path parameters stay under the open index
 * signature, because `buildRequest` reads them by the names in each route's
 * path.
 */
export type LucaToolInput = JsonInputObject & {
  readonly query?: QueryParameters;
  readonly body?: JsonObject;
  readonly idempotencyKey?: string;
  readonly confirm?: boolean;
  readonly maxPages?: number;
  readonly workspaceId?: string;
  readonly workspaceSlug?: string;
};

export type LucaRequestContract = {
  readonly pathParams?: Record<string, string>;
  readonly query?: QueryParameters;
  readonly body?: JsonValueInput;
  readonly idempotencyKey?: string;
  readonly workspace?: {
    readonly workspaceId?: string;
    readonly workspaceSlug?: string;
  };
};

export type LucaOperation = {
  readonly id: string;
  readonly group: LucaOperationGroup;
  readonly toolName: string;
  readonly title: string;
  readonly method: LucaMethod;
  readonly path: string;
  readonly scopes: readonly string[];
  readonly mutatesExisting: boolean;
  /** Whether the call leaves Luca and its connected systems unchanged. */
  readonly readOnly: boolean;
  readonly idempotencyRequired: boolean;
  /** Absent when the operation needs no confirmation; see {@link ConfirmGate}. */
  readonly confirm?: ConfirmGate;
  /**
   * The call can read or change something outside the coach's Luca workspace:
   * a lead's inbox, an outside URL, or a connected calendar or CRM. Clients
   * read it as the MCP `openWorldHint`.
   */
  readonly openWorld: boolean;
  /**
   * How a page of this operation's response is read and how the next one is
   * asked for, absent on an operation that does not paginate. Its presence is
   * what makes an operation walkable.
   */
  readonly pageContract?: PageContract;
  readonly untrustedContent: boolean;
  readonly requiredScope: RequiredScope;
  readonly description: string;
  readonly inputSchema: ToolFields;
  readonly outputSchema: ToolFields;
  readonly buildRequest: (input: LucaToolInput) => LucaRequestContract;
};

/**
 * The inputs a confirmation gate applies to, for an operation where only some
 * calls have the side effect. `applies` reads the tool input; `description`
 * names those calls in the tool description, e.g. "status is published".
 */
export type ConfirmCondition = {
  readonly applies: (input: JsonObject) => boolean;
  readonly description: string;
};

/**
 * Which calls must carry `confirm: true`: every call, or only those a
 * {@link ConfirmCondition} accepts. A narrowed gate still puts the `confirm`
 * field in the schema for every call.
 */
export type ConfirmGate = "always" | ConfirmCondition;

/** Whether this call has to carry `confirm: true` to run. */
export function needsConfirmation(
  gate: ConfirmGate | undefined,
  input: JsonObject
): boolean {
  if (gate === undefined) {
    return false;
  }

  return gate === "always" || gate.applies(input);
}

/**
 * The two-dimensional scope a tool requires. Mirrors the canonical model
 * in @luca/schemas agent-scope, declared locally so the published MCP package
 * stays free of workspace dependencies. This is the required-scope map an
 * agent-scope enforcement layer would check against a key's granted tiers; it
 * is metadata today, not yet enforced.
 */
export type CapabilityTier = "read" | "draft" | "queue_ops" | "full";

export type DataSensitivityTier = "redacted" | "full_content";

export type RequiredScope = {
  readonly capability: CapabilityTier;
  readonly dataSensitivity: DataSensitivityTier;
};

/**
 * The tier an operation needs: what its effect asks for, raised to whatever its
 * API scopes need, so the tier a tool states is the one an OAuth connection
 * has to request.
 */
function requiredScopeFor(input: {
  readonly method: LucaMethod;
  readonly scopes: readonly string[];
  readonly confirm: ConfirmGate | undefined;
  readonly untrustedContent: boolean;
}): RequiredScope {
  let capability: CapabilityTier = "draft";

  if (input.method === "GET") {
    capability = "read";
  } else if (input.confirm === "always") {
    // Real-world side effect (sends, enrollments, replays) = operating the
    // live queue. A write gated for only some inputs keeps its route's tier:
    // the gate guards the risky inputs, and the others stay open to a
    // connection below queue_ops.
    capability = "queue_ops";
  }

  return {
    capability: effectiveCapability({
      scopes: input.scopes,
      requiredScope: { capability },
    }),
    dataSensitivity: input.untrustedContent ? "full_content" : "redacted",
  };
}

/**
 * Operation groups whose responses carry text authored by leads or other
 * external users (conversation messages, lead-provided profile fields, the
 * review queue's inbound context). Output from these tools is wrapped with an
 * untrusted-content boundary so a downstream agent treats it as data, never as
 * instructions (prompt-injection defense).
 */

const UNTRUSTED_CONTENT_GROUPS = HashSet.fromIterable<LucaOperationGroup>([
  "callEvents",
  "conversations",
  "leads",
  // A memory is a fact Luca extracted from a lead's message, and the Teach
  // Luca panel shows a lead DM the coach pasted in. Both read back as the
  // lead's words even though neither group is named after a lead.
  "learning",
  "memory",
  "reviewQueue",
]);

/** Server-side bounded auto-pagination guard for list tools. */
export const DEFAULT_MAX_PAGES = 10;

const MAX_PAGES_LIMIT = 50;

/** The generated records, read by a `METHOD path` key built at runtime. */
const OPENAPI_OUTPUTS_BY_ROUTE: Readonly<Record<string, JsonSchema | null>> =
  OPENAPI_OUTPUTS;

const OPENAPI_REDACTED_FIELDS_BY_ROUTE: Readonly<
  Record<string, readonly string[]>
> = OPENAPI_REDACTED_FIELDS;

const idempotencyInput = {
  idempotencyKey: Schema.optionalKey(
    NonEmptyString.annotate({
      description:
        "Stable key for safe retries. If omitted, the MCP server generates a unique key for this call.",
    })
  ),
} satisfies ToolFields;

const paginationInput = {
  maxPages: Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: MAX_PAGES_LIMIT })
    ).annotate({
      description: `Max pages the server auto-fetches and merges (default ${DEFAULT_MAX_PAGES}, hard cap ${MAX_PAGES_LIMIT}). If more remain, the result is marked truncated with a nextCursor to continue.`,
    })
  ),
} satisfies ToolFields;

/**
 * Fold the fields every operation tool shares, meaning query, body, idempotency
 * key, and workspace override, into a request fields, omitting each when absent
 * so the outgoing request never carries `undefined` keys. Path params are the one
 * per-operation piece and are assembled separately by {@link pathParams}.
 */
function commonInput(
  input: LucaToolInput
): Omit<LucaRequestContract, "pathParams"> {
  return {
    ...optionalField("query", input.query),
    ...optionalField("body", input.body),
    ...optionalField("idempotencyKey", input.idempotencyKey),
    workspace: {
      ...optionalField("workspaceId", input.workspaceId),
      ...optionalField("workspaceSlug", input.workspaceSlug),
    },
  };
}

/** The `{name}` placeholders in a route path, in order. */
function pathParamNames(path: string): readonly string[] {
  return Arr.filterMap(Array.from(path.matchAll(/\{([^}]+)\}/g)), ([, key]) =>
    key === undefined ? Result.failVoid : Result.succeed(key)
  );
}

function pathParams(input: LucaToolInput, path: string) {
  return R.fromEntries(
    Arr.filterMap(pathParamNames(path), (key) => {
      const value = input[key];

      return P.isString(value)
        ? Result.succeed([key, value] as const)
        : Result.failVoid;
    })
  );
}

function inputSchemaFor(input: {
  readonly method: LucaMethod;
  readonly path: string;
  readonly idempotencyRequired: boolean;
  readonly confirm: ConfirmGate | undefined;
  readonly paginates: boolean;
}) {
  return {
    ...WORKSPACE_INPUT_FIELDS,
    ...fieldsWhen(input.idempotencyRequired, idempotencyInput),
    ...OPENAPI_INPUT_FIELDS[`${input.method} ${input.path}`],
    ...fieldsWhen(input.confirm !== undefined, confirmInput),
    ...fieldsWhen(input.paginates, paginationInput),
  };
}

/**
 * Build an operation's output schema and, when `redactedFields` is non-empty,
 * attach an `x-luca-redacted-fields` marker to `result` so an MCP client can
 * tell those fields may arrive blanked for a `redacted`-tier key. The marker is
 * an annotation only and never affects validation.
 */
export function outputSchemaFor(input: {
  readonly method: LucaMethod;
  readonly path: string;
  readonly untrustedContent: boolean;
  readonly redactedFields?: readonly string[];
}): ToolFields {
  const fields = openApiToolOutputFields({
    body: OPENAPI_OUTPUTS_BY_ROUTE[`${input.method} ${input.path}`],
    untrustedContent: input.untrustedContent,
  });

  // This guard also runs while `LUCA_OPERATIONS` is built at module
  // initialization. Forcing either half of it makes the second operand read
  // `.length` off an absent `redactedFields`, which throws during import: the
  // test file then fails to collect and reports zero tests, so there is no
  // failing test for the mutation runner to attribute the kill to and it
  // registers as a survivor. The branch itself is real and covered: the absent,
  // empty, and populated cases all assert on the marker.
  // Stryker disable next-line LogicalOperator,BooleanLiteral: crashes at import, leaving no test to attribute the kill to
  if (!input.redactedFields || Arr.isReadonlyArrayEmpty(input.redactedFields)) {
    return fields;
  }

  const result = fields.result ?? Schema.Unknown;

  return {
    ...fields,
    result: result.annotate({
      "x-luca-redacted-fields": input.redactedFields,
    }),
  };
}

/**
 * The group is the id's prefix before the first dot. `op()`'s `id` parameter
 * is typed as {@link LucaOperationId}, so a prefix that doesn't name a real
 * group is a compile-time error at the `op({...})` call site in
 * `catalog.ts`, so a typo'd id never reaches this function. The split below
 * only recovers, at runtime, the value TypeScript already proved is one of
 * `LucaOperationGroup`.
 */
function operationGroupForId(id: LucaOperationId): LucaOperationGroup {
  // SAFETY: `id`'s type is `${LucaOperationGroup}.${string}`, so splitting on
  // the first "." always yields a valid group as the first element.
  const [group] = id.split(".") as [LucaOperationGroup, ...string[]];

  return group;
}

/**
 * The MCP tool name for an operation id: `luca_` plus the id in snake_case,
 * so `analytics.speedImpact` becomes `luca_analytics_speed_impact`. Task
 * tools are named the same way, and one casing across the list is what
 * clients and models see.
 */
function toolNameFor(id: LucaRouteId) {
  return `luca_${id.split(".").map(Str.camelToSnake).join("_")}`;
}

/**
 * Declare one 1:1 operation tool. The route's id says which allowlisted route
 * it is; {@link ROUTE_CATALOG} answers with the method, path, scopes, and
 * idempotency rule the API grants it. `op()` derives the rest uniformly: the
 * `luca_*` tool name, the group that {@link operationGroupForId} reads off the
 * id prefix, the generated input and output schemas
 * ({@link inputSchemaFor}), the required scope tier ({@link requiredScopeFor}),
 * the untrusted-content boundary, and a `buildRequest` that maps tool input to
 * an HTTP request. What stays here is what only the tool surface knows: the
 * title, the agent-facing description, and the confirmation gate. Which fields
 * can come back blanked is read off the route's `sensitive()` markers in
 * {@link OPENAPI_REDACTED_FIELDS}. Task tools (composed, intent-level) are
 * declared separately in `task-tools.ts`.
 */
export function op(input: {
  /**
   * Which allowlisted route this tool is. Everything the route grants, meaning
   * its method, path, scopes, and idempotency rule, is read from
   * {@link ROUTE_CATALOG} rather than restated here.
   */
  readonly id: LucaOperationId;
  /**
   * The short human label a client shows instead of the tool name. Required so
   * a new operation cannot ship with a machine-generated one; `check-registry`
   * rejects a title that reads like the tool id.
   */
  readonly title: string;
  /** Override method-derived semantics for POST actions on existing records. */
  readonly mutatesExisting?: boolean;
  /** Override method-derived behavior for a GET that creates or changes state. */
  readonly readOnly?: boolean;
  /** See {@link LucaOperation.openWorld}. Defaults to false. */
  readonly openWorld?: boolean;
  readonly description: string;
  /**
   * Override the untrusted-content boundary for one operation. Every operation
   * in a group of {@link UNTRUSTED_CONTENT_GROUPS} is framed untrusted by
   * default, whatever its method, because a write can return lead-authored text
   * too (a drafted reply, an echoed lead). Pass `false` for an operation whose
   * response carries none, such as an id and a status. Pass `true` for an
   * operation outside those groups that still returns externally authored text
   * (comment-automation events carry commenter-written
   * `body`/`commenterDisplayName`).
   */
  readonly untrustedContent?: boolean;
  /**
   * Gate a write with a real-world side effect behind `confirm: true`.
   * Absent means the call runs without it.
   */
  readonly confirm?: ConfirmGate;
}) {
  const route = ROUTE_CATALOG[input.id];
  const { method, path, scopes, idempotencyRequired } = route;
  const mutatesExistingRoute = input.mutatesExisting ?? mutatesExisting(method);
  const pageContract = pageContractFor(method, path);
  const group = operationGroupForId(input.id);

  const untrustedContent =
    input.untrustedContent ?? HashSet.has(UNTRUSTED_CONTENT_GROUPS, group);

  const operation: LucaOperation = {
    id: input.id,
    group,
    toolName: toolNameFor(input.id),
    title: input.title,
    method,
    path,
    scopes,
    mutatesExisting: mutatesExistingRoute,
    readOnly: input.readOnly ?? method === "GET",
    idempotencyRequired,
    ...optionalField("confirm", input.confirm),
    openWorld: input.openWorld ?? false,
    ...optionalField("pageContract", pageContract),
    untrustedContent,
    requiredScope: requiredScopeFor({
      method,
      scopes,
      confirm: input.confirm,
      untrustedContent,
    }),
    description: input.description,
    inputSchema: inputSchemaFor({
      method,
      path,
      idempotencyRequired,
      confirm: input.confirm,
      paginates: pageContract !== undefined,
    }),
    outputSchema: outputSchemaFor({
      method,
      path,
      untrustedContent,
      ...optionalField(
        "redactedFields",
        OPENAPI_REDACTED_FIELDS_BY_ROUTE[`${method} ${path}`]
      ),
    }),
    buildRequest: (toolInput) => ({
      pathParams: pathParams(toolInput, path),
      ...commonInput(toolInput),
    }),
  };

  return operation;
}
