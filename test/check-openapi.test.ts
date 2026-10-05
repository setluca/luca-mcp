import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it, layer } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as R from "effect/Record";

import {
  checkOpenApiCoverage,
  hasFailures,
  type OptOutRoute,
  OPT_OUT_ROUTES,
} from "../scripts/check-openapi.ts";
import type { ApiKeyPolicyEntry } from "../scripts/load-openapi.ts";
import { loadApiKeyPolicies } from "../scripts/load-openapi.ts";
import { LUCA_OPERATIONS } from "../src/operations.ts";

const READ_LEADS_POLICY: ApiKeyPolicyEntry = {
  id: "leads.list",
  method: "GET",
  path: "/api/leads",
  scopes: ["leads:read"],
};

function operationsById(...ids: readonly string[]) {
  return LUCA_OPERATIONS.filter((operation) => ids.includes(operation.id));
}

describe("checkOpenApiCoverage: forward direction", () => {
  it("reports an operation whose route is not in OpenAPI", () => {
    const result = checkOpenApiCoverage({
      operations: operationsById("leads.list"),
      policies: [READ_LEADS_POLICY],
      openApiPaths: {},
      optOuts: [],
    });

    expect(result.missingFromOpenApi).toEqual(["GET /api/leads (leads.list)"]);
    expect(hasFailures(result)).toBe(true);
  });
});

describe("checkOpenApiCoverage: stale opt-outs", () => {
  const openApiPaths = { "/api/leads": { get: {} } };

  it("reports an opt-out whose id an operation now covers", () => {
    const result = checkOpenApiCoverage({
      operations: operationsById("leads.list"),
      policies: [READ_LEADS_POLICY],
      openApiPaths,
      optOuts: [{ id: "leads.list", reason: "test fixture" }],
    });

    expect(result.staleOptOuts).toEqual([
      "leads.list: an MCP operation now covers it",
    ]);
    expect(hasFailures(result)).toBe(true);
  });

  it("reports an opt-out that names no allowlist entry", () => {
    const result = checkOpenApiCoverage({
      operations: operationsById("leads.list"),
      policies: [READ_LEADS_POLICY],
      openApiPaths,
      optOuts: [{ id: "leads.gone", reason: "test fixture" }],
    });

    expect(result.staleOptOuts).toEqual([
      "leads.gone: no allowlist entry has this id",
    ]);
    expect(hasFailures(result)).toBe(true);
  });
});

describe("checkOpenApiCoverage: reverse direction", () => {
  const openApiPaths = {
    "/api/leads": { get: {} },
    "/api/review-queue/{id}/reject": { post: {} },
  };

  it("reports an allowlisted route with no covering MCP operation", () => {
    const rejectPolicy: ApiKeyPolicyEntry = {
      id: "reviewQueue.reject",
      method: "POST",
      path: "/api/review-queue/{id}/reject",
      scopes: ["review_queue:write"],
      requireIdempotency: true,
    };

    const result = checkOpenApiCoverage({
      // Only a leads.list operation exists in this fixture — nothing covers
      // the reject policy below.
      operations: operationsById("leads.list"),
      policies: [READ_LEADS_POLICY, rejectPolicy],
      openApiPaths,
      optOuts: [],
    });

    expect(result.allowlistRoutesWithoutOperation).toEqual([
      "POST /api/review-queue/{id}/reject (reviewQueue.reject)",
    ]);
    expect(hasFailures(result)).toBe(true);
  });

  it("does not report a route covered by an operation", () => {
    const result = checkOpenApiCoverage({
      operations: operationsById("leads.list"),
      policies: [READ_LEADS_POLICY],
      openApiPaths,
      optOuts: [],
    });

    expect(result.allowlistRoutesWithoutOperation).toEqual([]);
    expect(hasFailures(result)).toBe(false);
  });

  it("lets an explicit, reasoned opt-out entry silence the reverse check", () => {
    const internalOnlyPolicy: ApiKeyPolicyEntry = {
      id: "leads.someInternalRoute",
      method: "GET",
      path: "/api/some-internal-route",
      scopes: ["leads:read"],
    };

    const optOuts: readonly OptOutRoute[] = [
      {
        id: "leads.someInternalRoute",
        reason: "test fixture: exercises the opt-out path only",
      },
    ];

    const result = checkOpenApiCoverage({
      operations: operationsById("leads.list"),
      policies: [READ_LEADS_POLICY, internalOnlyPolicy],
      openApiPaths,
      optOuts,
    });

    expect(result.allowlistRoutesWithoutOperation).toEqual([]);
  });

  it("matches a policy to an operation on the id, not the route it happens to share", () => {
    // A tool and the entry that grants it are the same id, so a sibling route
    // under the same path prefix is never mistaken for coverage.
    const siblingPolicy: ApiKeyPolicyEntry = {
      id: "leads.fieldDefinitions.list",
      method: "GET",
      path: "/api/leads/field-definitions",
      scopes: ["leads:read"],
    };

    const result = checkOpenApiCoverage({
      operations: operationsById("leads.list"),
      policies: [siblingPolicy],
      openApiPaths,
      optOuts: [],
    });

    expect(result.allowlistRoutesWithoutOperation).toEqual([
      "GET /api/leads/field-definitions (leads.fieldDefinitions.list)",
    ]);
  });
});

layer(BunServices.layer)("real allowlist coverage", (it) => {
  it.effect(
    "covers every apps/api/api-key-policies.json entry with an MCP operation or a reasoned opt-out",
    () =>
      Effect.gen(function* () {
        const { policies } = yield* loadApiKeyPolicies();

        // The forward pass needs a real OpenAPI path table to report routes
        // missing from OpenAPI; that's exercised by scripts/check-openapi.ts
        // and openapi:check. This invariant test only cares about the reverse
        // direction, so an all-present stub keeps it independent of the
        // OpenAPI snapshot's shape.
        const openApiPaths = R.fromEntries(
          LUCA_OPERATIONS.map((operation) => [
            operation.path,
            { [operation.method.toLowerCase()]: {} },
          ])
        );

        const result = checkOpenApiCoverage({
          operations: LUCA_OPERATIONS,
          policies,
          openApiPaths,
          optOuts: OPT_OUT_ROUTES,
        });

        expect(result.allowlistRoutesWithoutOperation).toEqual([]);
        expect(result.staleOptOuts).toEqual([]);
      })
  );

  // Guards the list rather than its current contents so every future opt-out
  // remains explicit and reviewable.
  it("requires a reason on every opt-out entry", () => {
    Arr.forEach(OPT_OUT_ROUTES, (optOut) => {
      expect(optOut.reason.length).toBeGreaterThan(0);
    });
  });
});
