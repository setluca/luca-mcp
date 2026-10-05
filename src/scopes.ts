import * as Arr from "effect/Array";
import * as Order from "effect/Order";

import type { CapabilityTier } from "./operations/registry.ts";
/**
 * The OAuth scopes this server advertises, and the API-key scopes each one
 * grants.
 *
 * Two vocabularies meet here. A tool declares the API scopes it needs
 * (`leads:read`, `bookings:write`), which is what Luca's API checks on every
 * request. An OAuth client asks for a capability scope (`luca:draft`), and the
 * authorization server vends a key carrying whatever API scopes that tier
 * covers. Without the mapping below, someone picking scopes for a connection
 * has no way to work out which tools a tier unlocks.
 *
 * This mirrors `LUCA_OAUTH_SCOPES` in `@luca/schemas`
 * (packages/schemas/src/agent-scope.ts) and the tier ladder in
 * `apps/api/src/lib/public-route-policy.ts`. It is copied by hand because this
 * package builds with plain `tsc` and ships as a self-contained npm tarball,
 * so it cannot import a workspace package. Update all three together.
 *
 * The copy is not left to vigilance alone. `unknownApiScopes` fails
 * `docs:generate` when an operation needs an API scope no tier here grants,
 * which is the drift that would actually mislead a reader.
 */

/** Every scope the Worker advertises in its discovery metadata. */
export const LUCA_OAUTH_SCOPES = [
  "luca:read",
  "luca:draft",
  "luca:queue_ops",
  "luca:full",
  "luca:full_content",
  "offline_access",
] as const;

/**
 * The scopes this resource accepts, for the RFC 9728 `scopes_supported` list.
 * `offline_access` asks the authorization server for a refresh token and
 * grants nothing here, so a client that copied it from this list onto its
 * access-token request would be asking the resource for a scope it never checks.
 */
export const LUCA_RESOURCE_SCOPES = Arr.filter(
  LUCA_OAUTH_SCOPES,
  (scope) => scope !== "offline_access"
);

/** Least-privilege default for a new OAuth connection. */
export const OAUTH_DEFAULT_SCOPE = "luca:read luca:draft";

const READ_TIER_SCOPES = [
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
] as const;

/**
 * Writes that change a record without reaching anyone. A call event is the
 * coach's own account of a call that already happened, so recording one sends
 * no message and moves no calendar.
 */
const DRAFT_TIER_SCOPES = [
  ...READ_TIER_SCOPES,
  "call_events:write",
  "insights:write",
  "leads:write",
  "learning:write",
  "memory:write",
] as const;

/**
 * Writes a lead can see. `bookings:write` creates and cancels real calendar
 * events that notify a lead, and `conversations:write` puts a message in front
 * of one without a reviewer seeing it first.
 */
const QUEUE_OPS_TIER_SCOPES = [
  ...DRAFT_TIER_SCOPES,
  "bookings:write",
  "broadcasts:write",
  "cadences:write",
  "campaigns:write",
  "conversations:write",
  "knowledge:write",
  "review_queue:write",
] as const;

/**
 * Account plumbing with external egress. Webhook subscriptions and CRM
 * connections send workspace data to a third-party host, so they sit alone at
 * the top rather than riding along with the lead-visible writes.
 */
const FULL_TIER_SCOPES = [
  ...QUEUE_OPS_TIER_SCOPES,
  "integrations:write",
  "webhooks:write",
] as const;

/** The capability tiers from least to most privilege. */
const CAPABILITY_TIERS = [
  "read",
  "draft",
  "queue_ops",
  "full",
] as const satisfies readonly CapabilityTier[];

/** The OAuth scope a capability tier is requested by. */
export type LucaCapabilityScope = `luca:${CapabilityTier}`;

function scopeForTier(tier: CapabilityTier): LucaCapabilityScope {
  return `luca:${tier}`;
}

/** The capability scopes from least to most privilege. */
export const CAPABILITY_LADDER: readonly LucaCapabilityScope[] =
  CAPABILITY_TIERS.map(scopeForTier);

/**
 * Capability scope to the API scopes it grants. The tiers are strict supersets,
 * so `luca:full` covers everything `luca:queue_ops` does.
 */
export const OAUTH_CAPABILITY_SCOPES: Readonly<
  Record<LucaCapabilityScope, readonly string[]>
> = {
  "luca:read": READ_TIER_SCOPES,
  "luca:draft": DRAFT_TIER_SCOPES,
  "luca:queue_ops": QUEUE_OPS_TIER_SCOPES,
  "luca:full": FULL_TIER_SCOPES,
};

