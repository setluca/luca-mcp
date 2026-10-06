import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import { assert, describe, expect, it } from "vitest";

import { checkOperationTitles } from "../scripts/check-registry.ts";
import { operationAnnotations } from "../src/annotations.ts";
import { WORKSPACE_INPUT_FIELDS } from "../src/fields.ts";
import { OPENAPI_INPUT_SPECS } from "../src/generated/openapi-input-specs.ts";
import { OPENAPI_OUTPUTS } from "../src/generated/openapi-outputs.ts";
import { ROUTE_CATALOG } from "../src/generated/route-catalog.ts";
import type {
  OpenApiInputSpec,
  ToolField,
  ToolFields,
} from "../src/openapi-schema.ts";
import {
  DEFAULT_MAX_PAGES,
  LUCA_OPERATIONS,
  operationGroups,
  needsConfirmation,
  operationManifest,
  outputSchemaFor,
} from "../src/operations.ts";
import { JsonObject } from "../src/serialization.ts";
import { toStandardSchema } from "../src/standard-schema.ts";
import { LUCA_TASK_TOOLS } from "../src/task-tools.ts";
import { sorted } from "./helpers.ts";

const OPENAPI_INPUT_SPECS_BY_KEY = OPENAPI_INPUT_SPECS as Record<
  string,
  OpenApiInputSpec
>;

const OPENAPI_OUTPUTS_BY_ROUTE: Readonly<Record<string, unknown>> =
  OPENAPI_OUTPUTS;

function getOperation(operationId: string) {
  const operation = LUCA_OPERATIONS.find((item) => item.id === operationId);

  assert(operation, `Missing operation: ${operationId}`);

  return operation;
}

function toolSchema(operationId: string) {
  return Schema.Struct(getOperation(operationId).inputSchema);
}

function accepts(schema: Schema.Struct<ToolFields>, value: unknown) {
  return Option.isSome(Schema.decodeUnknownOption(schema)(value));
}

function fieldAccepts(field: ToolField | undefined, value: unknown) {
  return (
    field !== undefined &&
    Option.isSome(Schema.decodeUnknownOption(field)(value))
  );
}

function descriptionOf(field: ToolField | undefined) {
  return field === undefined
    ? undefined
    : SchemaAST.resolveDescription(field.ast);
}

/** The JSON Schema a client reads for a field, as the SDK hands it over. */
function jsonSchemaOf(field: ToolField | undefined) {
  return Schema.decodeUnknownSync(JsonObject)(
    toStandardSchema(field ?? Schema.Unknown)["~standard"].jsonSchema.input({
      target: "draft-2020-12",
    })
  );
}

/**
 * Read back the `x-luca-redacted-fields` marker the way an MCP client
 * would, from the JSON Schema the SDK publishes for the registered
 * `outputSchema`.
 */
function redactedFieldsOf(operationId: string): readonly string[] {
  const jsonSchema = jsonSchemaOf(
    getOperation(operationId).outputSchema.result
  );

  return Option.getOrElse(
    Schema.decodeUnknownOption(Schema.Array(Schema.String))(
      jsonSchema["x-luca-redacted-fields"]
    ),
    () => []
  );
}

function operationKey(operation: (typeof LUCA_OPERATIONS)[number]) {
  return `${operation.method} ${operation.path}`;
}

function pathPlaceholders(path: string) {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] ?? "");
}

