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
import { isSafeMethod } from "./route-policies/policy";
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
  /^\/api\/copilot\/packs(?:\/|$)/,
  /^\/api\/usage(?:\/|$)/,
  /^\/api\/capabilities(?:\/|$)/,
  /^\/api\/workspaces\/?$/,
  /^\/api\/members\/invitations\/[^/]+\/(accept|decline)\/?$/,
];

/**
 * A path segment that is a real record id, not a sibling route name.
 *
 * A collection whose `{id}` route is allowlisted as `[^/]+` also grants every
 * literal route sitting beside it, because a route name is a valid `[^/]+`.
 * That grant is invisible in review: nothing in the diff mentions the sibling.
 * Bookings carries a dozen (`/availability`, `/types`, `/providers`, …).
 * Conversations carries `/export`, which returns every lead name and every
 * verbatim message body in the workspace, unredacted — a grant no reviewer of
 * "read one conversation" would expect to be handing out.
 */
const UUID_SEGMENT =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

const EVENT_ID_SEGMENT = "[^/]+";

const oneOf = (values: readonly string[]) => `(?:${values.join("|")})`;

/**
 * What each `{param}` a route template can name is allowed to match.
 *
 * A record id is UUID-shaped. A provider or an objection bucket is one of a
 * closed set the schema already declares, so the segment pattern comes from
 * the same enum the handler validates against and cannot drift from it.
 *
 * A template naming a parameter that is missing here throws at module load.
 * That is the point: an allowlist entry can only be written as a template, and
 * a template can only expand through this table, so `[^/]+` — the thing that
 * silently granted every literal sibling — is no longer expressible.
 */
// oxlint-disable-next-line anti-slop/no-known-value-widening -- routePath() below looks this up by whatever {param} name a route template names, an arbitrary string it pulls from a regex match, not one of these literal keys; the lookup has to stay open so a template naming an unregistered parameter throws at module load (see the throw a few lines down) instead of failing to compile.
const PARAM_SEGMENTS: Readonly<Record<string, string>> = {
  actionId: UUID_SEGMENT,
  attendeeId: UUID_SEGMENT,
  bookingId: UUID_SEGMENT,
  chatId: UUID_SEGMENT,
  deliveryId: UUID_SEGMENT,
  enrollmentId: UUID_SEGMENT,
  // Webhook event ids are opaque text (`evt_...` today, with callers allowed
  // to provide their own stable ids). The replay route has an extra literal
  // `/replay` segment, so this cannot grant the sibling bulk-replay route.
  eventId: EVENT_ID_SEGMENT,
  id: UUID_SEGMENT,
  leadId: UUID_SEGMENT,
  mediaId: UUID_SEGMENT,
  messageId: UUID_SEGMENT,
  noteId: UUID_SEGMENT,
  simulationId: UUID_SEGMENT,
  threadId: UUID_SEGMENT,
  // Both booking and CRM routes name their parameter `provider`, so the
  // segment accepts either vocabulary. Every name in it is a literal the
  // handler recognises, which is what keeps it from matching a sibling route.
  provider: oneOf([...BookingProvider.options, ...CrmProviderSchema.options]),
  type: oneOf(OBJECTION_BUCKETS),
};

const PATH_TEMPLATE_SEGMENT = /^\{(\w+)\}$/;

/**
 * The request paths a route template stands for.
 *
 * `routePath("/api/bookings/{id}/outcome")` matches that one route and nothing
 * beside it. Every literal segment is matched verbatim and every parameter
 * through {@link PARAM_SEGMENTS}.
 */
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

  // Every piece of this source is a checked-in constant: the map above escapes
  // each literal segment, and a {param} only expands through PARAM_SEGMENTS,
  // which throws on a name it does not carry. No request data reaches it.
  // fallow-ignore-next-line security-sink -- the pattern is built only from checked-in route templates
  return new RegExp(`^/api/${source}/?$`);
}

const CAMPAIGN_PUBLISH_PATH = routePath("/api/campaigns/{id}/publish");

const BROADCAST_LAUNCH_PATH = routePath("/api/broadcasts/{id}/launch");

const LEAD_IMPORT_APPLY_PATH = routePath("/api/leads/imports/apply");

const COPILOT_PATH = /^\/api\/copilot(?:\/|$)/;

const COPILOT_TOKEN_PATH = routePath("/api/copilot/chats/{chatId}/token");

