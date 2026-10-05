import * as Arr from "effect/Array";
import * as MutableHashSet from "effect/MutableHashSet";
import { z } from "zod";

/**
 * Two-dimensional scope model for agent/API-key access. A key carries a
 * granted (capability, dataSensitivity) pair; each tool/route declares the pair
 * it requires; a call is allowed only when the granted tiers meet or exceed the
 * required ones.
 *
 * This is the shared vocabulary. Enforcement against real Better Auth key
 * claims (plus the migration/backfill it needs) is the decision-gated remainder
 * of this model — see docs/agent-scope-model.md.
 */

/** What a key may do, from least to most powerful. */
export const CapabilityTierSchema = z.enum([
  "read", // see data
  "draft", // create drafts/proposals and reversible records
  "queue_ops", // operate the live queue: send, enroll, replay
  "full", // everything the underlying key scope allows
]);

export type CapabilityTier = z.infer<typeof CapabilityTierSchema>;

/** How much of a lead's content a key may see. */
export const DataSensitivityTierSchema = z.enum([
  "redacted", // metadata and summaries only, no verbatim external-user text
  "full_content", // verbatim conversation/lead text
]);

export type DataSensitivityTier = z.infer<typeof DataSensitivityTierSchema>;

/** The capability ladder, least privilege first. Order is the whole meaning. */
export const CAPABILITY_ORDER: readonly CapabilityTier[] = [
  "read",
  "draft",
  "queue_ops",
  "full",
];

/** The sensitivity ladder, least revealing first. Order is the whole meaning. */
export const DATA_SENSITIVITY_ORDER: readonly DataSensitivityTier[] = [
  "redacted",
  "full_content",
];

/** The default a newly minted agent key gets: least-privilege. */
export const DEFAULT_CAPABILITY_TIER: CapabilityTier = "read";

export const DEFAULT_DATA_SENSITIVITY_TIER: DataSensitivityTier = "redacted";

export type RequiredScope = {
  readonly capability: CapabilityTier;
  readonly dataSensitivity: DataSensitivityTier;
};

export type GrantedScope = RequiredScope;

export function capabilitySatisfies(
  granted: CapabilityTier,
  required: CapabilityTier
): boolean {
  return (
    CAPABILITY_ORDER.indexOf(granted) >= CAPABILITY_ORDER.indexOf(required)
  );
}

export function dataSensitivitySatisfies(
  granted: DataSensitivityTier,
  required: DataSensitivityTier
): boolean {
  return (
    DATA_SENSITIVITY_ORDER.indexOf(granted) >=
    DATA_SENSITIVITY_ORDER.indexOf(required)
  );
}

/** True when a granted scope meets both required tiers. Fails closed. */
export function scopeSatisfies(
  granted: GrantedScope,
  required: RequiredScope
): boolean {
  return (
    capabilitySatisfies(granted.capability, required.capability) &&
    dataSensitivitySatisfies(granted.dataSensitivity, required.dataSensitivity)
  );
}

/**
 * OAuth scope strings for the MCP authorization server (spec §3.3 of
 * docs/runbooks/mcp-oauth-authorization-server.md). `offline_access` gates
 * refresh tokens; the `luca:*` scopes map 1:1 to the agent-scope tiers above.
 * `openid`/`profile`/`email` are intentionally absent — Luca's AS issues no
 * id_tokens and discloses no PII (spec §7.7).
 */
export const LUCA_OAUTH_SCOPES = [
  "offline_access",
  "luca:read",
  "luca:draft",
  "luca:queue_ops",
  "luca:full",
  "luca:full_content",
] as const;

export type LucaOauthScope = (typeof LUCA_OAUTH_SCOPES)[number];

/** Least-privilege default for new OAuth connections. */
export const OAUTH_DEFAULT_SCOPE = "luca:read luca:draft";

const SCOPE_TO_CAPABILITY = {
  "luca:read": "read",
  "luca:draft": "draft",
  "luca:queue_ops": "queue_ops",
  "luca:full": "full",
} satisfies Record<string, CapabilityTier>;

