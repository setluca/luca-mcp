/**
 * The tool sweep's plan: one step per tool, in the order the sweep runs them,
 * with the arguments each needs and the outcome it should have. `run.ts` runs
 * it through the MCP Inspector against a sweep workspace; `test/sweep-plan.test.ts`
 * keeps it covering every tool the server lists.
 *
 * Steps read IDs from fixtures. Discovery steps find the records the seed put in
 * the workspace (a lead, its conversation, a pending draft, a booking that still
 * needs an outcome), and create steps record what they make for the steps after
 * them. A step whose fixture is missing is reported as blocked, which is a
 * failure: it names the record the seed has to add.
 */

import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";

import {
  isJsonArray,
  isJsonObject,
  type JsonObject,
  JsonValue,
} from "../../src/serialization.ts";

/** When a step runs. Steps run in this order, and in plan order within a phase. */
export const SWEEP_PHASES = [
  "discover",
  "read",
  "create",
  "change",
  "draft",
  "remove",
] as const;

export type SweepPhase = (typeof SWEEP_PHASES)[number];

/** The records steps pass to each other, by name. */
export type Fixture =
  // Found in the seeded workspace.
  | "lead"
  | "conversation"
  | "inboundMessage"
  | "mediaMessage"
  | "mediaId"
  | "partialMessage"
  | "replyFailure"
  | "reviewItem"
  | "reviewMediaItem"
  | "reviewMediaId"
  | "draftingTurn"
  | "dismissTurn"
  | "bookingUpcoming"
  | "bookingCompleted"
  | "bookingType"
  | "channel"
  | "campaign"
  | "campaignGraph"
  | "broadcast"
  | "lostReason"
  | "insight"
  | "dismissInsight"
  | "learningProposal"
  | "abTest"
  | "knowledgeSource"
  | "knowledgeSuggestion"
  | "memory"
  | "crmConnection"
  | "callEvent"
  | "recoveryCase"
  | "recoveryVersion"
  | "webhookEvent"
  // Found once a Google calendar is connected to the sweep workspace.
  | "calendar"
  | "calendarId"
  // Made by the sweep.
  | "sweepLead"
  | "note"
  | "sweepBooking"
  | "outcomeReason"
  | "sweepBookingType"
  | "attendee"
  | "sweepCampaign"
  | "simulation"
  | "enrollment"
  | "sweepBroadcast"
  | "previewVersion"
  | "webhookSubscription"
  | "delivery"
  | "googleBookingType"
  | "slotWindow"
  | "slot"
  | "bookCallSlot"
  | "rescheduleSlot"
  | "providerRequest"
  | "providerBooking"
  | "bookCallRequest"
  | "bookCallBooking";

export type Fixtures = Readonly<Record<Fixture, string>>;

/** What a step should do. */
export type Expectation =
  | { readonly kind: "ok" }
  | {
      readonly kind: "refused";
      /** Why the refusal is the right answer here, for the report. */
      readonly because: string;
      /** The tool's error text has to match this. */
      readonly match: RegExp;
    }
  | {
      readonly kind: "pending";
      /** What has to exist before this step can run at all. */
      readonly because: string;
    };

/** The API body a tool returned: its `structuredContent.result`. */
export type ApiBody = JsonValue | undefined;

/** Reads one fixture value out of a tool's API body. */
export type Capture = (body: ApiBody) => string | undefined;

/** Values a step builds its arguments from, beyond the fixtures. */
export type SweepContext = {
  /** Unique per run, so records the sweep creates never collide with an earlier run's. */
  readonly runId: string;
  /** A SetLuca-owned URL that webhook steps may deliver to. */
  readonly webhookUrl: string;
  readonly now: DateTime.Utc;
};

type StepArgs = (fx: Fixtures, ctx: SweepContext) => JsonObject;

export type SweepStep = {
  readonly tool: string;
  readonly phase: SweepPhase;
  /**
   * Set on a second step for a tool that already has its primary step, naming
   * what this call checks beyond the first.
   */
  readonly extra?: string;
  readonly needs?: readonly Fixture[];
  readonly args?: StepArgs;
  /** Defaults to `ok`. */
  readonly expect?: Expectation;
  /**
   * The tool refuses to run without `confirm: true`. The runner calls it once
   * without the flag and expects the gate's refusal, then once with it.
   */
  readonly gated?: true;
  readonly provides?: Readonly<Partial<Record<Fixture, Capture>>>;
  /**
   * Called twice with the same idempotency key. Both calls have to succeed
   * and return the same record, so a retried write does not act twice.
   */
  readonly repeat?: true;
};

/** A non-tool request: the listings, every resource, and every prompt. */
export type SurfaceStep =
  | {
      readonly method:
        | "tools/list"
        | "resources/list"
        | "resources/templates/list"
        | "prompts/list";
    }
  | {
      readonly method: "resources/read";
      readonly needs?: readonly Fixture[];
      readonly uri: (fx: Fixtures) => string;
    }
  | { readonly method: "prompts/get"; readonly name: string };

// ---------------------------------------------------------------------------
// Reading values out of API bodies.

function field(value: ApiBody, key: string): ApiBody {
  return isJsonObject(value) ? value[key] : undefined;
}

/** A string or number value as fixture text; anything else is absent. */
function fixtureText(value: ApiBody): string | undefined {
  if (P.isNumber(value)) {
    return String(value);
  }

  return P.isString(value) && value !== "" ? value : undefined;
}

function listAt(body: ApiBody, key: string): readonly JsonObject[] {
  const list = field(body, key);

  return isJsonArray(list) ? Arr.filter(list, isJsonObject) : [];
}

/** `name` (default `id`) of the first item in `body[key]` that `where` accepts. */
function firstOf(
  key: string,
  where: (item: JsonObject) => boolean = () => true,
  name = "id"
): Capture {
  return (body) =>
    Option.match(Arr.findFirst(listAt(body, key), where), {
      onNone: () => undefined,
      onSome: (item) => fixtureText(item[name]),
    });
}

/** `name` (default `id`) of the item at `index` in `body[key]`. */
function nthOf(key: string, index: number, name = "id"): Capture {
  return (body) => fixtureText(listAt(body, key)[index]?.[name]);
}

/** The value at `path` in the body. */
function valueAt(...path: readonly string[]): Capture {
  return (body) => {
    let value = body;

    for (const key of path) {
      value = field(value, key);
    }

    return fixtureText(value);
  };
}

/** The id of an item's first media attachment, when it has one. */
function firstMediaIdOf(item: JsonObject): string | undefined {
  const media = item.media;

  return isJsonArray(media) ? fixtureText(field(media[0], "id")) : undefined;
}

function hasMediaId(item: JsonObject): boolean {
  return firstMediaIdOf(item) !== undefined;
}