/**
 * Every public API route, in the order the groups are declared. The entries
 * themselves live one file per domain under `route-policies/`, so adding a
 * route stays a one-entry edit in the file its group already owns. Order does
 * not decide a match: a template can only expand through {@link PARAM_SEGMENTS},
 * so no two entries can match the same request path, and the consistency test
 * asserts that from both sides.
 */
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

/**
 * A walled subject is protected by a rule, not by remembering to leave its
 * routes out, so allowlisting one is a state this module will not load in.
 * The failure is loud on purpose: a route that writes the coach profile or the
 * voice corpus under a key is the one mistake here that nothing downstream
 * would catch, because the request would look ordinary all the way through.
 */
Arr.forEach(apiKeyPolicies, (policy) => {
  const wall = wallFor(policy.method, policy.path);

  if (wall) {
    // oxlint-disable-next-line effect/avoid-untagged-errors -- raw failure on an invariant or interop path; not a caller-recoverable domain failure
    throw new Error(
      `${policy.method} ${policy.path} (${policy.id}) reaches ${wall.subject}, which no API key may write. ${wall.reason}`
    );
  }
});

/**
 * Capability tier → developer-API-key scopes granted to an OAuth vended key
 * (docs/runbooks/mcp-oauth-authorization-server.md §3.3). Tiers are strict
 * supersets; the drift tests in test/oauth-tier-permissions.test.ts pin every
 * apiKeyPolicies scope to a tier so a new public route can never silently
 * escape tier gating.
 *
 * Classification: `:read` scopes → read. `leads:write` (lead upsert, notes,
 * consents, field definitions — reversible CRM records) → draft. Live-queue
 * operations (booking calls, campaign enrollment, broadcast launch,
 * publishing a campaign, sending a message by hand) → queue_ops. Account
 * plumbing with external egress (webhook subscriptions and replays, CRM
 * connections and syncs) is deliberately full-only.
 */
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

/**
 * Writes that change a record without reaching anyone. A call event is the
 * coach's own account of a call that already happened, so recording one sends
 * no message and moves no calendar. `bookings:write` sits a tier up for the
 * opposite reason: it creates and cancels real calendar events that notify a
 * lead.
 */
const DRAFT_TIER_SCOPES: readonly string[] = [
  ...READ_TIER_SCOPES,
  "call_events:write",
  "insights:write",
  "leads:write",
  "learning:write",
  "memory:write",
];

/**
 * `conversations:write` sits here rather than a tier down with the record
 * edits because it puts a message in front of a real lead without a reviewer
 * seeing it first.
 */
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

/**
 * The compiled matcher for every allowlist entry, in declaration order.
 *
 * `findPublicApiAccessPolicy` takes the first hit, so order still decides
 * between two entries that both match. Two entries can no longer overlap by
 * accident, though: a template only matches its own literal segments, so a
 * sibling route name is not a valid parameter segment.
 */
const compiledPolicies = apiKeyPolicies.map((policy) => ({
  policy,
  pattern: routePath(policy.path),
}));

/**
 * Any one member of an enum, for a sample path that only has to satisfy the
 * matcher. Reading it off the schema rather than writing the value here is what
 * keeps the sample valid when the enum changes; an enum that lost every member
 * would make the sample unsatisfiable, so it fails loudly instead.
 */
function anyOption(name: string, options: readonly string[]): string {
  const option = options[0];

  if (option === undefined) {
    // oxlint-disable-next-line effect/avoid-untagged-errors -- raw failure on an invariant or interop path; not a caller-recoverable domain failure
    throw new Error(`${name} has no options to sample a route segment from`);
  }

  return option;
}

/** A concrete segment each `{param}` stands for, matching {@link PARAM_SEGMENTS}. */
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
  /** Stable operation id. The key apps/mcp declares its tools against. */
  id: string;
  method: string;
  path: string;
  scopes: string[];
  requireIdempotency?: boolean;
};

/**
 * Serializable view of the API-key allowlist for cross-workspace drift
 * checks (see apps/mcp scripts/check-openapi.ts). The route is emitted as its
 * OpenAPI path template, which is the same key the snapshot and the MCP
 * catalog use, so a consumer compares templates instead of reconstructing a
 * regex. The operation id travels with it: apps/mcp generates its route
 * catalog from this file, so every tool's method, path, scopes, and
 * idempotency rule are read from here rather than written out a second time.
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