const CapabilityScopeSchema = z.enum([
  "luca:read",
  "luca:draft",
  "luca:queue_ops",
  "luca:full",
]);

/**
 * The highest capability tier granted by a set of OAuth scopes, or null when
 * no luca capability scope is present (deny — never default upward).
 */
export function capabilityTierFromOauthScopes(
  scopes: readonly string[]
): CapabilityTier | null {
  let highest: CapabilityTier | null = null;

  Arr.forEach(scopes, (scope) => {
    const parsedScope = CapabilityScopeSchema.safeParse(scope);

    const tier = parsedScope.success
      ? SCOPE_TO_CAPABILITY[parsedScope.data]
      : undefined;

    if (
      tier &&
      // Equal indices mean tier === highest (indexOf is unique), so promoting
      // `>` to `>=` only re-assigns the same value — an unobservable no-op.
      // Stryker disable next-line ConditionalExpression: forcing this
      // sub-condition to false is unobservable too. `tier` only ever holds a
      // real CapabilityTier looked up from SCOPE_TO_CAPABILITY, so
      // CAPABILITY_ORDER.indexOf(tier) is always >= 0, while
      // CAPABILITY_ORDER.indexOf(highest) is -1 exactly when highest is
      // still null. The right-hand comparison alone already evaluates to
      // true on the first iteration for the same reason the short-circuit
      // would have taken — the two paths never disagree.
      (highest === null ||
        // Stryker disable next-line EqualityOperator: equal indices re-assign the same tier, an unobservable no-op
        CAPABILITY_ORDER.indexOf(tier) > CAPABILITY_ORDER.indexOf(highest))
    ) {
      highest = tier;
    }
  });

  return highest;
}

/** True when the scope set grants verbatim message content. */
export function hasFullContentScope(scopes: readonly string[]): boolean {
  return scopes.includes("luca:full_content");
}

/**
 * The granted tiers stored on a key's `metadata.luca`. Absent or malformed ⇒
 * `(full, redacted)`: existing keys keep their capability (grandfathered) but
 * receive no verbatim PII until re-minted with an explicit `full_content` grant.
 * This is the read-time default that makes a destructive backfill unnecessary.
 */
export function resolveGrantedScope(
  tiers:
    | { capabilityTier?: unknown; dataSensitivityTier?: unknown }
    | null
    | undefined
): GrantedScope {
  const capability = CapabilityTierSchema.safeParse(tiers?.capabilityTier);

  const dataSensitivity = DataSensitivityTierSchema.safeParse(
    tiers?.dataSensitivityTier
  );

  return {
    capability: capability.success ? capability.data : "full",
    dataSensitivity: dataSensitivity.success
      ? dataSensitivity.data
      : "redacted",
  };
}

/**
 * Tiers for a developer key, derived from its requested resource scopes. These
 * keys are minted by the coach for their own workspace, so they carry
 * `full_content`; capability is `read` for a read-only key and `full` once any
 * write scope is present. (Vended OAuth agent keys derive tiers from
 * {@link capabilityTierFromOauthScopes}/{@link hasFullContentScope} instead and
 * default to `redacted`.)
 */
export function developerScopesToTiers(
  scopes: readonly string[]
): GrantedScope {
  const hasWrite = scopes.some((scope) => scope.endsWith(":write"));

  return {
    capability: hasWrite ? "full" : "read",
    dataSensitivity: "full_content",
  };
}

const CONSENT_CATALOG: readonly LucaOauthScope[] = [
  "luca:read",
  "luca:draft",
  "luca:queue_ops",
  "luca:full",
  "luca:full_content",
];

/**
 * The checkbox list for the consent screen: the client's requested scopes
 * intersected with the luca catalog, with `luca:read` always present as the
 * required baseline. Order follows the catalog (least → most privileged).
 */
export function oauthScopesForConsent(
  requested: readonly string[]
): LucaOauthScope[] {
  const requestedSet = MutableHashSet.fromIterable(requested);
  MutableHashSet.add(requestedSet, "luca:read");

  return CONSENT_CATALOG.filter((scope) =>
    MutableHashSet.has(requestedSet, scope)
  );
}