function firstMediaId(key: string): Capture {
  return (body) =>
    Option.match(Arr.findFirst(listAt(body, key), hasMediaId), {
      onNone: () => undefined,
      onSome: firstMediaIdOf,
    });
}

/** Whether an item's `slotAt` is after (`future`) or before now. */
function slotIs(when: "future" | "past") {
  return (item: JsonObject): boolean => {
    const slotAt = item.slotAt;

    if (!P.isString(slotAt)) {
      return false;
    }

    return Option.match(DateTime.make(slotAt), {
      onNone: () => false,
      onSome: (at) =>
        when === "future"
          ? DateTime.isGreaterThan(at, DateTime.nowUnsafe())
          : DateTime.isLessThan(at, DateTime.nowUnsafe()),
    });
  };
}

const decodeJsonText = Schema.decodeUnknownSync(
  Schema.fromJsonString(JsonValue)
);

/** A fixture kept as JSON object text, read back as that object. */
function objectFrom(text: string): JsonObject {
  const value = decodeJsonText(text);

  return isJsonObject(value) ? value : {};
}

/**
 * The connected calendar new bookings go to, kept as the selection
 * `luca_bookings_calendars_select` takes.
 */
const destinationCalendar: Capture = (body) =>
  Option.match(
    Arr.findFirst(
      listAt(body, "calendars"),
      (item) => item.defaultDestination === true
    ),
    {
      onNone: () => undefined,
      onSome: (item) =>
        JSON.stringify({
          provider: item.provider,
          calendarId: item.calendarId,
          name: item.name,
          timezone: item.timezone,
          accessRole: item.accessRole,
        }),
    }
  );

/** The open slot at `index`, kept as the fields a provider booking takes. */
function slotFields(index: number): Capture {
  return (body) => {
    const slot = listAt(body, "slots")[index];

    return slot === undefined
      ? undefined
      : JSON.stringify({
          slotId: slot.id,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          timezone: slot.timezone,
        });
  };
}

/** When the open slot at `index` starts. */
function slotStart(index: number): Capture {
  return (body) => fixtureText(listAt(body, "slots")[index]?.startsAt);
}

// ---------------------------------------------------------------------------
// Expectations shared by many steps.

const CHANNEL_REFUSAL: Expectation = {
  kind: "refused",
  because:
    "The sweep workspace's only channel is a disconnected sample account and its leads last wrote a month ago, so the reply window is closed, a send is refused, and nothing reaches a lead.",
  match: /channel|connect|account|unavailable|not available|cannot send/i,
};

const CRM_REFUSAL: Expectation = {
  kind: "refused",
  because:
    "The sweep workspace's CRM connection is disabled and holds no credentials, so anything that has to call the CRM is refused.",
  match: /crm|provider|credential|connect|token|unauthori[sz]ed/i,
};

/**
 * Every calendar booking the sweep makes invites this SetLuca-owned mailbox,
 * never a real lead.
 */
const SWEEP_INVITEE = "sweep+lead@setluca.com";

/** A Google call type open 09:00 to 17:00 UTC every day, so it has slots. */
const OPEN_EVERY_DAY = Arr.map(Arr.range(0, 6), (weekday) => ({
  weekday,
  startMinute: 540,
  endMinute: 1020,
}));

/** The selection of the connected calendar as the bookings' destination. */
function calendarSelection(fx: Fixtures): JsonObject {
  return {
    body: {
      ...objectFrom(fx.calendar),
      conflictEnabled: true,
      defaultDestination: true,
    },
  };
}

/** An ISO time `days` from now at 10:00 UTC, for bookings the sweep makes. */
function daysAhead(ctx: SweepContext, days: number): string {
  return DateTime.formatIso(
    DateTime.setPartsUtc(DateTime.add(ctx.now, { days }), {
      hour: 10,
      minute: 0,
      second: 0,
      millisecond: 0,
    })
  );
}

/** `{ id }` from one fixture, with any other arguments. */
function idFrom(
  fixture: Fixture,
  more: StepArgs = () => ({})
): Pick<SweepStep, "needs" | "args"> {
  return {
    needs: [fixture],
    args: (fx, ctx) => ({ id: fx[fixture], ...more(fx, ctx) }),
  };
}

const IMPORT_BODY = (ctx: SweepContext) => ({
  source: "sweep",
  rows: [{ handle: `sweep-import-${ctx.runId}`, name: "Sweep Import" }],
  mapping: {
    identity: {
      externalUserIdColumn: "handle",
      displayNameColumn: "name",
      channelDefault: "telegram",
    },
  },
});

// ---------------------------------------------------------------------------
// The plan.

