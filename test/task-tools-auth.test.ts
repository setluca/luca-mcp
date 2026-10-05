import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import { assert, describe, expect, it } from "vitest";

import {
  type LucaError,
  LucaHttpError,
  LucaNetworkError,
} from "../src/errors.ts";
import { LucaApi, type LucaRequest } from "../src/http.ts";
import type { JsonObject, JsonValue } from "../src/serialization.ts";
import { LUCA_TASK_TOOLS } from "../src/task-tools.ts";
import { fromTaskTool } from "../src/tool.ts";

type Handler = () => Effect.Effect<JsonValue, LucaError, never>;

function getTool(name: string) {
  const tool = LUCA_TASK_TOOLS.find((candidate) => candidate.name === name);

  assert(tool, `unknown task tool: ${name}`);

  return fromTaskTool(tool);
}

function stubApi(handlers: Record<string, Handler>): LucaApi {
  return {
    request: (input: LucaRequest) => {
      const handler = handlers[input.operation.id];

      assert(
        handler,
        `no stub registered for operation: ${input.operation.id}`
      );

      return handler();
    },
  };
}

function runTool(name: string, api: LucaApi, input: JsonObject) {
  return Effect.runPromise(
    getTool(name).run(input).pipe(Effect.provideService(LucaApi, api))
  );
}

const ok =
  (value: JsonValue): Handler =>
  () =>
    Effect.succeed(value);

const httpError =
  (status: number, body: JsonValue): Handler =>
  () =>
    Effect.fail(new LucaHttpError({ status, statusText: "Refused", body }));

/** Failures that re-authorizing fixes, so a partial answer would hide them. */
const AUTH_FAILURES = [
  {
    name: "a 401",
    handler: httpError(401, { error: { code: "unauthorized" } }),
  },
  {
    name: "a 403 for a missing scope",
    handler: httpError(403, { error: { code: "scope_required" } }),
  },
  {
    name: "a 403 for a capability tier below the route's",
    handler: httpError(403, { error: { code: "needs_scope" } }),
  },
];

/** Failures that leave the other sections worth returning. */
const PARTIAL_FAILURES = [
  {
    name: "a 403 for a plan limit",
    handler: httpError(403, { error: { code: "plan_limit" } }),
  },
  {
    name: "a network error",
    handler: (() =>
      Effect.fail(new LucaNetworkError({ message: "down" }))) as Handler,
  },
];

const ANALYTICS_REPORTS = {
  "analytics.funnel": ok({ report: "funnel" }),
  "analytics.revenue": ok({ report: "revenue" }),
  "analytics.speedImpact": ok({ report: "speed" }),
  "analytics.forecast": ok({ report: "forecast" }),
  "analytics.callIntelligence": ok({ report: "calls" }),
};

const DEEP_DIVE_REPORTS = {
  ...ANALYTICS_REPORTS,
  "analytics.ghostedLeads": ok({ report: "ghosted" }),
  "analytics.trustScore": ok({ report: "trust" }),
};

const ROLLUP_REPORTS = {
  "campaigns.list": ok({ items: [{ id: "c1" }] }),
  "campaigns.analytics": ok({ sent: 3 }),
  "broadcasts.list": ok({ items: [] }),
};

const CLOSE_CALL_LOOP = {
  "callEvents.byBooking": ok({ callEvent: { id: "call-1" } }),
  "callEvents.feedback": ok({ filed: true }),
  "bookings.outcome.record": ok({ episode: { status: "won" } }),
};

const CLOSE_CALL_LOOP_INPUT = {
  bookingId: "booking-1",
  attendance: "completed",
  outcome: "won",
};

const TRIAGE_INBOX = {
  "reviewQueue.list": ok({ items: [{ id: "item-1" }] }),
  "reviewQueue.explain": ok({ reason: "asked for pricing" }),
};

/**
 * One case per section a tool can lose without failing: the tool, the
 * stubs it needs, the operation whose failure is under test, and its input.
 */
const SECTIONS = [
  ...R.keys(ANALYTICS_REPORTS).map((operationId) => ({
    tool: "luca_analytics_magic_monday",
    handlers: ANALYTICS_REPORTS,
    operationId,
    input: {},
  })),
  ...R.keys(DEEP_DIVE_REPORTS).map((operationId) => ({
    tool: "luca_analytics_deep_dive",
    handlers: DEEP_DIVE_REPORTS,
    operationId,
    input: { question: "q" },
  })),
  ...R.keys(ROLLUP_REPORTS).map((operationId) => ({
    tool: "luca_analytics_rollup",
    handlers: ROLLUP_REPORTS,
    operationId,
    input: {},
  })),
  ...R.keys(CLOSE_CALL_LOOP).map((operationId) => ({
    tool: "luca_close_call_loop",
    handlers: CLOSE_CALL_LOOP,
    operationId,
    input: CLOSE_CALL_LOOP_INPUT,
  })),
  {
    tool: "luca_triage_inbox",
    handlers: TRIAGE_INBOX,
    operationId: "reviewQueue.explain",
    input: {},
  },
];

describe("partial-result task tools", () => {
  describe.each(AUTH_FAILURES)("on $name", ({ handler }) => {
    it.each(SECTIONS)(
      "$tool fails when $operationId is refused",
      async ({ tool, handlers, operationId, input }) => {
        // A partial answer would read as "this section is down" and send the
        // agent around a token that needs the coach to sign in again.
        const api = stubApi({ ...handlers, [operationId]: handler });

        await expect(runTool(tool, api, input)).rejects.toBeInstanceOf(
          LucaHttpError
        );
      }
    );
  });

  describe.each(PARTIAL_FAILURES)("on $name", ({ handler }) => {
    it.each(SECTIONS)(
      "$tool still answers when $operationId fails",
      async ({ tool, handlers, operationId, input }) => {
        const api = stubApi({ ...handlers, [operationId]: handler });

        await expect(runTool(tool, api, input)).resolves.toBeDefined();
      }
    );
  });
});

describe("idempotencyKey", () => {
  const keyed = LUCA_TASK_TOOLS.map((tool) => fromTaskTool(tool)).filter(
    (tool) => "idempotencyKey" in tool.inputSchema
  );

  it("is offered by the task tools that write", () => {
    expect(keyed.map((tool) => tool.name).toSorted()).toEqual(
      [
        "luca_approve_and_send",
        "luca_book_call",
        "luca_close_call_loop",
        "luca_draft_reply",
        "luca_flag_for_human",
        "luca_pause_cadence",
        "luca_reschedule_call",
        "luca_rescue_silent_leads",
      ].toSorted()
    );
  });

  it.each(keyed)("$name rejects an empty key", (tool) => {
    const field = tool.inputSchema.idempotencyKey;

    assert(field, `${tool.name} has no idempotencyKey field`);

    const decode = Schema.decodeUnknownOption(field);

    expect(Option.isNone(decode(""))).toBe(true);
    expect(Option.isSome(decode("retry-1"))).toBe(true);
  });
});
