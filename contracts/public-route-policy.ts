import { type CapabilityTier, OBJECTION_BUCKETS } from "@luca/schemas";
import type { PublicApiOperation } from "@luca/schemas/api";
import { BookingProvider, CrmProviderSchema } from "@luca/schemas/api";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

import { analyticsPolicies } from "./route-policies/analytics";
import { bookingPolicies } from "./route-policies/bookings";
import { broadcastPolicies } from "./route-policies/broadcasts";
import { cadencePolicies } from "./route-policies/cadences";
import { callEventPolicies } from "./route-policies/call-events";
import { campaignPolicies } from "./route-policies/campaigns";
import { capabilitiesPolicies } from "./route-policies/capabilities";
import { channelPolicies } from "./route-policies/channels";
import { coachPolicies } from "./route-policies/coach";
import { conversationPolicies } from "./route-policies/conversations";
import { insightPolicies } from "./route-policies/insights";
import { integrationPolicies } from "./route-policies/integrations";
import { knowledgePolicies } from "./route-policies/knowledge";
import { leadPolicies } from "./route-policies/leads";
import { learningPolicies } from "./route-policies/learning";
import { memoryPolicies } from "./route-policies/memory";
import type { PublicApiAccessPolicy } from "./route-policies/policy";
import { isSafeMethod, requiredScopeForPolicy } from "./route-policies/policy";
import { reportPolicies } from "./route-policies/reports";
import { reviewQueuePolicies } from "./route-policies/review-queue";
import { safetyPolicies } from "./route-policies/safety";
import { usagePolicies } from "./route-policies/usage";
import { voicePolicies } from "./route-policies/voice";
import { wallFor } from "./route-policies/walls";
import { webhookPolicies } from "./route-policies/webhooks";
import type { PlatformLimitSubject } from "./usage-cap";

export type { PublicApiAccessPolicy } from "./route-policies/policy";

export { requiredScopeForPolicy } from "./route-policies/policy";

const PLATFORM_LIMIT_EXEMPT_PATHS = [
  /^\/api\/billing(?:\/|$)/,
  /^\/api\/copilot\/settings(?:\/|$)/,
  /^\/api\/usage(?:\/|$)/,
  /^\/api\/capabilities(?:\/|$)/,
  /^\/api\/workspaces(\/overview)?\/?$/,
  /^\/api\/members\/invitations\/[^/]+(\/(accept|decline))?\/?$/,
];

const UUID_SEGMENT =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

const EVENT_ID_SEGMENT = "[^/]+";

const oneOf = (values: readonly string[]) => `(?:${values.join("|")})`;

// oxlint-disable-next-line anti-slop/no-known-value-widening -- routePath() below looks this up by whatever {param} name a route template names, an arbitrary string it pulls from a regex match, not one of these literal keys; the lookup has to stay open so a template naming an unregistered parameter throws at module load (see the throw a few lines down) instead of failing to compile.
const PARAM_SEGMENTS: Readonly<Record<string, string>> = {
  actionId: UUID_SEGMENT,
  attendeeId: UUID_SEGMENT,
  bookingId: UUID_SEGMENT,
  chatId: UUID_SEGMENT,
  deliveryId: UUID_SEGMENT,
  enrollmentId: UUID_SEGMENT,
  eventId: EVENT_ID_SEGMENT,
  failureId: UUID_SEGMENT,
  id: UUID_SEGMENT,
  leadId: UUID_SEGMENT,
  mediaId: UUID_SEGMENT,
  messageId: UUID_SEGMENT,
  noteId: UUID_SEGMENT,
  simulationId: UUID_SEGMENT,
  threadId: UUID_SEGMENT,
  turnId: UUID_SEGMENT,
  provider: oneOf([...BookingProvider.options, ...CrmProviderSchema.options]),
  type: oneOf(OBJECTION_BUCKETS),
};

const PATH_TEMPLATE_SEGMENT = /^\{(\w+)\}$/;