const discover: readonly SweepStep[] = [
  {
    tool: "luca_leads_list",
    phase: "discover",
    provides: { lead: firstOf("leads") },
  },
  {
    tool: "luca_conversations_list",
    phase: "discover",
    provides: { conversation: firstOf("conversations") },
  },
  {
    tool: "luca_conversations_get",
    phase: "discover",
    ...idFrom("conversation"),
    provides: { replyFailure: firstOf("replyFailures") },
  },
  {
    tool: "luca_conversations_messages",
    phase: "discover",
    ...idFrom("conversation"),
    provides: {
      inboundMessage: firstOf("messages", (m) => m.direction === "inbound"),
      mediaMessage: firstOf("messages", hasMediaId),
      mediaId: firstMediaId("messages"),
      partialMessage: firstOf("messages", (m) => Boolean(m.partialRetry)),
    },
  },
  {
    tool: "luca_review_queue_list",
    phase: "discover",
    args: () => ({ query: { status: "pending" } }),
    provides: {
      reviewItem: firstOf("items"),
      reviewMediaItem: firstOf("items", hasMediaId),
      reviewMediaId: firstMediaId("items"),
    },
  },
  {
    tool: "luca_review_queue_drafting",
    phase: "discover",
    // The seed leaves two cancelled turns: the first is cancelled and retried,
    // and the second is dismissed, since a retried turn is open again.
    provides: {
      draftingTurn: nthOf("items", 0, "turnId"),
      dismissTurn: nthOf("items", 1, "turnId"),
    },
  },
  {
    tool: "luca_bookings_list",
    phase: "discover",
    provides: {
      bookingUpcoming: firstOf("bookings", slotIs("future")),
      bookingCompleted: firstOf("bookings", slotIs("past")),
    },
  },
  {
    tool: "luca_bookings_types_list",
    phase: "discover",
    provides: { bookingType: firstOf("bookingTypes") },
  },
  {
    tool: "luca_bookings_calendars_list",
    phase: "discover",
    provides: {
      // Kept as JSON text, because fixtures are strings; the select steps
      // read it back.
      calendar: destinationCalendar,
      calendarId: firstOf(
        "calendars",
        (item) => item.defaultDestination === true,
        "calendarId"
      ),
    },
  },
  {
    tool: "luca_channels_list",
    phase: "discover",
    provides: { channel: firstOf("accounts") },
  },
  {
    tool: "luca_campaigns_list",
    phase: "discover",
    provides: { campaign: firstOf("campaigns") },
  },
  {
    tool: "luca_campaigns_get",
    phase: "discover",
    ...idFrom("campaign"),
    provides: {
      // Kept as JSON text, because fixtures are strings; draft_update parses it back.
      campaignGraph: (body) => {
        const graph = field(field(body, "draft"), "graph");

        return graph === undefined ? undefined : JSON.stringify(graph);
      },
    },
  },
  {
    tool: "luca_broadcasts_list",
    phase: "discover",
    provides: { broadcast: firstOf("broadcasts") },
  },
  {
    tool: "luca_bookings_outcome_reasons_list",
    phase: "discover",
    args: () => ({ query: { kind: "lost_sale" } }),
    provides: { lostReason: firstOf("reasons", (r) => r.active !== false) },
  },
  {
    tool: "luca_analytics_insights",
    phase: "discover",
    // The first is read and actioned, the second dismissed: an actioned
    // insight can no longer be dismissed.
    provides: {
      insight: nthOf("items", 0),
      dismissInsight: nthOf("items", 1),
    },
  },
  {
    tool: "luca_learning_proposals_list",
    phase: "discover",
    provides: { learningProposal: firstOf("insights") },
  },
  {
    tool: "luca_learning_ab_tests_list",
    phase: "discover",
    provides: { abTest: firstOf("tests") },
  },
  {
    tool: "luca_knowledge_sources_list",
    phase: "discover",
    provides: { knowledgeSource: firstOf("sources") },
  },
  {
    tool: "luca_knowledge_suggestions",
    phase: "discover",
    args: () => ({ query: { status: "pending" } }),
    provides: { knowledgeSuggestion: firstOf("suggestions") },
  },
  {
    tool: "luca_memory_list",
    phase: "discover",
    provides: { memory: firstOf("memories") },
  },
  {
    tool: "luca_integrations_crm_connections_list",
    phase: "discover",
    provides: { crmConnection: firstOf("connections") },
  },
  {
    tool: "luca_call_events_by_booking",
    phase: "discover",
    needs: ["bookingCompleted"],
    args: (fx) => ({ bookingId: fx.bookingCompleted }),
    provides: { callEvent: valueAt("callEvent", "id") },
  },
  {
    tool: "luca_bookings_recovery_get",
    phase: "discover",
    ...idFrom("bookingCompleted"),
    provides: {
      recoveryCase: valueAt("recovery", "id"),
      recoveryVersion: valueAt("recovery", "outcomeVersion"),
    },
  },
  {
    tool: "luca_webhooks_events_list",
    phase: "discover",
    args: () => ({ query: { type: "lead.created" } }),
    provides: { webhookEvent: firstOf("events") },
  },
];

const PERIOD = { query: { period: "last_30_days" } };

const read: readonly SweepStep[] = [
  { tool: "luca_capabilities_get", phase: "read" },
  { tool: "luca_leads_get", phase: "read", ...idFrom("lead") },
  { tool: "luca_leads_explain", phase: "read", ...idFrom("lead") },
  { tool: "luca_leads_field_definitions_list", phase: "read" },
  {
    tool: "luca_leads_import_preview",
    phase: "read",
    args: (_fx, ctx) => ({ body: IMPORT_BODY(ctx) }),
  },
  { tool: "luca_review_queue_explain", phase: "read", ...idFrom("reviewItem") },
  { tool: "luca_review_queue_sla", phase: "read" },
  { tool: "luca_review_queue_summary", phase: "read" },
  {
    tool: "luca_review_queue_changes",
    phase: "read",
    args: (_fx, ctx) => ({
      query: {
        since: DateTime.formatIso(DateTime.subtract(ctx.now, { hours: 24 })),
      },
    }),
  },
  { tool: "luca_bookings_get", phase: "read", ...idFrom("bookingUpcoming") },
  {
    tool: "luca_bookings_availability",
    phase: "read",
    args: () => ({ query: { provider: "manual", timezone: "UTC" } }),
  },
  {
    tool: "luca_bookings_types_schedule",
    phase: "read",
    ...idFrom("bookingType"),
  },
  {
    tool: "luca_bookings_types_attendees",
    phase: "read",
    ...idFrom("bookingType"),
  },
  { tool: "luca_bookings_providers_list", phase: "read" },
  {
    tool: "luca_bookings_providers_get",
    phase: "read",
    args: () => ({ provider: "google_calendar" }),
  },
  {
    tool: "luca_bookings_outcome_get",
    phase: "read",
    ...idFrom("bookingCompleted"),
  },
  {
    tool: "luca_bookings_outcome_history",
    phase: "read",
    ...idFrom("bookingCompleted"),
  },
  { tool: "luca_bookings_needs_outcome", phase: "read" },
  { tool: "luca_bookings_lifecycle_attention", phase: "read" },
  { tool: "luca_bookings_brief", phase: "read", ...idFrom("bookingUpcoming") },
  { tool: "luca_call_events_needing_feedback", phase: "read" },
  { tool: "luca_call_events_get", phase: "read", ...idFrom("callEvent") },
  {
    tool: "luca_call_events_by_lead",
    phase: "read",
    needs: ["lead"],
    args: (fx) => ({ leadId: fx.lead }),
  },
  {
    tool: "luca_campaigns_enrollments_list",
    phase: "read",
    ...idFrom("campaign"),
  },
  { tool: "luca_campaigns_analytics", phase: "read", ...idFrom("campaign") },
  {
    tool: "luca_campaigns_provider_capabilities",
    phase: "read",
    ...idFrom("campaign"),
  },
  { tool: "luca_campaigns_comment_events_list", phase: "read" },
  {
    tool: "luca_campaigns_simulations_list",
    phase: "read",
    ...idFrom("campaign"),
  },
  {
    tool: "luca_campaigns_versions_list",
    phase: "read",
    ...idFrom("campaign"),
  },
  { tool: "luca_broadcasts_get", phase: "read", ...idFrom("broadcast") },
  { tool: "luca_webhooks_subscriptions_list", phase: "read" },
  { tool: "luca_webhooks_deliveries_list", phase: "read" },
  { tool: "luca_webhooks_signature_guide", phase: "read" },
  { tool: "luca_integrations_connectors_list", phase: "read" },
  {
    tool: "luca_integrations_crm_sync_runs_list",
    phase: "read",
    ...idFrom("crmConnection"),
  },
  { tool: "luca_integrations_events_list", phase: "read" },
  { tool: "luca_voice_profile", phase: "read" },
  { tool: "luca_voice_corpus", phase: "read" },
  { tool: "luca_coach_profile", phase: "read" },
  { tool: "luca_coach_niche", phase: "read" },
  { tool: "luca_coach_niche_profile", phase: "read" },
  { tool: "luca_coach_objection_playbook", phase: "read" },
  { tool: "luca_coach_post_call_settings", phase: "read" },
  { tool: "luca_coach_post_call_crm_mapping", phase: "read" },
  { tool: "luca_coach_post_call_deal_sync", phase: "read" },
  { tool: "luca_coach_audit_log", phase: "read" },
  { tool: "luca_usage_spend", phase: "read" },
  { tool: "luca_usage_messages", phase: "read" },
  { tool: "luca_safety_accounts", phase: "read" },
  { tool: "luca_channels_catalog", phase: "read" },
  { tool: "luca_channels_features", phase: "read" },
  { tool: "luca_channels_get", phase: "read", ...idFrom("channel") },
  { tool: "luca_reports_scorecard", phase: "read" },
  { tool: "luca_reports_morning", phase: "read" },
  { tool: "luca_insights_unread_count", phase: "read" },
  { tool: "luca_insights_settings_get", phase: "read" },
  { tool: "luca_learning_panel", phase: "read" },
  { tool: "luca_learning_framework_performance", phase: "read" },
  { tool: "luca_learning_ab_tests_get", phase: "read", ...idFrom("abTest") },
  { tool: "luca_analytics_funnel", phase: "read", args: () => PERIOD },
  { tool: "luca_analytics_revenue", phase: "read", args: () => PERIOD },
  { tool: "luca_analytics_speed_impact", phase: "read", args: () => PERIOD },
  { tool: "luca_analytics_forecast", phase: "read" },
  {
    tool: "luca_analytics_call_intelligence",
    phase: "read",
    args: () => PERIOD,
  },
  { tool: "luca_analytics_call_intelligence_calls", phase: "read" },
  { tool: "luca_analytics_ghosted_leads", phase: "read", args: () => PERIOD },
  { tool: "luca_analytics_trust_score", phase: "read", args: () => PERIOD },
  {
    tool: "luca_analytics_lead_score",
    phase: "read",
    needs: ["lead"],
    args: (fx) => ({ leadId: fx.lead }),
  },
  { tool: "luca_analytics_loss_reasons", phase: "read", args: () => PERIOD },
  {
    tool: "luca_analytics_content_attribution",
    phase: "read",
    args: () => PERIOD,
  },
  {
    tool: "luca_analytics_content_performance",
    phase: "read",
    args: () => PERIOD,
  },
  { tool: "luca_analytics_topic_performance", phase: "read" },
  { tool: "luca_analytics_benchmarks", phase: "read" },
  { tool: "luca_analytics_trends", phase: "read" },
  { tool: "luca_analytics_recommendations", phase: "read" },
  { tool: "luca_analytics_benchmark_consent", phase: "read" },
  { tool: "luca_analytics_learning_insights", phase: "read" },
  { tool: "luca_analytics_crm_sync_health", phase: "read" },
  { tool: "luca_analytics_objections", phase: "read" },
  {
    tool: "luca_analytics_objection_drilldown",
    phase: "read",
    args: () => ({ type: "price" }),
  },
  { tool: "luca_triage_inbox", phase: "read", args: () => ({ explainTop: 1 }) },
  { tool: "luca_morning_report", phase: "read" },
  { tool: "luca_find_leads", phase: "read", args: () => ({ query: "Sam" }) },
  { tool: "luca_post_call_queue", phase: "read" },
  { tool: "luca_analytics_rollup", phase: "read" },
  { tool: "luca_analytics_magic_monday", phase: "read" },
  {
    tool: "luca_analytics_deep_dive",
    phase: "read",
    args: () => ({ question: "How did the last 30 days go?" }),
  },
];

