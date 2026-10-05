import * as Arr from "effect/Array";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Schema from "effect/Schema";

import { LUCA_OPERATIONS } from "../src/operations.ts";
import { JsonValue } from "../src/serialization.ts";
import { exitWith, isEntryPoint, runScript } from "./lib/script.ts";
import {
  type ApiKeyPolicyEntry,
  loadApiKeyPolicies,
  loadOpenApi,
} from "./load-openapi.ts";

export type Operation = (typeof LUCA_OPERATIONS)[number];

const decodeOpenApiPaths = Schema.decodeUnknownEffect(
  Schema.Struct({
    paths: Schema.optionalKey(
      Schema.Record(Schema.String, Schema.Record(Schema.String, JsonValue))
    ),
  })
);

function existsInOpenApi(
  operation: Operation,
  paths: Record<string, Record<string, JsonValue>> | undefined
): boolean {
  return Boolean(paths?.[operation.path]?.[operation.method.toLowerCase()]);
}

export type OptOutRoute = {
  /** The allowlisted operation id that deliberately has no MCP tool. */
  readonly id: string;
  readonly reason: string;
};

/**
 * Allowlisted routes we deliberately do not expose over MCP. Every route
 * `apps/api/api-key-policies.json` grants an API key must either have a
 * matching `op()` under `src/operations/groups/`, or a reasoned entry here.
 * The reverse pass below fails otherwise. Keep this list as short as it can be:
 * it exists to force a decision on a new route, not to store old ones.
 *
 * Dashboard-only aggregate routes can opt out when exposing them would add a
 * tool that does not belong to the public MCP surface.
 */
export const OPT_OUT_ROUTES: readonly OptOutRoute[] = [
  {
    id: "conversations.summary",
    reason:
      "Dashboard-only aggregate; MCP clients can use conversations.list for conversation data.",
  },
  {
    id: "conversations.profile_refresh",
    reason:
      "Dashboard maintenance action; the photo URL it refreshes is redacted for API keys, so an MCP client gains nothing from it.",
  },
  {
    id: "reviewQueue.composer",
    reason:
      "Dashboard-only composer capabilities; MCP clients can use reviewQueue.list and conversations.send for review work.",
  },
  {
    id: "integrations.crm.oauthCallback",
    reason:
      "The browser redirect from the CRM's consent screen calls it with a one-time code; an agent never holds that code.",
  },
  {
    id: "integrations.crm.webhooks.record",
    reason:
      "The CRM provider calls it with its own events; an agent recording one would plant a fake provider event.",
  },
];

export type OpenApiCoverageResult = {
  readonly missingFromOpenApi: readonly string[];
  readonly allowlistRoutesWithoutOperation: readonly string[];
  /** Opt-outs an operation now covers, or that name no allowlist entry. */
  readonly staleOptOuts: readonly string[];
};

export function hasFailures(result: OpenApiCoverageResult): boolean {
  return (
    Arr.isReadonlyArrayNonEmpty(result.missingFromOpenApi) ||
    Arr.isReadonlyArrayNonEmpty(result.allowlistRoutesWithoutOperation) ||
    Arr.isReadonlyArrayNonEmpty(result.staleOptOuts)
  );
}

/**
 * Checks the MCP operation table against the Luca OpenAPI document and the
 * API-key allowlist:
 *
 * - Forward (per operation): the route the tool names exists in OpenAPI.
 * - Reverse (per allowlist entry): some operation carries its id, unless the
 *   entry is named in {@link OPT_OUT_ROUTES} with a reason.
 * - Opt-outs: each one names an allowlist entry that no operation covers. An
 *   opt-out left behind after its tool ships would hide the next drift on
 *   that id.
 *
 * What a route grants is not checked here, because a tool no longer says it.
 * `src/generated/route-catalog.ts` is generated from the allowlist and `op()`
 * reads a route's method, path, scopes, and idempotency rule out of it, so the
 * two lists cannot disagree on those. The reverse pass is what catches a route
 * that ships in the allowlist with no MCP tool behind it. That is silent drift
 * no type can see, because an unused catalog key compiles fine.
 */