function routePath(template: string): RegExp {
  const source = template
    .replace(/^\/api\//, "")
    .split("/")
    .map((segment) => {
      const parameter = PATH_TEMPLATE_SEGMENT.exec(segment)?.[1];

      if (!parameter) {
        return segment.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }

      const pattern = PARAM_SEGMENTS[parameter];

      if (!pattern) {
        // oxlint-disable-next-line effect/avoid-untagged-errors -- raw failure on an invariant or interop path; not a caller-recoverable domain failure
        throw new Error(
          `Route template ${template} names an unknown parameter {${parameter}}. Add it to PARAM_SEGMENTS with the segment shape it is allowed to match.`
        );
      }

      return pattern;
    })
    .join("/");

  // fallow-ignore-next-line security-sink -- the pattern is built only from checked-in route templates
  return new RegExp(`^/api/${source}/?$`);
}

const CAMPAIGN_PUBLISH_PATH = routePath("/api/campaigns/{id}/publish");

const BROADCAST_LAUNCH_PATH = routePath("/api/broadcasts/{id}/launch");

const LEAD_IMPORT_APPLY_PATH = routePath("/api/leads/imports/apply");

const COPILOT_PATH = /^\/api\/copilot(?:\/|$)/;

const COPILOT_TOKEN_PATH = routePath("/api/copilot/chats/{chatId}/token");

const apiKeyPolicies: PublicApiAccessPolicy[] = [
  ...capabilitiesPolicies,
  ...leadPolicies,
  ...conversationPolicies,
  ...reviewQueuePolicies,
  ...bookingPolicies,
  ...callEventPolicies,
  ...campaignPolicies,
  ...broadcastPolicies,
  ...webhookPolicies,
  ...integrationPolicies,
  ...voicePolicies,
  ...coachPolicies,
  ...usagePolicies,
  ...safetyPolicies,
  ...channelPolicies,
  ...reportPolicies,
  ...insightPolicies,
  ...learningPolicies,
  ...knowledgePolicies,
  ...memoryPolicies,
  ...cadencePolicies,
  ...analyticsPolicies,
];

Arr.forEach(apiKeyPolicies, (policy) => {
  const wall = wallFor(policy.method, policy.path);

  if (wall) {
    // oxlint-disable-next-line effect/avoid-untagged-errors -- raw failure on an invariant or interop path; not a caller-recoverable domain failure
    throw new Error(
      `${policy.method} ${policy.path} (${policy.id}) reaches ${wall.subject}, which no API key may write. ${wall.reason}`
    );
  }
});

const READ_TIER_SCOPES: readonly string[] = [
  "analytics:read",
  "bookings:read",
  "broadcasts:read",
  "call_events:read",
  "campaigns:read",
  "channels:read",
  "coach:read",
  "conversations:read",
  "integrations:read",
  "knowledge:read",
  "leads:read",
  "learning:read",
  "memory:read",
  "reports:read",
  "review_queue:read",
  "safety:read",
  "usage:read",
  "voice:read",
  "webhooks:read",
];

const DRAFT_TIER_SCOPES: readonly string[] = [
  ...READ_TIER_SCOPES,
  "call_events:write",
  "insights:write",
  "leads:write",
  "learning:write",
  "memory:write",
];

const QUEUE_OPS_TIER_SCOPES: readonly string[] = [
  ...DRAFT_TIER_SCOPES,
  "bookings:write",
  "broadcasts:write",
  "cadences:write",
  "campaigns:write",
  "conversations:write",
  "knowledge:write",
  "review_queue:write",
];

const FULL_TIER_SCOPES: readonly string[] = [
  ...QUEUE_OPS_TIER_SCOPES,
  "channels:write",
  "integrations:write",
  "webhooks:write",
];

const TIER_SCOPES = {
  read: READ_TIER_SCOPES,
  draft: DRAFT_TIER_SCOPES,
  queue_ops: QUEUE_OPS_TIER_SCOPES,
  full: FULL_TIER_SCOPES,
} satisfies Record<CapabilityTier, readonly string[]>;

/**
 * Scopes that return verbatim lead-message content, excluded from vended keys
 * unless the connection was granted `luca:full_content`. Empty today: no
 * redacted alternative exists yet for conversation reads, so the data-
 * sensitivity axis is enforced by the gated data-sensitivity work, not by scope removal
 * (spec §3.3 documents the limitation).
 */
export const REDACTED_EXCLUDED_SCOPES: readonly string[] = [];

export function apiKeyScopesForCapabilityTier(
  tier: CapabilityTier
): readonly string[] {
  return TIER_SCOPES[tier];
}

const compiledPolicies = apiKeyPolicies.map((policy) => ({
  policy,
  pattern: routePath(policy.path),
}));

function anyOption(name: string, options: readonly string[]): string {
  const option = options[0];

  if (option === undefined) {
    // oxlint-disable-next-line effect/avoid-untagged-errors -- raw failure on an invariant or interop path; not a caller-recoverable domain failure
    throw new Error(`${name} has no options to sample a route segment from`);
  }

  return option;
}

// oxlint-disable-next-line anti-slop/no-known-value-widening -- samplePublicApiPath() below looks this up by whatever {param} name a route template names, an arbitrary string captured by regex, not one of these literal keys; a name this table has no sample for falls back to UUID_SAMPLE below rather than needing every entry enumerated here.
const PARAM_SAMPLES: Readonly<Record<string, string>> = {
  provider: anyOption("BookingProviderSchema", BookingProvider.options),
  type: anyOption("OBJECTION_BUCKETS", OBJECTION_BUCKETS),
};

const UUID_SAMPLE = "00000000-0000-4000-8000-000000000000";

/**
 * The concrete request path a `{param}` route template stands for, for anything
 * that needs to ask {@link findPublicApiAccessPolicy} about a documented route
 * rather than a live request.
 *
 * The substitution has to satisfy the same {@link PARAM_SEGMENTS} the matcher
 * is built from. A placeholder outside that shape fails the pattern, and the
 * route reads as unreachable when a key reaches it fine. That drift is
 * invisible in review, so the substitution lives here, beside the table it has
 * to satisfy, instead of in each caller.
 */
export function samplePublicApiPath(template: string): string {
  return template.replaceAll(
    /\{(\w+)\}/g,
    (_match, parameter: string) => PARAM_SAMPLES[parameter] ?? UUID_SAMPLE
  );
}

/** Every allowlist entry, for the registries derived from it. */
export function publicApiAccessPolicies(): readonly PublicApiAccessPolicy[] {
  return apiKeyPolicies;
}

export function findPublicApiAccessPolicy(method: string, path: string) {
  return compiledPolicies.find(
    (entry) => entry.policy.method === method && entry.pattern.test(path)
  )?.policy;
}

/**
 * Every route an API key can reach, as the developer documentation and
 * `GET /api/capabilities` describe it.
 *
 * Derived from the allowlist rather than declared beside it. The two used to
 * be separate lists, and the documented one fell 93 routes behind the one that
 * actually grants access — a key could reach a route the docs never mentioned.
 * One definition means that cannot happen again.
 */
export const PUBLIC_API_OPERATIONS: PublicApiOperation[] = apiKeyPolicies.map(
  (policy) => ({
    id: policy.id,
    method: policy.method,
    path: policy.path,
    scopes: policy.scopes,
    idempotencyRequired: policy.requireIdempotency ?? false,
    description: policy.description,
  })
);

export const PUBLIC_API_SCOPES = Arr.sort(
  [
    ...Arr.dedupe(
      PUBLIC_API_OPERATIONS.flatMap((operation) => operation.scopes)
    ),
  ],
  Order.String
);

export type PublicApiAccessPolicyEntry = {
  /** Stable operation id. The key setluca/luca-mcp declares its tools against. */
  id: string;
  method: string;
  path: string;
  scopes: string[];
  requireIdempotency?: boolean;
  /** The lowest key tier the route admits. setluca/luca-mcp pins each tool's tier to it. */
  requiredScope: { capability: CapabilityTier };
};

/**
 * Serializable view of the API-key allowlist for cross-workspace drift
 * checks (see setluca/luca-mcp scripts/check-openapi.ts). The route is emitted as its
 * OpenAPI path template, which is the same key the snapshot and the MCP
 * catalog use, so a consumer compares templates instead of reconstructing a
 * regex. The operation id travels with it: setluca/luca-mcp generates its route
 * catalog from this file, so every tool's method, path, scopes, idempotency
 * rule, and required capability tier are read from here rather than written
 * out a second time. A route without a declared tier serializes as `read`, the
 * same tier `requireApiKeyScope` enforces for it.
 * Kept in sync via apps/api scripts/api-key-policies.ts, which fails CI on
 * drift.
 */
export function publicApiAccessPolicySnapshot(): PublicApiAccessPolicyEntry[] {
  return apiKeyPolicies.map((policy) => ({
    id: policy.id,
    method: policy.method,
    path: policy.path,
    scopes: policy.scopes,
    ...(policy.requireIdempotency ? { requireIdempotency: true } : undefined),
    requiredScope: { capability: requiredScopeForPolicy(policy).capability },
  }));
}

export type PlatformLimitPolicy =
  | { readonly limited: false }
  | { readonly limited: true; readonly subject: PlatformLimitSubject };

/**
 * Central route policy for public API write limiting. Middleware asks this
 * Module what a request means; usage-cap logic decides whether the Coach's
 * plan can perform that subject.
 */
export function platformLimitPolicyForRoute(input: {
  method: string;
  path: string;
}): PlatformLimitPolicy {
  if (
    isSafeMethod(input.method) ||
    COPILOT_TOKEN_PATH.test(input.path) ||
    PLATFORM_LIMIT_EXEMPT_PATHS.some((pattern) => pattern.test(input.path))
  ) {
    return { limited: false };
  }

  return { limited: true, subject: subjectForPath(input.path) };
}

function subjectForPath(path: string): PlatformLimitSubject {
  if (CAMPAIGN_PUBLISH_PATH.test(path)) {
    return "campaign_publish";
  }

  if (BROADCAST_LAUNCH_PATH.test(path)) {
    return "broadcast_launch";
  }

  if (LEAD_IMPORT_APPLY_PATH.test(path)) {
    return "lead_import";
  }

  if (COPILOT_PATH.test(path)) {
    return "ai_send";
  }

  return "api_write";
}