const create: readonly SweepStep[] = [
  {
    tool: "luca_leads_create",
    phase: "create",
    args: (_fx, ctx) => ({
      body: {
        channel: "telegram",
        externalUserId: `sweep-${ctx.runId}`,
        displayName: "Sweep Lead",
        tags: ["sweep"],
      },
    }),
    provides: {
      sweepLead: (result) =>
        valueAt("lead", "id")(result) ?? valueAt("id")(result),
    },
  },
  {
    tool: "luca_leads_field_definitions_upsert",
    phase: "create",
    args: () => ({
      body: { key: "sweep_score", label: "Sweep score", type: "number" },
    }),
  },
  {
    tool: "luca_leads_import_apply",
    phase: "create",
    gated: true,
    args: (_fx, ctx) => ({ body: IMPORT_BODY(ctx) }),
  },
  {
    tool: "luca_leads_identities_attach",
    phase: "create",
    ...idFrom("sweepLead", (_fx, ctx) => ({
      body: { channel: "instagram", externalUserId: `sweep-ig-${ctx.runId}` },
    })),
  },
  {
    tool: "luca_leads_consents_grant",
    phase: "create",
    gated: true,
    ...idFrom("sweepLead", (_fx, ctx) => ({
      body: {
        channel: "telegram",
        purpose: "booking_reminders",
        source: "sweep",
        evidenceId: `sweep-${ctx.runId}`,
      },
    })),
  },
  {
    tool: "luca_leads_notes_add",
    phase: "create",
    repeat: true,
    ...idFrom("lead", (_fx, ctx) => ({
      body: { body: `Sweep note ${ctx.runId}` },
    })),
    provides: { note: valueAt("note", "id") },
  },
  {
    tool: "luca_flag_for_human",
    phase: "create",
    needs: ["lead"],
    args: (fx) => ({
      leadId: fx.lead,
      reason: "Sweep check: flag for the coach.",
    }),
  },
  {
    tool: "luca_review_queue_objection_variant",
    phase: "create",
    ...idFrom("reviewItem", () => ({ body: { label: "Sweep variant" } })),
  },
  {
    tool: "luca_bookings_create",
    phase: "create",
    gated: true,
    needs: ["sweepLead"],
    args: (fx, ctx) => ({
      body: {
        leadId: fx.sweepLead,
        slotAt: daysAhead(ctx, 30),
        provider: "manual",
        timezone: "UTC",
      },
    }),
    provides: { sweepBooking: valueAt("booking", "id") },
  },
  {
    tool: "luca_bookings_guest_links_create",
    phase: "create",
    ...idFrom("sweepBooking", () => ({ body: { expiresInHours: 24 } })),
  },
  {
    tool: "luca_bookings_outcome_reasons_create",
    phase: "create",
    repeat: true,
    args: (_fx, ctx) => ({
      body: {
        kind: "lost_sale",
        code: `sweep_${ctx.runId}`,
        label: "Sweep reason",
      },
    }),
    provides: { outcomeReason: valueAt("reason", "id") },
  },
  {
    tool: "luca_bookings_types_create",
    phase: "create",
    args: () => ({
      body: {
        provider: "manual",
        name: "Sweep call",
        timezone: "UTC",
        durationMinutes: 30,
      },
    }),
    provides: { sweepBookingType: valueAt("bookingType", "id") },
  },
  {
    tool: "luca_bookings_calendars_select",
    phase: "create",
    needs: ["calendar"],
    args: calendarSelection,
  },
  {
    tool: "luca_bookings_types_create",
    phase: "create",
    extra: "makes a Google Calendar call type for the provider bookings",
    needs: ["calendarId"],
    args: (fx, ctx) => ({
      body: {
        provider: "google_calendar",
        name: `Sweep Google call ${ctx.runId}`,
        timezone: "UTC",
        durationMinutes: 30,
        destinationCalendarId: fx.calendarId,
      },
    }),
    provides: { googleBookingType: valueAt("bookingType", "id") },
  },
  {
    tool: "luca_bookings_types_schedule_replace",
    phase: "create",
    extra: "opens the Google call type every day, so it has slots to book",
    ...idFrom("googleBookingType", () => ({
      body: { rules: OPEN_EVERY_DAY, overrides: [] },
    })),
  },
  {
    tool: "luca_bookings_managed_availability",
    phase: "create",
    needs: ["googleBookingType"],
    args: (fx, ctx) => ({
      query: {
        bookingTypeId: fx.googleBookingType,
        timezone: "UTC",
        start: daysAhead(ctx, 14),
        end: daysAhead(ctx, 21),
      },
    }),
    provides: {
      slotWindow: slotFields(0),
      bookCallSlot: slotStart(1),
      rescheduleSlot: slotStart(2),
    },
  },
  {
    tool: "luca_bookings_managed_availability",
    phase: "create",
    extra:
      "reads the first slot's own window, since a slot id is tied to the window it was read in",
    needs: ["googleBookingType", "slotWindow"],
    args: (fx) => {
      const window = objectFrom(fx.slotWindow);

      return {
        query: {
          bookingTypeId: fx.googleBookingType,
          timezone: "UTC",
          start: String(window.startsAt),
          end: String(window.endsAt),
        },
      };
    },
    provides: { slot: slotFields(0) },
  },
  {
    tool: "luca_bookings_provider_requests_create",
    phase: "create",
    gated: true,
    needs: ["sweepLead", "googleBookingType", "slot"],
    args: (fx) => ({
      body: {
        ...objectFrom(fx.slot),
        leadId: fx.sweepLead,
        bookingTypeId: fx.googleBookingType,
        inviteeEmail: SWEEP_INVITEE,
        inviteeName: "Sweep Lead",
      },
    }),
    provides: { providerRequest: valueAt("id") },
  },
  {
    tool: "luca_book_call",
    phase: "create",
    gated: true,
    needs: ["sweepLead", "googleBookingType", "bookCallSlot"],
    args: (fx) => ({
      leadId: fx.sweepLead,
      bookingTypeId: fx.googleBookingType,
      slotAt: fx.bookCallSlot,
      inviteeEmail: SWEEP_INVITEE,
      inviteeName: "Sweep Lead",
      timezone: "UTC",
    }),
    provides: { bookCallRequest: valueAt("id") },
  },
  {
    tool: "luca_bookings_types_attendees_add",
    phase: "create",
    ...idFrom("sweepBookingType", () => ({
      body: { email: "sweep-attendee@setluca.com" },
    })),
    provides: { attendee: firstOf("attendees") },
  },
  {
    tool: "luca_call_events_backfill",
    phase: "create",
    needs: ["bookingCompleted"],
    args: (fx) => ({ bookingId: fx.bookingCompleted }),
  },
  {
    tool: "luca_campaigns_create",
    phase: "create",
    repeat: true,
    args: (_fx, ctx) => ({ body: { name: `Sweep campaign ${ctx.runId}` } }),
    provides: { sweepCampaign: valueAt("id") },
  },
  {
    tool: "luca_campaigns_generate",
    phase: "create",
    args: () => ({
      body: {
        mode: "new",
        prompt:
          "A short check-in campaign for leads who asked about coaching prices.",
      },
    }),
  },
  {
    tool: "luca_campaigns_simulations_create",
    phase: "create",
    ...idFrom("campaign", () => ({
      body: { sourceKind: "fake_input", eventType: "instagram_dm" },
    })),
    provides: { simulation: valueAt("id") },
  },
  {
    tool: "luca_campaigns_comment_simulation_suite_run",
    phase: "create",
    ...idFrom("campaign", () => ({ body: { autoSend: false } })),
  },
  { tool: "luca_campaigns_duplicate", phase: "create", ...idFrom("campaign") },
  {
    tool: "luca_broadcasts_create",
    phase: "create",
    needs: ["campaign", "sweepLead"],
    args: (fx, ctx) => ({
      body: {
        campaignId: fx.campaign,
        name: `Sweep broadcast ${ctx.runId}`,
        // Only the sweep's own synthetic lead can ever be a recipient.
        segment: { includeLeadIds: [fx.sweepLead] },
      },
    }),
    provides: { sweepBroadcast: valueAt("id") },
  },
  {
    tool: "luca_webhooks_subscriptions_create",
    phase: "create",
    gated: true,
    args: (_fx, ctx) => ({
      body: { targetUrl: ctx.webhookUrl, eventTypes: ["lead.created"] },
    }),
    provides: { webhookSubscription: valueAt("id") },
  },
  {
    tool: "luca_webhooks_test_delivery",
    phase: "create",
    gated: true,
    needs: ["webhookSubscription"],
    args: () => ({ body: { type: "lead.created" } }),
    provides: {
      delivery: firstOf("deliveries"),
      webhookEvent: valueAt("event", "id"),
    },
  },
  {
    tool: "luca_integrations_crm_oauth_url",
    phase: "create",
    args: () => ({
      provider: "hubspot",
      query: { redirectUri: "https://app.setluca.com/settings/integrations" },
    }),
  },
  {
    tool: "luca_integrations_crm_connections_create",
    phase: "create",
    args: () => ({
      body: { provider: "hubspot", credentialsRef: "sweep-no-credentials" },
    }),
    expect: CRM_REFUSAL,
  },
  {
    tool: "luca_integrations_crm_mappings_suggest",
    phase: "create",
    ...idFrom("crmConnection"),
  },
  {
    tool: "luca_integrations_crm_sync_runs_create",
    phase: "create",
    ...idFrom("crmConnection", () => ({ body: { mode: "dry_run" } })),
  },
];

