import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { formatError, type LucaError } from "../errors.ts";
import { NonEmptyString, WORKSPACE_INPUT_FIELDS } from "../fields.ts";
import type { LucaApi } from "../http.ts";
import type { LucaOperationId } from "../operations.ts";
import { optionalField } from "../optional-field.ts";
import type { JsonValue } from "../serialization.ts";
import {
  failureAsField,
  listingIds,
  numberInput,
  operationResult,
  resultOrError,
  sectionResult,
  type TaskCall,
  taskTool,
} from "./runtime.ts";

const DEFAULT_CAMPAIGN_LIMIT = 5;

const CAMPAIGN_BROADCAST_LIMIT = 10;

const ANALYTICS_PERIOD_VALUES = [
  "this_week",
  "this_month",
  "last_week",
  "last_month",
  "last_30_days",
] as const;

const decodeAnalyticsPeriod = Schema.decodeUnknownOption(
  Schema.Literals(ANALYTICS_PERIOD_VALUES)
);

/**
 * One analytics read, keyed by the name it lands under in a task tool's
 * output object. `periodScoped: false` marks `analytics.forecast`, the one
 * read that is always point-in-time and never takes a `period` query param.
 * That is a real behavioral difference rather than an oversight, so it has to
 * survive whatever list this read appears in.
 */
type AnalyticsRead<Id extends LucaOperationId = LucaOperationId> = {
  readonly key: string;
  readonly id: Id;
  readonly periodScoped: boolean;
};

/**
 * Every analytics read either task tool below can compose. magic_monday and
 * deep_dive each build their own list from these entries, so the two tools
 * cannot drift apart on order or on which reads are period-scoped. A read whose
 * id is missing from the tool's `composes` does not compile.
 */
const ANALYTICS_READS = {
  funnel: { key: "funnel", id: "analytics.funnel", periodScoped: true },
  revenue: { key: "revenue", id: "analytics.revenue", periodScoped: true },
  speedImpact: {
    key: "speedImpact",
    id: "analytics.speedImpact",
    periodScoped: true,
  },
  forecast: {
    key: "forecast",
    id: "analytics.forecast",
    periodScoped: false,
  },
  callIntelligence: {
    key: "callIntelligence",
    id: "analytics.callIntelligence",
    periodScoped: true,
  },
  ghostedLeads: {
    key: "ghostedLeads",
    id: "analytics.ghostedLeads",
    periodScoped: true,
  },
  trustScore: {
    key: "trustScore",
    id: "analytics.trustScore",
    periodScoped: true,
  },
} as const satisfies Record<string, AnalyticsRead>;

/** The five reads luca_analytics_magic_monday composes, always this_week. */
const MAGIC_MONDAY_READS = [
  ANALYTICS_READS.funnel,
  ANALYTICS_READS.revenue,
  ANALYTICS_READS.speedImpact,
  ANALYTICS_READS.forecast,
  ANALYTICS_READS.callIntelligence,
] as const;

/** magic_monday's five reads plus the two extra deep-dive-only reads. */
const DEEP_DIVE_READS = [
  ...MAGIC_MONDAY_READS,
  ANALYTICS_READS.ghostedLeads,
  ANALYTICS_READS.trustScore,
] as const;

/** A section the report left out because its read failed. */
const FailedSection = Schema.Struct({
  section: Schema.String,
  error: Schema.String,
});

/**
 * Each read's response under the key it lands at, present when the read
 * succeeded, plus `failedSections` naming each read that did not.
 */
function analyticsOutput(reads: readonly AnalyticsRead[]) {
  return Schema.Struct({
    ...R.fromEntries(
      reads.map((read) => [
        read.key,
        Schema.optionalKey(operationResult(read.id)),
      ])
    ),
    failedSections: Schema.optionalKey(
      Schema.Array(FailedSection).annotate({
        description:
          "Sections missing from this report because their read failed. The report is partial whenever this is present.",
      })
    ),
  });
}

/** One section's read, keyed by the name it lands under in the report. */
type SectionOutcome = {
  readonly key: string;
  readonly result: Result.Result<JsonValue, LucaError>;
};