/**
 * The two scopes that grant no API scopes of their own.
 *
 * `luca:full_content` is a second axis rather than a rung on the ladder: it
 * decides whether a vended key reads verbatim lead-message content or a
 * redacted view of it, at whatever tier the capability scope already set.
 * `offline_access` only asks for a refresh token.
 */
export const NON_TIER_OAUTH_SCOPES = {
  "luca:full_content":
    "Read verbatim lead-authored message content. Without it a vended key reads the redacted view. This is a separate axis from the tier, not a higher tier.",
  offline_access:
    "Issue a refresh token so the connection survives past the access token's lifetime. Grants no API scope.",
} as const satisfies Record<string, string>;

/**
 * Every API scope any capability tier grants, which is every scope `luca:full`
 * grants because the tiers nest.
 */
export function allGrantedApiScopes(): readonly string[] {
  return OAUTH_CAPABILITY_SCOPES["luca:full"];
}

/** Whether a capability scope grants `apiScope`. */
export function tierGrants(
  scope: LucaCapabilityScope,
  apiScope: string
): boolean {
  return Arr.contains(OAUTH_CAPABILITY_SCOPES[scope], apiScope);
}

/** A capability scope's position on the ladder, `0` for `luca:read`. */
export function capabilityRank(scope: LucaCapabilityScope): number {
  return CAPABILITY_LADDER.indexOf(scope);
}

/**
 * The lowest capability scope that grants `apiScope`, or `undefined` when no
 * tier grants it. Reading the ladder from the bottom is what makes the answer
 * the least-privilege one rather than merely a correct one.
 */
export function lowestCapabilityScopeFor(
  apiScope: string
): LucaCapabilityScope | undefined {
  return CAPABILITY_LADDER.find((scope) => tierGrants(scope, apiScope));
}

/** The higher of two capability scopes. */
function higherCapabilityScope(
  left: LucaCapabilityScope,
  right: LucaCapabilityScope
): LucaCapabilityScope {
  return capabilityRank(left) >= capabilityRank(right) ? left : right;
}

/** The operation fields that decide which OAuth scope can call it. */
export type ScopedOperation = {
  readonly scopes: readonly string[];
  readonly requiredScope: { readonly capability: CapabilityTier };
};

/**
 * The least-privilege capability tier that lets an OAuth connection call an
 * operation. Two rules apply, and the answer is the higher of the two:
 *
 * - The API accepts a key holding any one of the route's API scopes
 *   (`apps/api/src/middleware/api-access.ts` checks `policy.scopes.some`), and
 *   the tiers nest, so the lowest tier granting any of them is enough.
 * - The tier the operation's own effect asks for (`requiredScope.capability`),
 *   which the API checks once agent-scope enforcement is on.
 *
 * An operation whose API scopes no tier grants needs `full`. `docs:generate`
 * already fails on that drift, so the fallback only keeps the answer
 * conservative.
 */
export function effectiveCapability(
  operation: ScopedOperation
): CapabilityTier {
  const routeTier =
    CAPABILITY_TIERS.find((tier) =>
      operation.scopes.some((apiScope) =>
        tierGrants(scopeForTier(tier), apiScope)
      )
    ) ?? "full";

  return CAPABILITY_TIERS.indexOf(routeTier) >=
    CAPABILITY_TIERS.indexOf(operation.requiredScope.capability)
    ? routeTier
    : operation.requiredScope.capability;
}

/** The OAuth scope that requests {@link effectiveCapability}. */
export function oauthScopeForOperation(
  operation: ScopedOperation
): LucaCapabilityScope {
  return scopeForTier(effectiveCapability(operation));
}

/**
 * The least-privilege capability scope for a task tool: the highest scope any
 * operation it composes needs, because the tool runs all of them.
 */
export function oauthScopeForTool(
  operations: readonly ScopedOperation[]
): LucaCapabilityScope {
  return Arr.reduce(operations, scopeForTier("read"), (scope, operation) =>
    higherCapabilityScope(scope, oauthScopeForOperation(operation))
  );
}

/**
 * API scopes the operations need that no capability tier grants, sorted and
 * deduplicated.
 *
 * A non-empty result means an OAuth client cannot reach those tools no matter
 * which scope it asks for, and that the ladder above has fallen behind
 * `apps/api`. `docs:generate` fails on it rather than publishing a scope table
 * with a hole in it.
 */
export function unknownApiScopes(
  operations: readonly { readonly scopes: readonly string[] }[]
): readonly string[] {
  const granted = allGrantedApiScopes();

  const unknown = Arr.filter(
    Arr.flatMap(operations, (operation) => operation.scopes),
    (scope) => !Arr.contains(granted, scope)
  );

  return Arr.sort(Arr.dedupe(unknown), Order.String);
}