const change: readonly SweepStep[] = [
  {
    tool: "luca_leads_update",
    phase: "change",
    ...idFrom("sweepLead", () => ({ body: { tags: ["sweep", "updated"] } })),
  },
  {
    tool: "luca_leads_consents_revoke",
    phase: "change",
    ...idFrom("sweepLead", () => ({
      body: { channel: "telegram", purpose: "booking_reminders" },
    })),
  },
  {
    tool: "luca_leads_drafting_pause",
    phase: "change",
    ...idFrom("sweepLead", () => ({ body: { duration: "1h" } })),
  },
  {
    tool: "luca_leads_drafting_resume",
    phase: "change",
    gated: true,
    ...idFrom("sweepLead"),
  },
  {
    tool: "luca_conversations_send",
    phase: "change",
    gated: true,
    ...idFrom("conversation", (_fx, ctx) => ({
      body: { body: "Sweep check message." },
      idempotencyKey: `sweep-${ctx.runId}-send`,
    })),
    expect: CHANNEL_REFUSAL,
  },
  {
    tool: "luca_conversations_send_status",
    phase: "change",
    ...idFrom("conversation", (_fx, ctx) => ({
      query: { idempotencyKey: `sweep-${ctx.runId}-send` },
    })),
  },
  {
    tool: "luca_conversations_partial_send_retry",
    phase: "change",
    gated: true,
    needs: ["conversation", "partialMessage"],
    args: (fx) => ({ id: fx.conversation, messageId: fx.partialMessage }),
    expect: {
      kind: "refused",
      because:
        "The seeded reply's second part may already have reached the lead, so sending it again is refused rather than risking a duplicate.",
      match: /provider acceptance is unknown|cannot safely retry/i,
    },
  },
  {
    tool: "luca_conversations_reply_failure_retry",
    phase: "change",
    gated: true,
    needs: ["conversation", "replyFailure"],
    args: (fx) => ({ id: fx.conversation, failureId: fx.replyFailure }),
    expect: CHANNEL_REFUSAL,
  },
  {
    tool: "luca_conversations_media_retry",
    phase: "change",
    needs: ["conversation", "mediaMessage", "mediaId"],
    args: (fx) => ({
      id: fx.conversation,
      messageId: fx.mediaMessage,
      mediaId: fx.mediaId,
    }),
  },
  {
    tool: "luca_review_queue_approve",
    phase: "change",
    gated: true,
    ...idFrom("reviewItem"),
    expect: CHANNEL_REFUSAL,
  },
  {
    tool: "luca_approve_and_send",
    phase: "change",
    gated: true,
    needs: ["reviewItem"],
    args: (fx) => ({ reviewQueueId: fx.reviewItem }),
    expect: CHANNEL_REFUSAL,
  },
  {
    tool: "luca_review_queue_bulk_approve",
    phase: "change",
    gated: true,
    needs: ["reviewItem"],
    // A bulk call answers 200 and reports each item's outcome, so the closed
    // reply window shows up as that item's failure, not as a tool error.
    args: (fx) => ({ body: { ids: [fx.reviewItem] } }),
  },
  {
    tool: "luca_review_queue_media_retry",
    phase: "change",
    needs: ["reviewMediaItem", "reviewMediaId"],
    args: (fx) => ({ id: fx.reviewMediaItem, mediaId: fx.reviewMediaId }),
  },
  {
    tool: "luca_review_queue_reject",
    phase: "change",
    ...idFrom("reviewItem", () => ({
      body: { reasonCode: "other", note: "Sweep check" },
    })),
  },
  {
    tool: "luca_review_queue_restore",
    phase: "change",
    ...idFrom("reviewItem"),
  },
  {
    tool: "luca_review_queue_regenerate",
    phase: "change",
    gated: true,
    ...idFrom("reviewItem", () => ({ body: { hint: "Keep it shorter." } })),
  },
  {
    tool: "luca_review_queue_bulk_reject",
    phase: "change",
    needs: ["reviewItem"],
    args: (fx) => ({ body: { ids: [fx.reviewItem] } }),
  },
  {
    tool: "luca_review_queue_drafting_cancel",
    phase: "change",
    needs: ["draftingTurn"],
    args: (fx) => ({ turnId: fx.draftingTurn }),
  },
  {
    tool: "luca_review_queue_drafting_retry",
    phase: "change",
    gated: true,
    needs: ["draftingTurn"],
    args: (fx) => ({ turnId: fx.draftingTurn }),
  },
  {
    tool: "luca_bookings_update",
    phase: "change",
    gated: true,
    ...idFrom("sweepBooking", (_fx, ctx) => ({
      body: { slotAt: daysAhead(ctx, 31), timezone: "UTC" },
    })),
  },
  {
    tool: "luca_reschedule_call",
    phase: "change",
    gated: true,
    needs: ["sweepBooking"],
    args: (fx, ctx) => ({
      bookingId: fx.sweepBooking,
      slotAt: daysAhead(ctx, 32),
    }),
  },
  {
    tool: "luca_bookings_outcome_record",
    phase: "change",
    gated: true,
    ...idFrom("bookingCompleted", () => ({
      body: { status: "won", amountMinor: 100_000, currency: "USD" },
    })),
  },
  {
    tool: "luca_close_call_loop",
    phase: "change",
    gated: true,
    needs: ["bookingCompleted", "lostReason"],
    args: (fx) => ({
      bookingId: fx.bookingCompleted,
      attendance: "completed",
      outcome: "lost",
      lossReasonDefinitionId: fx.lostReason,
    }),
  },
  {
    tool: "luca_bookings_lifecycle_resolution",
    phase: "change",
    gated: true,
    ...idFrom("bookingCompleted", () => ({
      body: { status: "completed", reason: "Sweep check" },
    })),
  },
  {
    tool: "luca_bookings_provider_sync_retry",
    phase: "change",
    gated: true,
    ...idFrom("sweepBooking"),
    expect: {
      kind: "refused",
      because:
        "The sweep's booking has no failed provider update, so there is nothing to retry.",
      match: /no failed provider update|provider_sync_not_retryable/i,
    },
  },
  {
    tool: "luca_bookings_outcome_reasons_update",
    phase: "change",
    ...idFrom("outcomeReason", () => ({
      body: { label: "Sweep reason (edited)" },
    })),
  },
  {
    tool: "luca_bookings_types_update",
    phase: "change",
    ...idFrom("sweepBookingType", () => ({
      body: { name: "Sweep call (edited)" },
    })),
  },
  {
    tool: "luca_bookings_types_schedule_replace",
    phase: "change",
    ...idFrom("sweepBookingType", () => ({
      body: {
        rules: [{ weekday: 1, startMinute: 540, endMinute: 1020 }],
        overrides: [],
      },
    })),
  },
  {
    tool: "luca_bookings_provider_requests_get",
    phase: "change",
    ...idFrom("providerRequest"),
    provides: { providerBooking: valueAt("bookingId") },
  },
  {
    tool: "luca_bookings_provider_requests_get",
    phase: "change",
    extra: "reads the booking luca_book_call made, so the sweep can cancel it",
    ...idFrom("bookCallRequest"),
    provides: { bookCallBooking: valueAt("bookingId") },
  },
  {
    tool: "luca_reschedule_call",
    phase: "change",
    extra: "moves the Google Calendar booking, so its calendar event moves",
    gated: true,
    needs: ["providerBooking", "rescheduleSlot"],
    args: (fx) => ({
      bookingId: fx.providerBooking,
      slotAt: fx.rescheduleSlot,
    }),
  },
  {
    tool: "luca_bookings_recovery_stop",
    phase: "change",
    needs: ["bookingCompleted", "recoveryCase", "recoveryVersion"],
    args: (fx) => ({
      id: fx.bookingCompleted,
      body: {
        recoveryCaseId: fx.recoveryCase,
        outcomeVersion: Number(fx.recoveryVersion),
      },
    }),
  },
  {
    tool: "luca_call_events_feedback",
    phase: "change",
    gated: true,
    ...idFrom("callEvent", () => ({ body: { outcome: "no_show" } })),
  },
  {
    tool: "luca_call_events_undo_outcome",
    phase: "change",
    ...idFrom("callEvent"),
  },
  {
    tool: "luca_call_events_summary_generate",
    phase: "change",
    ...idFrom("callEvent"),
  },
  {
    tool: "luca_call_events_summary_replace",
    phase: "change",
    gated: true,
    ...idFrom("callEvent", () => ({
      body: { summary: "Sweep check summary." },
    })),
  },
  {
    tool: "luca_call_events_push_to_crm",
    phase: "change",
    gated: true,
    // It queues the push and answers at once; the CRM is reached later.
    ...idFrom("callEvent"),
  },
  {
    tool: "luca_campaigns_draft_update",
    phase: "change",
    needs: ["sweepCampaign", "campaignGraph"],
    args: (fx) => ({
      id: fx.sweepCampaign,
      body: { graph: decodeJsonText(fx.campaignGraph) },
    }),
  },
  {
    tool: "luca_campaigns_publish",
    phase: "change",
    gated: true,
    ...idFrom("sweepCampaign"),
  },
  {
    tool: "luca_campaigns_set_status",
    phase: "change",
    gated: true,
    ...idFrom("sweepCampaign", () => ({ body: { status: "published" } })),
  },
  {
    tool: "luca_campaigns_enroll",
    phase: "change",
    gated: true,
    needs: ["sweepCampaign", "sweepLead"],
    args: (fx) => ({ id: fx.sweepCampaign, body: { leadId: fx.sweepLead } }),
    provides: { enrollment: valueAt("enrollment", "id") },
  },
  {
    tool: "luca_campaigns_enrollments_timeline",
    phase: "change",
    needs: ["sweepCampaign", "enrollment"],
    args: (fx) => ({ id: fx.sweepCampaign, enrollmentId: fx.enrollment }),
  },
  {
    tool: "luca_campaigns_simulations_get",
    phase: "change",
    needs: ["campaign", "simulation"],
    args: (fx) => ({ id: fx.campaign, simulationId: fx.simulation }),
  },
  {
    tool: "luca_broadcasts_preview",
    phase: "change",
    ...idFrom("sweepBroadcast", () => ({ body: { sampleSize: 1 } })),
    provides: { previewVersion: valueAt("previewVersion") },
  },
  {
    tool: "luca_broadcasts_approve",
    phase: "change",
    needs: ["sweepBroadcast", "previewVersion"],
    args: (fx) => ({
      id: fx.sweepBroadcast,
      body: { previewVersion: fx.previewVersion },
    }),
  },
  {
    tool: "luca_broadcasts_launch",
    phase: "change",
    gated: true,
    ...idFrom("sweepBroadcast"),
  },
  {
    tool: "luca_broadcasts_pause",
    phase: "change",
    ...idFrom("sweepBroadcast", () => ({ body: { reason: "Sweep check" } })),
  },
  {
    tool: "luca_broadcasts_retry",
    phase: "change",
    gated: true,
    ...idFrom("sweepBroadcast", () => ({ body: { failedOnly: true } })),
  },
  {
    tool: "luca_webhooks_subscriptions_update",
    phase: "change",
    gated: true,
    ...idFrom("webhookSubscription", () => ({ body: { status: "paused" } })),
  },
  {
    tool: "luca_webhooks_deliveries_replay",
    phase: "change",
    gated: true,
    needs: ["delivery"],
    args: (fx) => ({ deliveryId: fx.delivery }),
  },
  {
    tool: "luca_webhooks_events_replay",
    phase: "change",
    gated: true,
    needs: ["webhookEvent", "webhookSubscription"],
    args: (fx) => ({
      eventId: fx.webhookEvent,
      body: { subscriptionId: fx.webhookSubscription },
    }),
  },
  {
    tool: "luca_webhooks_events_bulk_replay",
    phase: "change",
    gated: true,
    args: () => ({ body: { eventTypes: ["lead.created"], limit: 1 } }),
  },
  {
    tool: "luca_integrations_crm_connections_schema",
    phase: "change",
    ...idFrom("crmConnection"),
    expect: CRM_REFUSAL,
  },
  {
    tool: "luca_integrations_crm_connections_health",
    phase: "change",
    ...idFrom("crmConnection"),
  },
  {
    tool: "luca_integrations_crm_connections_webhooks_setup",
    phase: "change",
    gated: true,
    ...idFrom("crmConnection"),
  },
  {
    tool: "luca_integrations_crm_mappings_confirm",
    phase: "change",
    ...idFrom("crmConnection", () => ({
      body: {
        mappings: [
          {
            lucaField: "displayName",
            providerField: "firstname",
            direction: "luca_to_crm",
          },
        ],
      },
    })),
  },
  {
    tool: "luca_channels_set_ai_dm_auto_send",
    phase: "change",
    gated: true,
    ...idFrom("channel", () => ({ body: { enabled: true } })),
  },
  {
    tool: "luca_channels_set_ai_dm_auto_send",
    phase: "change",
    extra: "turns auto-send back off, which needs no confirmation",
    ...idFrom("channel", () => ({ body: { enabled: false } })),
  },
  { tool: "luca_insights_mark_read", phase: "change", ...idFrom("insight") },
  {
    tool: "luca_insights_mark_actioned",
    phase: "change",
    ...idFrom("insight"),
  },
  {
    tool: "luca_insights_settings_update",
    phase: "change",
    args: () => ({ body: { digestEnabled: true } }),
  },
  {
    tool: "luca_learning_proposals_dismiss",
    phase: "change",
    ...idFrom("learningProposal"),
  },
  {
    tool: "luca_knowledge_sources_sync",
    phase: "change",
    ...idFrom("knowledgeSource"),
  },
  {
    tool: "luca_memory_update",
    phase: "change",
    ...idFrom("memory", () => ({ body: { content: "Sweep check memory." } })),
  },
  {
    tool: "luca_memory_set_archived",
    phase: "change",
    needs: ["memory"],
    args: (fx) => ({ body: { action: "archive", ids: [fx.memory] } }),
  },
  {
    tool: "luca_memory_set_archived",
    phase: "change",
    extra: "restores the archived memory",
    needs: ["memory"],
    args: (fx) => ({ body: { action: "restore", ids: [fx.memory] } }),
  },
  {
    tool: "luca_cadences_rescue_start",
    phase: "change",
    gated: true,
    needs: ["sweepLead"],
    args: (fx) => ({ body: { leadIds: [fx.sweepLead] } }),
  },
  {
    tool: "luca_cadences_pause",
    phase: "change",
    ...idFrom("sweepLead", () => ({ body: { reason: "Sweep check" } })),
  },
  {
    tool: "luca_rescue_silent_leads",
    phase: "change",
    gated: true,
    needs: ["sweepLead"],
    args: (fx) => ({ leadIds: [fx.sweepLead] }),
  },
  {
    tool: "luca_pause_cadence",
    phase: "change",
    needs: ["sweepLead"],
    args: (fx) => ({ leadId: fx.sweepLead, reason: "Sweep check" }),
  },
];