/**
 * Fold the outcome of each section into one report. A failed section is left
 * out and named in `failedSections`, so the numbers that did load still reach
 * the coach. The call fails only when every section does, since an empty
 * report answers nothing.
 */
function collectSections(
  outcomes: readonly SectionOutcome[]
): Effect.Effect<Record<string, JsonValue>, LucaError, never> {
  const sections = outcomes.flatMap(({ key, result }) =>
    Result.isSuccess(result) ? [[key, result.success] as const] : []
  );

  const failures = outcomes.flatMap(({ key, result }) =>
    Result.isFailure(result) ? [{ key, error: result.failure }] : []
  );

  return Arr.match(failures, {
    onEmpty: () => Effect.succeed(R.fromEntries(sections)),
    onNonEmpty: (failed) =>
      Arr.isReadonlyArrayEmpty(sections)
        ? Effect.fail(Arr.headNonEmpty(failed).error)
        : Effect.succeed({
            ...R.fromEntries(sections),
            failedSections: failed.map(({ key, error }) => ({
              section: key,
              error: formatError(error),
            })),
          }),
  });
}

/**
 * Run a list of analytics reads in parallel and return them keyed by `key`.
 * Effect.all defaults to concurrency 1 (sequential); these reads don't depend
 * on each other, so serializing them would only add latency, not correctness.
 *
 * One failed read leaves its section out and names it in `failedSections`; see
 * {@link collectSections}. A refused token or missing scope fails the whole
 * report instead, see {@link sectionResult}.
 */
function analyticsFanOut<Id extends LucaOperationId>(
  call: TaskCall<Id>,
  period: string,
  reads: readonly AnalyticsRead<Id>[]
): Effect.Effect<Record<string, JsonValue>, LucaError, LucaApi> {
  return Effect.forEach(
    reads,
    (read) =>
      sectionResult(
        call(read.id, {
          ...optionalField("query", read.periodScoped ? { period } : undefined),
        })
      ).pipe(Effect.map((result) => ({ key: read.key, result }))),
    { concurrency: "unbounded" }
  ).pipe(Effect.flatMap(collectSections));
}

/**
 * Analytics for each campaign on a listing page, keyed by campaign id. One
 * campaign's failure is reported in its slot rather than dropping the rollup
 * for every other campaign, unless it is an authorization failure, see
 * {@link failureAsField}.
 */
function campaignAnalytics(
  call: TaskCall<"campaigns.analytics">,
  page: JsonValue,
  limit: number
): Effect.Effect<JsonValue, LucaError, LucaApi> {
  return Effect.forEach(
    listingIds(page, limit),
    (id) =>
      failureAsField(
        "analyticsError",
        call("campaigns.analytics", { pathParams: { id } })
      ).pipe(Effect.map((analytics): [string, JsonValue] => [id, analytics])),
    // Effect.forEach also defaults to concurrency 1. The limit caps this at 5
    // independent per-campaign lookups, so unbounded is fine.
    { concurrency: "unbounded" }
  ).pipe(Effect.map(R.fromEntries));
}