export function checkOpenApiCoverage(input: {
  readonly operations: readonly Operation[];
  readonly policies: readonly ApiKeyPolicyEntry[];
  readonly openApiPaths: Record<string, Record<string, JsonValue>> | undefined;
  readonly optOuts?: readonly OptOutRoute[];
}): OpenApiCoverageResult {
  const optOuts = input.optOuts ?? OPT_OUT_ROUTES;
  const optedOut = HashSet.fromIterable(optOuts.map((optOut) => optOut.id));

  const covered = HashSet.fromIterable(
    input.operations.map((operation) => operation.id)
  );

  const missingFromOpenApi = input.operations
    .filter((operation) => !existsInOpenApi(operation, input.openApiPaths))
    .map(
      (operation) => `${operation.method} ${operation.path} (${operation.id})`
    );

  const allowlistRoutesWithoutOperation = input.policies
    .filter(
      (policy) =>
        !(HashSet.has(optedOut, policy.id) || HashSet.has(covered, policy.id))
    )
    .map((policy) => `${policy.method} ${policy.path} (${policy.id})`);

  const allowlisted = HashSet.fromIterable(
    input.policies.map((policy) => policy.id)
  );

  const staleOptOuts = optOuts.flatMap((optOut) => {
    if (HashSet.has(covered, optOut.id)) {
      return [`${optOut.id}: an MCP operation now covers it`];
    }

    return HashSet.has(allowlisted, optOut.id)
      ? []
      : [`${optOut.id}: no allowlist entry has this id`];
  });

  return { missingFromOpenApi, allowlistRoutesWithoutOperation, staleOptOuts };
}

/** The failure report, one line per stderr line. */
function reportLines(
  result: OpenApiCoverageResult,
  sources: { readonly openApi: string; readonly policies: string }
): readonly string[] {
  const lines: string[] = [];

  if (Arr.isReadonlyArrayNonEmpty(result.missingFromOpenApi)) {
    lines.push(
      `Missing from OpenAPI (${sources.openApi}):`,
      ...result.missingFromOpenApi.map((item) => `- ${item}`)
    );
  }

  if (Arr.isReadonlyArrayNonEmpty(result.allowlistRoutesWithoutOperation)) {
    lines.push(
      `Allowlisted in the API-key policy (${sources.policies}) but no MCP tool covers it:`,
      ...result.allowlistRoutesWithoutOperation.map((item) => `- ${item}`),
      "Fix: add an op({...}) entry for the route in the group file under src/operations/groups/, " +
        "or add it to OPT_OUT_ROUTES in scripts/check-openapi.ts with a reason."
    );
  }

  if (Arr.isReadonlyArrayNonEmpty(result.staleOptOuts)) {
    lines.push(
      "OPT_OUT_ROUTES entries that no longer apply:",
      ...result.staleOptOuts.map((item) => `- ${item}`),
      "Fix: delete the entry from scripts/check-openapi.ts."
    );
  }

  return lines;
}

/** The CLI entry point. Loads real data, runs the check, and exits 1 on a failure. */
const main = Effect.fn("check-openapi")(function* () {
  const { spec, source: openApiSource } = yield* loadOpenApi();
  const { policies, source: policiesSource } = yield* loadApiKeyPolicies();

  const { paths: openApiPaths } = yield* decodeOpenApiPaths(spec);

  const result = checkOpenApiCoverage({
    operations: LUCA_OPERATIONS,
    policies,
    openApiPaths,
  });

  if (hasFailures(result)) {
    return yield* exitWith(
      reportLines(result, { openApi: openApiSource, policies: policiesSource })
    );
  }

  yield* Console.log(
    `OpenAPI + allowlist check passed for ${LUCA_OPERATIONS.length} operations and ${policies.length} allowlist entries.`
  );
});

// Only run the CLI when this file is executed directly (`bun scripts/check-openapi.ts`),
// not when a test imports the pure functions above.
if (isEntryPoint(import.meta.filename)) {
  runScript(main());
}