/**
 * Drafting runs after the review-queue steps, because a new draft for the lead
 * supersedes the pending one those steps act on.
 */
const draft: readonly SweepStep[] = [
  { tool: "luca_leads_draft", phase: "draft", ...idFrom("lead") },
  {
    tool: "luca_draft_reply",
    phase: "draft",
    needs: ["lead"],
    args: (fx) => ({
      leadId: fx.lead,
      guidance: "Ask which day suits a call.",
    }),
  },
];

const remove: readonly SweepStep[] = [
  {
    tool: "luca_leads_notes_delete",
    phase: "remove",
    needs: ["lead", "note"],
    args: (fx) => ({ id: fx.lead, noteId: fx.note }),
  },
  {
    tool: "luca_bookings_types_attendees_remove",
    phase: "remove",
    needs: ["sweepBookingType", "attendee"],
    args: (fx) => ({ id: fx.sweepBookingType, attendeeId: fx.attendee }),
  },
  {
    tool: "luca_bookings_guest_links_revoke",
    phase: "remove",
    ...idFrom("sweepBooking"),
  },
  {
    tool: "luca_bookings_cancel",
    phase: "remove",
    gated: true,
    ...idFrom("sweepBooking"),
  },
  {
    tool: "luca_bookings_types_delete",
    phase: "remove",
    ...idFrom("sweepBookingType"),
  },
  {
    tool: "luca_bookings_cancel",
    phase: "remove",
    extra: "cancels the Google Calendar booking, so its event is removed",
    gated: true,
    ...idFrom("providerBooking"),
  },
  {
    tool: "luca_bookings_cancel",
    phase: "remove",
    extra:
      "cancels the booking luca_book_call made, leaving the calendar clean",
    gated: true,
    ...idFrom("bookCallBooking"),
  },
  {
    tool: "luca_bookings_calendars_remove",
    phase: "remove",
    needs: ["calendarId"],
    args: (fx) => ({
      body: { provider: "google_calendar", calendarId: fx.calendarId },
    }),
  },
  {
    tool: "luca_bookings_calendars_select",
    phase: "remove",
    extra: "selects the calendar again, so the next sweep finds it",
    needs: ["calendar"],
    args: calendarSelection,
  },
  {
    tool: "luca_broadcasts_cancel",
    phase: "remove",
    ...idFrom("sweepBroadcast", () => ({ body: { reason: "Sweep check" } })),
  },
  {
    tool: "luca_webhooks_subscriptions_delete",
    phase: "remove",
    ...idFrom("webhookSubscription"),
  },
  {
    tool: "luca_insights_dismiss",
    phase: "remove",
    ...idFrom("dismissInsight"),
  },
  {
    tool: "luca_knowledge_reject_suggestion",
    phase: "remove",
    ...idFrom("knowledgeSuggestion"),
  },
  {
    tool: "luca_knowledge_sources_disconnect",
    phase: "remove",
    ...idFrom("knowledgeSource"),
  },
  {
    tool: "luca_conversations_reply_failure_dismiss",
    phase: "remove",
    needs: ["conversation", "replyFailure"],
    args: (fx) => ({ id: fx.conversation, failureId: fx.replyFailure }),
  },
  {
    tool: "luca_review_queue_drafting_dismiss",
    phase: "remove",
    needs: ["dismissTurn"],
    args: (fx) => ({ turnId: fx.dismissTurn }),
  },
  {
    tool: "luca_integrations_crm_connections_disconnect",
    phase: "remove",
    gated: true,
    ...idFrom("crmConnection"),
  },
];