const getAnalytics = taskTool({
  name: "luca_analytics_rollup",
  title: "Get campaign and broadcast analytics",
  description:
    "Roll up performance across the coach's campaigns (per-campaign analytics for up to 5 recent campaigns) and recent broadcasts. When one half fails to load, the other still comes back and failedSections names the one that is missing. Example: call with {} for the default rollup, or { campaignLimit: 3 }.",
  inputSchema: {
    ...WORKSPACE_INPUT_FIELDS,
    campaignLimit: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })).annotate({
        description: "How many recent campaigns to include (default 5).",
      })
    ),
  },
  outputSchema: Schema.Struct({
    campaigns: Schema.optionalKey(
      Schema.Record(
        Schema.String,
        resultOrError("campaigns.analytics", "analyticsError")
      )
    ),
    broadcasts: Schema.optionalKey(operationResult("broadcasts.list")),
    failedSections: Schema.optionalKey(
      Schema.Array(FailedSection).annotate({
        description:
          "Sections missing from this rollup because their read failed (campaigns, broadcasts). The rollup is partial whenever this is present.",
      })
    ),
  }),
  composes: ["campaigns.list", "campaigns.analytics", "broadcasts.list"],
  run: (call, input) =>
    Effect.gen(function* () {
      const campaignLimit = numberInput(
        input.campaignLimit,
        DEFAULT_CAMPAIGN_LIMIT
      );

      const campaignPage = yield* sectionResult(
        call("campaigns.list", { query: { limit: campaignLimit } })
      );

      // broadcasts.list doesn't depend on the per-campaign analytics loop, so
      // it runs alongside it instead of after it. Effect.all defaults to
      // concurrency 1 (sequential), so without `concurrency: "unbounded"` here
      // the broadcasts call would still wait on the whole loop below.
      const [campaigns, broadcasts] = yield* Effect.all(
        [
          Result.match(campaignPage, {
            onFailure: (error) => Effect.succeed(Result.fail(error)),
            onSuccess: (page) =>
              sectionResult(campaignAnalytics(call, page, campaignLimit)),
          }),
          sectionResult(
            call("broadcasts.list", {
              query: { limit: CAMPAIGN_BROADCAST_LIMIT },
            })
          ),
        ] as const,
        { concurrency: "unbounded" }
      );

      return yield* collectSections([
        { key: "campaigns", result: campaigns },
        { key: "broadcasts", result: broadcasts },
      ]);
    }),
});

const magicMonday = taskTool({
  name: "luca_analytics_magic_monday",
  title: "Get the Magic Monday report",
  description:
    "Return the coach's weekly business intelligence report: pipeline funnel, revenue and ROI, response-speed impact, a point-in-time revenue forecast, and call intelligence (show/close rates), all for the current week. Composes five analytics reads into a single call. Example: call with {} on Monday morning for the week's report.",
  inputSchema: {
    ...WORKSPACE_INPUT_FIELDS,
  },
  outputSchema: analyticsOutput(MAGIC_MONDAY_READS),
  composes: [
    "analytics.funnel",
    "analytics.revenue",
    "analytics.speedImpact",
    "analytics.forecast",
    "analytics.callIntelligence",
  ],
  run: (call) => analyticsFanOut(call, "this_week", MAGIC_MONDAY_READS),
});

const analyticsDeepDive = taskTool({
  name: "luca_analytics_deep_dive",
  title: "Run a deep-dive analytics investigation",
  description:
    'Answer a specific business question by composing all seven analytics reads in one call: pipeline funnel, revenue and ROI, response-speed impact, a point-in-time revenue forecast, call intelligence (show/close rates), ghosted-lead recovery, and coach trust/auto-send status. Broader than luca_analytics_magic_monday (which is the fixed weekly report); use this when the coach asks a specific question that needs cross-referencing several of these numbers together. Example: call with {question: "why did close rate drop this month?", period: "this_month"}.',
  inputSchema: {
    ...WORKSPACE_INPUT_FIELDS,
    question: Schema.optionalKey(
      NonEmptyString.check(Schema.isMaxLength(500)).annotate({
        description:
          "Optional. The coach's question behind this investigation, e.g. 'why did close rate drop this month?'. Not sent to any API; it only records what the coach asked.",
      })
    ),
    period: Schema.optionalKey(
      Schema.Literals(ANALYTICS_PERIOD_VALUES).annotate({
        description:
          "Period for the period-scoped reads (funnel, revenue, speedImpact, callIntelligence, ghostedLeads, trustScore). Forecast ignores this — it is always point-in-time. Defaults to this_month.",
      })
    ),
  },
  outputSchema: analyticsOutput(DEEP_DIVE_READS),
  composes: [
    "analytics.funnel",
    "analytics.revenue",
    "analytics.speedImpact",
    "analytics.forecast",
    "analytics.callIntelligence",
    "analytics.ghostedLeads",
    "analytics.trustScore",
  ],
  run: (call, input) => {
    const period = Option.getOrElse(
      decodeAnalyticsPeriod(input.period),
      () => "this_month" as const
    );

    return analyticsFanOut(call, period, DEEP_DIVE_READS);
  },
});

export const analyticsTaskTools = [
  getAnalytics,
  magicMonday,
  analyticsDeepDive,
];