describe("operation manifest", () => {
  it("takes what a route grants from the allowlist, not from the tool", () => {
    // The tool declares an id. Method, path, scopes, and the idempotency rule
    // are the API's answer about that id, read out of the generated catalog,
    // so a tool cannot advertise access the allowlist does not grant.
    Arr.forEach(LUCA_OPERATIONS, (operation) => {
      // SAFETY: The value comes from this module's own contract, so its shape matches the assertion.
      const route = ROUTE_CATALOG[operation.id as keyof typeof ROUTE_CATALOG];
      expect(route).toBeDefined();
      expect({
        method: operation.method,
        path: operation.path,
        scopes: operation.scopes,
        idempotencyRequired: operation.idempotencyRequired,
      }).toEqual({
        method: route.method,
        path: route.path,
        scopes: route.scopes,
        idempotencyRequired: route.idempotencyRequired,
      });
    });
  });

  it("uses unique MCP tool names", () => {
    const names = LUCA_OPERATIONS.map((operation) => operation.toolName);
    expect(Arr.dedupe(names)).toHaveLength(names.length);
  });

  it("names every tool in snake_case, the casing task tools use too", () => {
    const names = [
      ...LUCA_OPERATIONS.map(({ toolName }) => toolName),
      ...LUCA_TASK_TOOLS.map(({ name }) => name),
    ];

    Arr.forEach(names, (name) => {
      expect(name).toMatch(/^luca(?:_[a-z0-9]+)+$/);
    });
  });

  it("derives each tool name from its operation id", () => {
    expect(
      LUCA_OPERATIONS.find(({ id }) => id === "analytics.callIntelligenceCalls")
        ?.toolName
    ).toBe("luca_analytics_call_intelligence_calls");
    expect(
      LUCA_OPERATIONS.find(({ id }) => id === "callEvents.pushToCrm")?.toolName
    ).toBe("luca_call_events_push_to_crm");
  });

  it("contains public operation metadata", () => {
    expect(operationManifest()).toContainEqual(
      expect.objectContaining({
        id: "leads.list",
        group: "leads",
        toolName: "luca_leads_list",
        method: "GET",
        path: "/api/leads",
        scopes: ["leads:read"],
        idempotencyRequired: false,
      })
    );
  });

  it("registers the predictive lead-score operation", () => {
    const operation = getOperation("analytics.leadScore");
    expect(operation).toMatchObject({
      id: "analytics.leadScore",
      group: "analytics",
      toolName: "luca_analytics_lead_score",
      method: "GET",
      path: "/api/analytics/lead-score/{leadId}",
      scopes: ["analytics:read"],
      idempotencyRequired: false,
    });
    expect(toolSchema("analytics.leadScore").fields.leadId).toBeDefined();
  });

  it("registers the loss-reasons operation", () => {
    const operation = getOperation("analytics.lossReasons");
    expect(operation).toMatchObject({
      id: "analytics.lossReasons",
      group: "analytics",
      toolName: "luca_analytics_loss_reasons",
      method: "GET",
      path: "/api/analytics/loss-reasons",
      scopes: ["analytics:read"],
      idempotencyRequired: false,
    });
  });

  it("registers the cross-coach benchmarks operation", () => {
    const operation = getOperation("analytics.benchmarks");
    expect(operation).toMatchObject({
      id: "analytics.benchmarks",
      group: "analytics",
      toolName: "luca_analytics_benchmarks",
      method: "GET",
      path: "/api/analytics/benchmarks",
      scopes: ["analytics:read"],
      idempotencyRequired: false,
    });
  });

  it("registers the webhook-events list operation", () => {
    const operation = getOperation("webhooks.events.list");
    expect(operation).toMatchObject({
      id: "webhooks.events.list",
      group: "webhooks",
      toolName: "luca_webhooks_events_list",
      method: "GET",
      path: "/api/webhook-events",
      scopes: ["webhooks:read"],
      idempotencyRequired: false,
      // Not untrusted: every event's delivered payload is structured ids,
      // enums, and counts — no verbatim lead text or PII.
      untrustedContent: false,
    });
    expect(operation.confirm).toBeUndefined();
    // Its response carries no cursor, so there is nothing to walk and the tool
    // ships without the pagination controls.
    expect(operation.pageContract).toBeUndefined();
    expect(operationAnnotations(operation)).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    // The event type + limit ride in the nested query object.
    expect(toolSchema("webhooks.events.list").fields.query).toBeDefined();
    expect(
      OPENAPI_INPUT_SPECS_BY_KEY["GET /api/webhook-events"]?.query
    ).toBeDefined();
  });

  it("registers the webhook-subscription delete operation", () => {
    const operation = getOperation("webhooks.subscriptions.delete");
    expect(operation).toMatchObject({
      id: "webhooks.subscriptions.delete",
      group: "webhooks",
      toolName: "luca_webhooks_subscriptions_delete",
      method: "DELETE",
      path: "/api/webhook-subscriptions/{id}",
      scopes: ["webhooks:write"],
      // Deleting by id is naturally idempotent, matching the route policy
      // (requireIdempotency=false); no confirm gate and no Idempotency-Key.
      idempotencyRequired: false,
    });
    expect(operation.confirm).toBeUndefined();
    // A DELETE is inherently destructive even without a confirm gate.
    expect(operationAnnotations(operation)).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(toolSchema("webhooks.subscriptions.delete").fields.id).toBeDefined();
  });

  it("groups operations by Luca API domain", () => {
    const groups = operationGroups();
    const leads = groups.find((group) => group.id === "leads");
    const reviewQueue = groups.find((group) => group.id === "reviewQueue");

    expect(leads).toEqual(
      expect.objectContaining({
        title: "Leads",
        toolCount: LUCA_OPERATIONS.filter(
          (operation) => operation.group === "leads"
        ).length,
      })
    );
    expect(leads?.scopes).toContain("leads:read");
    expect(leads?.tools).toContain("luca_leads_list");
    expect(reviewQueue?.tools).toEqual([
      "luca_review_queue_list",
      "luca_review_queue_explain",
      "luca_review_queue_approve",
      "luca_review_queue_reject",
      "luca_review_queue_restore",
      "luca_review_queue_media_retry",
      "luca_review_queue_sla",
      "luca_review_queue_objection_variant",
    ]);
  });

  it("has complete group metadata for every operation", () => {
    const groups = operationGroups();
    const groupedTools = groups.flatMap((group) => group.tools);

    expect(groups.reduce((sum, group) => sum + group.toolCount, 0)).toBe(
      LUCA_OPERATIONS.length
    );

    Arr.forEach(groups, (group) => {
      expect(group.title).not.toBe("");
      expect(group.description).not.toBe("");
      expect(group.toolCount).toBeGreaterThan(0);
      expect(group.scopes).toEqual(sorted(group.scopes));
    });

    Arr.forEach(LUCA_OPERATIONS, (operation) => {
      expect(Arr.contains(groupedTools, operation.toolName)).toBe(true);
    });
  });

  it("has generated OpenAPI input specs for every operation", () => {
    Arr.forEach(LUCA_OPERATIONS, (operation) => {
      expect(OPENAPI_INPUT_SPECS_BY_KEY[operationKey(operation)]).toBeDefined();
    });
  });

  it("gives every operation a per-tool output schema (no shared unknown placeholder)", () => {
    Arr.forEach(LUCA_OPERATIONS, (operation) => {
      expect(Object.hasOwn(operation.outputSchema, "result")).toBe(true);
    });

    // The old behavior shared one `{ result: unknown }` across all tools.
    // Now the large majority carry a structured (non-`unknown`) result derived
    // from their OpenAPI body; only a handful of loosely-typed responses stay
    // unknown, and those are per-op, not the shared placeholder.
    const structured = LUCA_OPERATIONS.filter(
      (operation) =>
        operation.outputSchema.result === undefined ||
        !SchemaAST.isUnknown(operation.outputSchema.result.ast)
    );

    expect(structured.length).toBeGreaterThanOrEqual(50);
    // A representative read tool has a genuinely structured result body.
    const voiceResult = getOperation("voice.profile").outputSchema.result;

    expect(
      voiceResult !== undefined && SchemaAST.isObjects(voiceResult.ast)
    ).toBe(true);
  });

  it("validates a well-formed result and fails loud on a malformed one", () => {
    const schema = Schema.Struct(getOperation("voice.profile").outputSchema);

    const ok = accepts(schema, {
      result: {
        version: 3,
        personaSummary: null,
        corpusExampleCount: 2,
        lastRefreshedAt: null,
      },
    });

    expect(ok).toBe(true);

    const bad = accepts(schema, {
      result: { version: "not-a-number", corpusExampleCount: 2 },
    });

    expect(bad).toBe(false);
  });

  it("keeps path placeholders aligned with generated path schemas", () => {
    Arr.forEach(LUCA_OPERATIONS, (operation) => {
      const placeholders = pathPlaceholders(operation.path);
      const spec = OPENAPI_INPUT_SPECS_BY_KEY[operationKey(operation)];
      const pathProperties = R.keys(spec?.path?.properties ?? {});

      expect(sorted(pathProperties)).toEqual(sorted(placeholders));
    });
  });

  it("exposes idempotency input only for idempotent operations", () => {
    Arr.forEach(LUCA_OPERATIONS, (operation) => {
      expect(Object.hasOwn(operation.inputSchema, "idempotencyKey")).toBe(
        operation.idempotencyRequired
      );
    });
  });

  it("constructs an input schema for every operation", () => {
    Arr.forEach(LUCA_OPERATIONS, (operation) => {
      expect(() => Schema.Struct(operation.inputSchema)).not.toThrow();
    });
  });

  it("builds requests from operation tool inputs", () => {
    const operation = LUCA_OPERATIONS.find(
      (item) => item.id === "leads.update"
    );

    assert(operation, "Missing leads.update");

    expect(
      operation.buildRequest({
        id: "00000000-0000-0000-0000-000000000000",
        workspaceId: "11111111-1111-4111-8111-111111111111",
        workspaceSlug: "demo",
        idempotencyKey: "lead-update",
        body: { displayName: "Alex" },
      })
    ).toEqual({
      pathParams: { id: "00000000-0000-0000-0000-000000000000" },
      body: { displayName: "Alex" },
      idempotencyKey: "lead-update",
      workspace: {
        workspaceId: "11111111-1111-4111-8111-111111111111",
        workspaceSlug: "demo",
      },
    });
  });

  it("omits non-string path params from built requests", () => {
    const operation = LUCA_OPERATIONS.find((item) => item.id === "leads.get");

    assert(operation, "Missing leads.get");

    const request = operation.buildRequest({
      // A malformed caller path parameter.
      id: 123,
    });

    expect(request).toEqual({
      pathParams: {},
      workspace: {},
    });
    // The key has to be absent, not present and undefined. A present key would
    // interpolate the string "undefined" into the path and send the request to
    // a URL nobody named.
    expect(Object.hasOwn(request.pathParams ?? {}, "id")).toBe(false);
  });

  it("derives precise body schemas from Luca OpenAPI", () => {
    const schema = toolSchema("leads.create");

    expect(
      accepts(schema, {
        body: { channel: "telegram", externalUserId: "u_1" },
      })
    ).toBe(true);
    expect(
      accepts(schema, {
        body: { channel: "email", externalUserId: "u_1" },
      })
    ).toBe(false);
    expect(accepts(schema, { body: { channel: "telegram" } })).toBe(false);
  });

  it("derives precise query and path schemas from Luca OpenAPI", () => {
    const listSchema = toolSchema("leads.list");
    const getSchema = toolSchema("leads.get");

    expect(accepts(listSchema, { query: { limit: 100 } })).toBe(true);
    expect(accepts(listSchema, { query: { limit: 101 } })).toBe(false);
    expect(
      accepts(getSchema, { id: "00000000-0000-0000-0000-000000000000" })
    ).toBe(true);
    expect(accepts(getSchema, { id: "not-a-uuid" })).toBe(false);
  });

  it("gates exactly the destructive, real-world-side-effect tools", () => {
    const gated = LUCA_OPERATIONS.filter(
      (operation) => operation.confirm !== undefined
    ).map((operation) => operation.id);

    expect(sorted(Arr.dedupe(gated))).toEqual(
      sorted([
        "campaigns.enroll",
        "broadcasts.launch",
        "broadcasts.retry",
        "webhooks.deliveries.replay",
        "webhooks.events.replay",
        "webhooks.events.bulkReplay",
        "reviewQueue.approve",
        "cadences.rescueStart",
        "knowledge.approveSuggestion",
        "campaigns.publish",
        "conversations.partial_send_retry",
        "conversations.send",
        "leads.importApply",
        "leads.consents.grant",
        "bookings.cancel",
        "bookings.create",
        "bookings.outcome.record",
        "bookings.update",
        "campaigns.setStatus",
        "webhooks.subscriptions.create",
        "webhooks.subscriptions.update",
        "webhooks.testDelivery",
        "bookings.providerSync.retry",
        "bookings.lifecycleResolution",
        "callEvents.feedback",
        "callEvents.summary.replace",
        "callEvents.pushToCrm",
        "integrations.crm.connections.webhooksSetup",
        "integrations.crm.syncRuns.create",
      ])
    );
  });

  it("only gates state-changing operations a retry cannot repeat", () => {
    // An active subscription with the same target URL is updated in place, so
    // a retried create cannot add a second one and the route takes no key.
    const naturallyIdempotent = "webhooks.subscriptions.create";

    const gated = LUCA_OPERATIONS.filter(
      (operation) => operation.confirm !== undefined
    );

    Arr.forEach(gated, (operation) => {
      expect(operation.method).not.toBe("GET");
      expect(
        operation.idempotencyRequired || operation.id === naturallyIdempotent
      ).toBe(true);
    });
  });

  it("adds a confirm input only to gated tools", () => {
    Arr.forEach(LUCA_OPERATIONS, (operation) => {
      expect("confirm" in operation.inputSchema).toBe(
        operation.confirm !== undefined
      );
    });
  });

  it("gates a call-event report only when it files a no_show", () => {
    const { confirm } = getOperation("callEvents.feedback");

    // A no_show can start recovery that messages the lead. Nothing else the
    // report files does, so the other outcomes run without confirm.
    expect(needsConfirmation(confirm, { body: { outcome: "no_show" } })).toBe(
      true
    );

    Arr.forEach(["completed", "rescheduled", "cancelled"], (outcome) => {
      expect(needsConfirmation(confirm, { body: { outcome } })).toBe(false);
    });

    expect(needsConfirmation(confirm, {})).toBe(false);
    expect("confirm" in getOperation("callEvents.feedback").inputSchema).toBe(
      true
    );
  });

  it("gates only booking outcomes that can change a connected CRM deal", () => {
    const operation = getOperation("bookings.outcome.record");

    for (const status of ["won", "lost"]) {
      expect(needsConfirmation(operation.confirm, { body: { status } })).toBe(
        true
      );
    }

    expect(
      needsConfirmation(operation.confirm, { body: { status: "open" } })
    ).toBe(false);
    expect(needsConfirmation(operation.confirm, {})).toBe(false);
    expect("confirm" in operation.inputSchema).toBe(true);
  });

  it("exposes confirmRequired in the operation manifest", () => {
    const manifest = operationManifest();
    const launch = manifest.find((entry) => entry.id === "broadcasts.launch");
    const list = manifest.find((entry) => entry.id === "leads.list");
    expect(launch?.confirmRequired).toBe(true);
    expect(list?.confirmRequired).toBe(false);
  });

  // Hardcoded rather than re-derived from the manifest: a test that recomputes
  // the rule it is checking passes for any rule. These thirteen are every route that
  // both hands back a nextCursor and takes a cursor to send it in.
  const PAGINATING_OPERATIONS = [
    "analytics.insights",
    "bookings.list",
    "broadcasts.list",
    "campaigns.commentEvents.list",
    "campaigns.enrollments.list",
    "campaigns.list",
    "campaigns.simulations.list",
    "coach.auditLog",
    "conversations.list",
    "conversations.messages",
    "integrations.events.list",
    "leads.list",
    "reviewQueue.list",
  ];

  it("marks exactly the walkable operations as paginating", () => {
    const paginating = LUCA_OPERATIONS.filter(
      (operation) => operation.pageContract !== undefined
    ).map((operation) => operation.id);

    expect(paginating.toSorted()).toEqual(PAGINATING_OPERATIONS);

    Arr.forEach(LUCA_OPERATIONS, (operation) => {
      expect("maxPages" in operation.inputSchema).toBe(
        operation.pageContract !== undefined
      );
    });
  });

  it("names the same paginating operations in the manifest", () => {
    // The manifest is what the `luca://operations` resource and the docs
    // generator read, so a `paginates` flag that disagrees with the operation's
    // own page shape would tell an agent a tool walks pages when it does not.
    const paginating = operationManifest()
      .filter((entry) => entry.paginates)
      .map((entry) => entry.id);

    expect(paginating.toSorted()).toEqual(PAGINATING_OPERATIONS);
  });

  it("reads each route's page shape off its own schemas", () => {
    // Almost every route calls the cursor `cursor`; the conversation-messages
    // route calls it `before`, and the paginator has to follow the route, not
    // the convention. The records arrive under a name the route picks too.
    expect(getOperation("leads.list").pageContract).toEqual({
      cursorQueryParam: "cursor",
      itemsKey: "leads",
    });
    expect(getOperation("conversations.messages").pageContract).toEqual({
      cursorQueryParam: "before",
      itemsKey: "messages",
    });
  });

  it("derives read-only annotations for GET tools", () => {
    const list = operationAnnotations(getOperation("leads.list"));
    expect(list).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });

    // This GET inserts the default settings row on first use.
    expect(
      operationAnnotations(getOperation("insights.settings.get"))
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });

    // This GET stores a fresh OAuth state record for the callback.
    expect(
      operationAnnotations(getOperation("integrations.crm.oauthUrl"))
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
  });

  it("marks open-world only the calls that reach past the workspace", () => {
    const openWorld = LUCA_OPERATIONS.filter(
      (operation) => operationAnnotations(operation).openWorldHint
    ).map((operation) => operation.id);

    expect(sorted(Arr.dedupe(openWorld))).toEqual(
      sorted([
        // A lead's inbox. Recording consent is what allows messaging to start.
        "leads.consents.grant",
        "conversations.send",
        "conversations.partial_send_retry",
        "reviewQueue.approve",
        "campaigns.enroll",
        "campaigns.publish",
        "campaigns.setStatus",
        "broadcasts.launch",
        "broadcasts.retry",
        "cadences.rescueStart",
        // An outside URL.
        "webhooks.subscriptions.create",
        "webhooks.subscriptions.update",
        "webhooks.testDelivery",
        "webhooks.deliveries.replay",
        "webhooks.events.replay",
        "webhooks.events.bulkReplay",
        // A connected calendar or CRM.
        "bookings.create",
        "bookings.calendars.select",
        "bookings.availability",
        "bookings.managedAvailability",
        "bookings.providers.get",
        "bookings.update",
        "bookings.cancel",
        "bookings.providerSync.retry",
        "bookings.lifecycleResolution",
        "bookings.outcome.record",
        "callEvents.feedback",
        "callEvents.summary.replace",
        "callEvents.pushToCrm",
        "integrations.crm.connections.webhooksSetup",
        "integrations.crm.syncRuns.create",
        // These read outside Luca without changing the outside system.
        "integrations.crm.connections.schema",
        "integrations.crm.connections.health",
        "knowledge.sources.sync",
      ])
    );
  });

  it("confirm-gates writes to external systems", () => {
    // An open-world write lands somewhere Luca cannot take it back from: a
    // lead's inbox, an outside URL, a connected calendar or CRM. CRM health,
    // knowledge sync, and calendar selection read an external system but do
    // not write to it, so they need no confirmation gate.
    const ungated = LUCA_OPERATIONS.filter(
      (operation) =>
        operation.method !== "GET" &&
        operationAnnotations(operation).openWorldHint &&
        !Arr.contains(
          [
            "integrations.crm.connections.health",
            "knowledge.sources.sync",
            "bookings.calendars.select",
          ],
          operation.id
        ) &&
        operation.confirm === undefined
    ).map((operation) => operation.id);

    expect(ungated).toEqual([]);
  });

  it("marks confirm-gated, delete, and overwriting tools destructive", () => {
    expect(
      operationAnnotations(getOperation("broadcasts.launch"))
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(operationAnnotations(getOperation("bookings.cancel"))).toMatchObject(
      {
        readOnlyHint: false,
        destructiveHint: true,
      }
    );
    // MCP calls the non-destructive half additive-only, so a PATCH that
    // overwrites a field and a PUT that replaces a whole resource both read
    // destructive even without a confirm gate.
    expect(operationAnnotations(getOperation("leads.update"))).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(
      operationAnnotations(getOperation("bookings.types.schedule.replace"))
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    // This route is an upsert, so its POST can overwrite an existing lead.
    expect(operationAnnotations(getOperation("leads.create"))).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
    expect(
      operationAnnotations(getOperation("reviewQueue.reject"))
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  it("calls every mutating method destructive and no read", () => {
    // The whole point of the hint is that a client can auto-approve what it
    // reads as safe. A silent gap here hands it a write it will not ask about.
    const hints = LUCA_OPERATIONS.map((operation) => ({
      destructiveHint: operationAnnotations(operation).destructiveHint,
      operation,
    }));

    const mutating = hints.filter(
      ({ operation }) =>
        Arr.contains(["DELETE", "PATCH", "PUT"], operation.method) ||
        operation.mutatesExisting
    );

    const reads = hints.filter(({ operation }) => operation.method === "GET");

    Arr.forEach(mutating, ({ destructiveHint, operation }) => {
      expect([operation.id, destructiveHint]).toEqual([operation.id, true]);
    });

    Arr.forEach(reads, ({ destructiveHint, operation }) => {
      expect([operation.id, destructiveHint]).toEqual([operation.id, false]);
    });
  });

  it("flags external-user-content reads as untrusted and nothing else", () => {
    // Group heuristic plus per-operation overrides for reads that carry
    // external text outside those groups: a comment-automation event quotes
    // the commenter, and a pre-call brief is composed from what the lead said.
    const untrustedOverrideIds = [
      "campaigns.commentEvents.list",
      "bookings.brief",
      // Call-event writes echo the event back, summary included. The summary
      // is generated from what the lead said on the call, so the response
      // carries lead-authored content even on a POST or PUT.
      "callEvents.feedback",
      "callEvents.summary.generate",
      "callEvents.summary.replace",
      "callEvents.pushToCrm",
      "callEvents.undoOutcome",
      "callEvents.backfill",
      "campaigns.enrollments.list",
      "campaigns.enrollments.timeline",
      // The enrollment's context is execution state pulled out of the lead's
      // replies, and enrolling returns it.
      "campaigns.enroll",
      // A simulation echoes the lead record, event payload and context it ran
      // on, and the drafts a model wrote from them.
      "campaigns.simulations.create",
      "campaigns.simulations.get",
      "campaigns.commentSimulationSuite.run",
      // Every route that returns a broadcast carries the recipient snapshot:
      // each lead's display name and custom fields, written by the lead.
      "broadcasts.get",
      "broadcasts.create",
      "broadcasts.preview",
      "broadcasts.approve",
      "broadcasts.launch",
      "broadcasts.pause",
      "broadcasts.retry",
      "broadcasts.cancel",
      // CRM rows and webhook bodies hold contact fields people other than the
      // coach filled in: sample records, mutation fields, raw event payloads.
      "integrations.crm.connections.schema",
      "integrations.crm.syncRuns.list",
      "integrations.crm.syncRuns.create",
      "integrations.events.list",
      "leads.draft",
      // A memory edit returns the corrected fact Luca extracted from a lead's
      // message, so the write echoes lead-derived text back.
      "memory.update",
      "reports.morning",
      // Four analytics reads carry lead-authored text rather than counting it:
      // `topPhrases` and `phrase` are verbatim quotes lifted out of lead
      // messages, `calls[].summary` is generated from what the lead said on
      // the call, and `recommendations[].body` is written by a model handed a
      // verbatim lead excerpt. The rest of the group is counts and rates, and
      // the two note fields it does carry
      // (`learningInsights.recentExamples[].note`,
      // `callIntelligence.surprisePatterns`) are the coach's own writing, so
      // no lead controls their text.
      "analytics.callIntelligenceCalls",
      "analytics.objections",
      "analytics.objectionDrilldown",
      "analytics.recommendations",
      // `ghostedLeads` carries top-killer cluster labels drawn from lead
      // messages. `needsOutcome` rows carry a lead's name, and every booking
      // record carries a cancellation reason the invitee may have written.
      "analytics.ghostedLeads",
      "bookings.needsOutcome",
      "bookings.list",
      "bookings.get",
      "bookings.create",
      "bookings.update",
      "bookings.cancel",
      "bookings.lifecycleAttention",
      "bookings.lifecycleResolution",
    ];

    // Writes in a lead-text group whose response carries no lead text: an id,
    // a status, or the coach's own words echoed back. Opting an operation out
    // of the boundary means adding it here, in review, with its reason.
    const trustedWriteIds = [
      // Ids and status flags only.
      "leads.notes.delete",
      "conversations.send",
      "conversations.partial_send_retry",
      "reviewQueue.approve",
      "reviewQueue.reject",
      "reviewQueue.restore",
      "reviewQueue.media.retry",
      "reviewQueue.objectionVariant",
      "learning.proposals.dismiss",
      "memory.setArchived",
      // The coach's own writing echoed back.
      "leads.fieldDefinitions.upsert",
      "leads.consents.grant",
      "leads.consents.revoke",
      "leads.notes.add",
    ];

    const untrustedGroups = [
      "callEvents",
      "conversations",
      "leads",
      "learning",
      "memory",
      "reviewQueue",
    ];

    Arr.forEach(LUCA_OPERATIONS, (operation) => {
      const expected =
        (Arr.contains(untrustedGroups, operation.group) &&
          !Arr.contains(trustedWriteIds, operation.id)) ||
        Arr.contains(untrustedOverrideIds, operation.id);

      expect(operation.untrustedContent, operation.id).toBe(expected);
    });

    // A write in a lead-text group is framed unless it is named above, so a
    // new write cannot ship unframed by accident.
    const unframedWrites = LUCA_OPERATIONS.filter(
      (operation) =>
        Arr.contains(untrustedGroups, operation.group) &&
        !operation.untrustedContent
    ).map((operation) => operation.id);

    expect(sorted(unframedWrites)).toEqual(sorted(trustedWriteIds));

    // Spot checks.
    expect(getOperation("conversations.get").untrustedContent).toBe(true);
    expect(getOperation("leads.list").untrustedContent).toBe(true);
    expect(getOperation("reviewQueue.list").untrustedContent).toBe(true);
    // Comment events carry verbatim external-commenter text.
    expect(getOperation("campaigns.commentEvents.list").untrustedContent).toBe(
      true
    );
    // An analytics rollup that quotes the lead is as injectable as the
    // conversation the quote came out of, and the group name is no defense.
    expect(getOperation("analytics.objections").untrustedContent).toBe(true);
    expect(getOperation("analytics.objectionDrilldown").untrustedContent).toBe(
      true
    );
    expect(
      getOperation("analytics.callIntelligenceCalls").untrustedContent
    ).toBe(true);
    // Lead text that reaches the coach through a model is still lead text.
    expect(getOperation("analytics.recommendations").untrustedContent).toBe(
      true
    );
    // The rest of the group counts and rates, and stays trusted.
    expect(getOperation("analytics.funnel").untrustedContent).toBe(false);
    expect(getOperation("analytics.revenue").untrustedContent).toBe(false);
    // Both note fields in the group are the coach's own writing.
    expect(getOperation("analytics.learningInsights").untrustedContent).toBe(
      false
    );
    expect(getOperation("analytics.callIntelligence").untrustedContent).toBe(
      false
    );
    // Webhook events return the full delivered payload, but every event is
    // structured ids/enums/counts — no verbatim lead text — so it stays
    // trusted, as does the deliveries list (which stores only a payload hash).
    expect(getOperation("webhooks.events.list").untrustedContent).toBe(false);
    expect(getOperation("webhooks.deliveries.list").untrustedContent).toBe(
      false
    );
    expect(getOperation("capabilities.get").untrustedContent).toBe(false);
    expect(getOperation("bookings.availability").untrustedContent).toBe(false);
    // Other campaigns reads (coach-authored) stay trusted.
    expect(getOperation("campaigns.simulations.list").untrustedContent).toBe(
      false
    );
    // A generated draft is lead-derived content even though the route is a
    // POST and the group is not blanket-untrusted for writes.
    expect(getOperation("leads.draft").untrustedContent).toBe(true);
    expect(getOperation("reports.morning").untrustedContent).toBe(true);
  });

  it("leaves a sensitive free-text field unframed only where the coach wrote it", () => {
    // Every field marked sensitive is lead-derived or lead PII, so an
    // operation that returns one and is not framed untrusted needs a reviewed
    // reason here. A new route that returns such a field fails this test until
    // it is framed or named below with why its text is the coach's own.
    const coachAuthored = {
      "leads.notes.add": "The coach's own note, echoed back.",
      "bookings.types.attendees":
        "Names and emails of the team members the coach added to a booking type.",
      "bookings.types.attendees.add":
        "Names and emails of the team members the coach added to a booking type.",
      "bookings.types.attendees.remove":
        "Names and emails of the team members the coach added to a booking type.",
      "bookings.outcome.get": "The note the coach wrote on the outcome.",
      "bookings.outcome.history": "The notes the coach wrote on each outcome.",
      "bookings.outcome.record": "The note the coach wrote on the outcome.",
      "analytics.callIntelligence":
        "surprisePatterns are the coach's own post-call answers.",
      "analytics.learningInsights":
        "recentExamples notes are the coach's own corrections.",
      "voice.corpus":
        "The voice samples are the coach's own writing, the corpus voice.profile summarizes.",
    } satisfies Readonly<Record<string, string>>;

    const unframedWithSensitiveText = LUCA_OPERATIONS.filter(
      (operation) =>
        !operation.untrustedContent &&
        Arr.isReadonlyArrayNonEmpty(redactedFieldsOf(operation.id))
    ).map((operation) => operation.id);

    expect(sorted(unframedWithSensitiveText)).toEqual(
      sorted(R.keys(coachAuthored))
    );
  });

  it("frames every operation that returns a booking's cancellation reason", () => {
    // An invitee can type the reason when they cancel through the provider,
    // so any route that echoes it carries lead-written text.
    const unframed = LUCA_OPERATIONS.filter(
      (operation) =>
        // oxlint-disable-next-line effect/avoid-direct-json -- searches the generated output schema's text for a property name
        JSON.stringify(
          OPENAPI_OUTPUTS_BY_ROUTE[`${operation.method} ${operation.path}`] ??
            null
        ).includes('"cancellationReason"') && !operation.untrustedContent
    ).map((operation) => operation.id);

    expect(unframed).toEqual([]);
  });

  describe("redaction-eligible field marking", () => {
    // The lists are generated from the `x-luca-sensitive` markers in
    // apps/api/openapi.json, and test/sensitive-paths.test.ts checks every
    // tool against them. Re-declaring the lists here would only prove the
    // catalog matches a copy of itself, so these tests cover the shape of the
    // marker instead.
    it("merges the marker into the JSON Schema without clobbering the base schema", () => {
      const jsonSchema = jsonSchemaOf(
        getOperation("reviewQueue.list").outputSchema.result
      );

      // The actual annotation-merge regression risk: the base result schema
      // (object type + properties) must survive alongside the marker, not
      // get replaced by it.
      expect(jsonSchema.type).toBe("object");
      expect(jsonSchema.properties).toBeTruthy();
      expect(redactedFieldsOf("reviewQueue.list")).toContain(
        "items[].draftBody"
      );
    });

    it("advertises every path in dotted, hop-marked, sorted notation", () => {
      // Dotted segments with `[]` for an array hop and `{}` for a record hop,
      // each field named once, sorted. A path that drifts from this notation
      // can never match the API's marker and would silently read as verbatim.
      const marked = LUCA_OPERATIONS.flatMap((operation) =>
        redactedFieldsOf(operation.id).map(
          (path) => [operation.id, path] as const
        )
      );

      expect(marked.length).toBeGreaterThan(0);

      Arr.forEach(marked, ([id, path]) => {
        expect(`${id}: ${path}`).toMatch(
          /^[\w.]+: [a-zA-Z]\w*(\[\]|\{\})?(\.\w+(\[\]|\{\})?)*$/
        );
      });

      Arr.forEach(LUCA_OPERATIONS, (operation) => {
        const paths = redactedFieldsOf(operation.id);
        expect(paths).toEqual(sorted(Arr.dedupe(paths)));
      });
    });

    it("leaves an operation that returns no lead-derived field unmarked", () => {
      expect(redactedFieldsOf("capabilities.get")).toEqual([]);
      expect(redactedFieldsOf("bookings.availability")).toEqual([]);
    });
  });

  it("derives a two-dimensional required scope for every tool", () => {
    // Reads need only read capability; content reads need full_content data.
    expect(getOperation("leads.list").requiredScope).toEqual({
      capability: "read",
      dataSensitivity: "full_content",
    });
    expect(getOperation("capabilities.get").requiredScope).toEqual({
      capability: "read",
      dataSensitivity: "redacted",
    });
    // Plain writes need draft capability.
    expect(getOperation("leads.notes.add").requiredScope).toEqual({
      capability: "draft",
      dataSensitivity: "redacted",
    });

    // Lead writes echo the lead record back, and that record carries text the
    // lead wrote, so they sit in the full_content tier like the lead reads.
    Arr.forEach(
      [
        "leads.create",
        "leads.update",
        "leads.importPreview",
        "leads.importApply",
        "leads.identities.attach",
      ],
      (id) => {
        expect(getOperation(id).requiredScope.dataSensitivity).toBe(
          "full_content"
        );
      }
    );
    // Confirm-gated real-world sends need queue_ops.
    expect(getOperation("broadcasts.launch").requiredScope.capability).toBe(
      "queue_ops"
    );
    // An ungated write whose API scope only queue_ops grants states queue_ops,
    // the tier an OAuth connection has to ask for, not the draft its method
    // alone suggests.
    expect(getOperation("bookings.types.create").requiredScope.capability).toBe(
      "queue_ops"
    );

    // Only GETs are ever read capability.
    const readCapability = LUCA_OPERATIONS.filter(
      (operation) => operation.requiredScope.capability === "read"
    );

    Arr.forEach(readCapability, (operation) => {
      expect(operation.method).toBe("GET");
    });

    Arr.forEach(LUCA_OPERATIONS, (operation) => {
      // full_content is exactly the untrusted-content set.
      expect(operation.requiredScope.dataSensitivity === "full_content").toBe(
        operation.untrustedContent
      );
    });
  });

  it("annotates every tool and mirrors it in the manifest", () => {
    const annotated = LUCA_OPERATIONS.map(operationAnnotations);

    Arr.forEach(annotated, (annotations) => {
      expect(annotations.title).toEqual(expect.any(String));
    });

    // destructive only ever applies to writes
    Arr.forEach(
      annotated.filter((annotations) => annotations.destructiveHint),
      (annotations) => {
        expect(annotations.readOnlyHint).toBe(false);
      }
    );

    const manifest = operationManifest();
    expect(manifest.every((entry) => entry.annotations !== undefined)).toBe(
      true
    );
  });

  it("describes the optional workspace override inputs verbatim", () => {
    expect(descriptionOf(WORKSPACE_INPUT_FIELDS.workspaceId)).toBe(
      "Optional Luca workspace id override."
    );
    expect(descriptionOf(WORKSPACE_INPUT_FIELDS.workspaceSlug)).toBe(
      "Optional Luca workspace slug override."
    );
  });

  it("requires a non-empty idempotency key and describes it verbatim", () => {
    const idempotencyKeySchema =
      getOperation("leads.create").inputSchema.idempotencyKey;

    // min(1), not max(1): a key longer than one character must stay valid.
    expect(fieldAccepts(idempotencyKeySchema, "a-long-idempotency-key")).toBe(
      true
    );
    expect(fieldAccepts(idempotencyKeySchema, "")).toBe(false);
    expect(descriptionOf(idempotencyKeySchema)).toBe(
      "Stable key for safe retries. If omitted, the MCP server generates a unique key for this call."
    );
  });

  it("describes the confirm gate verbatim on gated tools", () => {
    const confirmSchema = getOperation("broadcasts.launch").inputSchema.confirm;

    expect(descriptionOf(confirmSchema)).toBe(
      "This tool has a real-world side effect: it messages real leads, books, moves, or cancels a call, changes a lead's consent, imports leads, writes to a connected calendar or CRM, sends workspace events to an outside URL, or re-triggers downstream automations. Pass confirm: true to proceed; the call is rejected without it."
    );
  });

  it("describes the maxPages cap verbatim, including the configured limits", () => {
    const maxPagesSchema = getOperation("leads.list").inputSchema.maxPages;

    expect(descriptionOf(maxPagesSchema)).toBe(
      `Max pages the server auto-fetches and merges (default ${DEFAULT_MAX_PAGES}, hard cap 50). If more remain, the result is marked truncated with a nextCursor to continue.`
    );
  });

  it("only attaches the redaction-marker annotation on operations whose route marks a field", () => {
    // No marked field: the early return must hand back the plain fields
    // untouched, so no annotation is ever added to it.
    const withoutRedaction =
      getOperation("capabilities.get").outputSchema.result;

    expect(withoutRedaction?.ast.annotations).toBeUndefined();

    // Marked fields: the marker annotation must actually be attached.
    const withRedaction = getOperation("leads.list").outputSchema.result;

    expect(withRedaction?.ast.annotations).toEqual({
      "x-luca-redacted-fields": [
        "leads[].displayName",
        "leads[].externalUserId",
        "leads[].profilePhotoUrl",
      ],
    });
  });

  it("derives an operation's group from the dot-separated id prefix", () => {
    expect(getOperation("leads.list").group).toBe("leads");
    expect(getOperation("reviewQueue.approve").group).toBe("reviewQueue");
    expect(getOperation("campaigns.commentEvents.list").group).toBe(
      "campaigns"
    );
  });

  it("gives a page shape to the operations that page, and no others", () => {
    expect(getOperation("leads.list").pageContract).toBeDefined();
    expect(getOperation("leads.get").pageContract).toBeUndefined();
    expect(getOperation("bookings.create").pageContract).toBeUndefined();
  });

  it("only advertises idempotency when the call is unconditionally safe", () => {
    // The input key is optional and the HTTP layer mints a fresh key when it
    // is omitted, so a retryable write cannot honestly claim idempotence.
    expect(
      operationAnnotations(getOperation("leads.importPreview"))
    ).toMatchObject({
      readOnlyHint: false,
      idempotentHint: false,
    });
    expect(operationAnnotations(getOperation("leads.create"))).toMatchObject({
      idempotentHint: false,
    });
    expect(
      operationAnnotations(getOperation("conversations.send")).idempotentHint
    ).toBe(false);
    expect(
      operationAnnotations(getOperation("leads.list")).idempotentHint
    ).toBe(true);
  });

  it("gives every operation a hand-written title, distinct and not the tool id", () => {
    expect(getOperation("leads.list").title).toBe("List leads");
    expect(getOperation("campaigns.commentEvents.list").title).toBe(
      "List campaign comment events"
    );
    expect(checkOperationTitles(LUCA_OPERATIONS)).toEqual([]);
  });

  it("gives every operation a distinct, agent-readable description", () => {
    // The description is the only thing an agent reads when it picks between
    // two tools, so an empty or duplicated one makes the pair indistinguishable
    // at the point of choosing. It is written by hand next to the title in
    // `src/operations/groups/`, and nothing else in the type system requires it
    // to say anything.
    const descriptions = LUCA_OPERATIONS.map(
      (operation) => operation.description
    );

    Arr.forEach(LUCA_OPERATIONS, (operation) => {
      expect(
        operation.description.trim(),
        `${operation.id} has an empty description`
      ).not.toBe("");
      expect(
        operation.description.length,
        `${operation.id} has a description too short to choose on`
      ).toBeGreaterThan(10);
      expect(operation.description).toBe(operation.description.trim());
    });

    expect(Arr.dedupe(descriptions)).toHaveLength(descriptions.length);
  });

  it("rejects a title that reads like a tool id, and keeps a provider name", () => {
    expect(
      checkOperationTitles([{ id: "leads.get", title: "Read leads.get" }])
    ).toEqual([
      'leads.get has a machine-shaped title ("Read leads.get"). Write a short human label instead.',
    ]);
    // A dot is not the tell. Cal.com is a booking provider we support, and
    // "Connect Cal.com" is exactly the title that route should carry.
    expect(
      checkOperationTitles([
        { id: "bookings.providers.connect", title: "Connect Cal.com" },
      ])
    ).toEqual([]);
  });

  it("registers reviewQueue.reject as the non-sending half of the approve/reject loop", () => {
    const operation = getOperation("reviewQueue.reject");
    expect(operation).toMatchObject({
      id: "reviewQueue.reject",
      group: "reviewQueue",
      toolName: "luca_review_queue_reject",
      method: "POST",
      path: "/api/review-queue/{id}/reject",
      scopes: ["review_queue:write"],
      idempotencyRequired: true,
      // Unlike approve, reject never dispatches to the lead's channel, so it
      // carries no confirm gate.
    });
    expect(operation.confirm).toBeUndefined();
    expect(operationAnnotations(operation)).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
    expect(operation.buildRequest({ id: "review-1" })).toEqual({
      pathParams: { id: "review-1" },
      workspace: {},
    });
  });

  it("registers reviewQueue.restore to move a rejected item back to pending", () => {
    const operation = getOperation("reviewQueue.restore");
    expect(operation).toMatchObject({
      id: "reviewQueue.restore",
      group: "reviewQueue",
      toolName: "luca_review_queue_restore",
      method: "POST",
      path: "/api/review-queue/{id}/restore",
      scopes: ["review_queue:write"],
      idempotencyRequired: true,
    });
    expect(operation.confirm).toBeUndefined();
    expect(operation.buildRequest({ id: "review-1" })).toEqual({
      pathParams: { id: "review-1" },
      workspace: {},
    });
  });

  it("registers reviewQueue.media.retry as transcription-only, never a send", () => {
    const operation = getOperation("reviewQueue.media.retry");
    expect(operation).toMatchObject({
      id: "reviewQueue.media.retry",
      group: "reviewQueue",
      toolName: "luca_review_queue_media_retry",
      method: "POST",
      path: "/api/review-queue/{id}/media/{mediaId}/retry",
      scopes: ["review_queue:write"],
      idempotencyRequired: true,
    });
    expect(operation.confirm).toBeUndefined();
    expect(
      operation.buildRequest({ id: "review-1", mediaId: "media-1" })
    ).toEqual({
      pathParams: { id: "review-1", mediaId: "media-1" },
      workspace: {},
    });
  });
});

describe("outputSchemaFor redaction marker", () => {
  const base = {
    method: "GET",
    path: "/leads",
    untrustedContent: false,
  } as const;

  const marker = (fields: ToolFields) =>
    fields.result?.ast.annotations?.["x-luca-redacted-fields"];

  it("attaches the redaction marker only for a populated field list", () => {
    // A populated list marks `result`; both an absent list and — the guard
    // under test — an empty list must leave `result` unmarked. Forcing the
    // `length === 0` check false would wrongly stamp an empty marker for `[]`.
    expect(
      marker(outputSchemaFor({ ...base, redactedFields: ["a", "b"] }))
    ).toEqual(["a", "b"]);
    expect(marker(outputSchemaFor(base))).toBeUndefined();
    expect(
      marker(outputSchemaFor({ ...base, redactedFields: [] }))
    ).toBeUndefined();
  });
});

describe("toStandardSchema", () => {
  it("builds each JSON Schema once and hands back the same one", () => {
    const { jsonSchema } = toStandardSchema(Schema.String)["~standard"];
    const options = { target: "draft-2020-12" } as const;

    expect(jsonSchema.input(options)).toBe(jsonSchema.input(options));
    expect(jsonSchema.output(options)).toBe(jsonSchema.output(options));
  });
});