/** Every tool step, in run order. */
export const SWEEP_PLAN: readonly SweepStep[] = [
  ...discover,
  ...read,
  ...create,
  ...change,
  ...draft,
  ...remove,
];

/** The listings, every resource, and every prompt, run after the tools. */
export const SWEEP_SURFACES: readonly SurfaceStep[] = [
  { method: "tools/list" },
  { method: "resources/list" },
  { method: "resources/templates/list" },
  { method: "prompts/list" },
  { method: "resources/read", uri: () => "luca://operations" },
  { method: "resources/read", uri: () => "luca://queue/today" },
  { method: "resources/read", uri: () => "luca://voice/profile" },
  {
    method: "resources/read",
    needs: ["lead"],
    uri: (fx) => `luca://lead/${fx.lead}`,
  },
  {
    method: "resources/read",
    needs: ["conversation"],
    uri: (fx) => `luca://thread/${fx.conversation}`,
  },
  { method: "prompts/get", name: "luca-api-planner" },
  { method: "prompts/get", name: "luca-morning-report" },
  { method: "prompts/get", name: "luca-triage-queue" },
  { method: "prompts/get", name: "luca-draft-reply" },
  { method: "prompts/get", name: "luca-close-the-call-loop" },
  { method: "prompts/get", name: "luca-weekly-review" },
  { method: "prompts/get", name: "luca-rescue-silent-leads" },
  { method: "prompts/get", name: "luca-plan-campaign" },
  { method: "prompts/get", name: "luca-plan-broadcast" },
];

/** What a gated tool answers when it is called without `confirm: true`. */
export const CONFIRM_REFUSAL = /requires confirm: true/i;

/**
 * A write tool's answer when the grant lacks its tier. Used by a run with
 * `--scope-check`, signed in with a read-only grant.
 */
export const SCOPE_REFUSAL = /scope|permission|needs_scope|tier|forbidden/i;
