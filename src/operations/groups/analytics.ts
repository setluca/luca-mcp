import { op } from "../registry.ts";
import type { LucaOperation } from "../registry.ts";

export const analyticsOperations: readonly LucaOperation[] = [
  op({
    id: "analytics.funnel",
    title: "Read the funnel",
    description:
      "Pipeline funnel stage counts with period and channel filters. Returns counts and conversion rates for each funnel stage plus period-over-period deltas.",
  }),
  op({
    id: "analytics.revenue",
    title: "Read revenue",
    description:
      "Revenue attribution and plan ROI for a period. Returns total revenue, ROI, and a per-channel revenue breakdown.",
  }),
  op({
    id: "analytics.speedImpact",
    title: "Read what reply speed is worth",
    description:
      "Fast-vs-slow first-reply booking-rate impact for a period. Returns fast- and slow-reply conversion rates, a lost-opportunity estimate, and the peak performance reply window.",
  }),
  op({
    id: "analytics.forecast",
    title: "Read the revenue forecast",
    description:
      "Point-in-time pipeline revenue forecast with on-track, optimistic, and conservative scenarios based on pipeline stage probabilities and historical conversion rates.",
  }),
  op({
    id: "analytics.callIntelligence",
    title: "Read call intelligence",
    description:
      "Post-call intelligence for a period: show rate, close rate, average rating and rating distribution, call-to-close lag, repeat-call cohort, day-of-week and call-sequence show rates, and surprise patterns, derived from post-call events and coach-recorded outcomes.",
  }),
  op({
    id: "analytics.callIntelligenceCalls",
    title: "List calls behind call intelligence",
    description:
      "Most recent completed calls with a generated summary, newest first: the coach-facing summary, attendance outcome, rating, and lead name.",
    // The summary is generated from what the lead said on the call and the
    // lead name comes off their channel profile, so both are text the lead
    // controls. Same reasoning as the `callEvents.summary.*` overrides.
    untrustedContent: true,
  }),
  op({
    id: "analytics.ghostedLeads",
    title: "List ghosted leads",
    description:
      "Ghosted-lead counts, rescue-recovery rate, lost-revenue estimate, and top conversation-killer clusters for a period.",
    // Each top-killer cluster label is free text drawn from lead messages.
    untrustedContent: true,
  }),
  op({
    id: "analytics.trustScore",
    title: "Read the trust score",
    description:
      "Draft approval, edit, and rejection rates plus the auto-send gate flag for a period.",
  }),
  op({
    id: "analytics.leadScore",
    title: "Read a lead's score",
    description:
      "Predictive booking-likelihood score (0-100) for one lead from the coach's trained bucket-rate model, with a confidence tier and the top contributing features. Honest about insufficient data: an under-trained model returns a null score and low confidence instead of a fabricated number.",
  }),
  op({
    id: "analytics.lossReasons",
    title: "Read why deals are lost",
    description:
      "Category breakdown of automatic 'why you lost' analyses for a period: count and estimated lost revenue per category (price objection, ghosted after a call-to-action, competitor, slow reply, bad fit, other), derived from a per-lead loss analysis generated when a lead goes silent or lost.",
  }),
  op({
    id: "analytics.contentAttribution",
    title: "Read which content brings leads",
    description:
      "Per-content rollup (leads touched, qualified, booked, revenue) of attributed touches for a period. Content is attributed automatically from an Instagram comment or Story reply that carries a real media id, or tagged manually; an honest empty list means no content is attributed yet, not zero performance.",
  }),
  op({
    id: "analytics.contentPerformance",
    title: "Read content performance",
    description:
      "Per-post rollup (reach, engagement rate, likes/comments/saves/shares, attributed leads/bookings/revenue) for each Instagram post, reel, story, or carousel over a period. Insight fields stay null until the coach's account grants Instagram insights access — read that as not connected yet, not zero engagement.",
  }),
  op({
    id: "analytics.topicPerformance",
    title: "Read topic performance",
    description:
      "Weekly rollup by normalized content topic (post count, average engagement rate, attributed leads/bookings/revenue per theme). Defaults to the most recently computed week when weekStart is omitted; an empty items list is the honest, expected state until content topics are extracted, not zero performance.",
  }),
  op({
    id: "analytics.benchmarks",
    title: "Read peer benchmarks",
    description:
      "This coach's own cross-coach benchmark percentiles (e.g. 'top 15% for response speed among fitness coaches'), never another coach's data. `comingSoon: true` with an empty metrics list is the honest, expected state until the cross-coach benchmark pipeline populates this coach's row — never a fabricated comparison.",
  }),
  op({
    id: "analytics.insights",
    title: "List insights",
    description:
      "The coach's proactive-insights feed (metric drops/spikes, opportunities, risks, milestones) surfaced by the daily insight-detection cron, newest first. Optionally filter to one status via the status query param (e.g. unread). An empty items list is the honest, expected state for a coach nothing has been flagged for yet — never a fabricated alert.",
  }),
  op({
    id: "analytics.trends",
    title: "Read trends",
    description:
      "The coach's weekly metrics as a trend series (leads, qualified, booked, revenue, and rates week over week) for charting direction of travel. An empty series is the honest, expected state until enough weeks of history accrue — never fabricated points.",
  }),
  op({
    id: "analytics.recommendations",
    title: "Read recommendations",
    description:
      "The coach's active prescriptive recommendations for a week (what to change and why), generated weekly from detected insights and deduped by title. An empty list is the honest, expected state when nothing is recommended for the window — never a fabricated action.",
    // The recommender is handed a verbatim lead-message excerpt per
    // conversation-killer cluster, which `packages/agents/src/recommendations.ts`
    // labels UNTRUSTED and tells the model to use "for color", so the body is
    // the one field here that can echo a lead's own words back out.
    untrustedContent: true,
  }),
  op({
    id: "analytics.benchmarkConsent",
    title: "Check benchmark sharing consent",
    description:
      "The coach's cross-coach benchmark opt-in state (whether this workspace contributes to and sees anonymized niche cohort percentiles). Read-only; the opt-in is changed from the app, not through this key surface.",
  }),
  op({
    id: "analytics.learningInsights",
    title: "Read what Luca has learned",
    description:
      "Read-only rollup of the agent-improvement signals mined from post-call feedback for a period: total/applied/pending signal counts, a per-type breakdown (qualification, objection handling, lead quality, general), and recent example notes. An empty rollup is the honest, expected state until the coach submits call feedback — never fabricated learning.",
  }),
  op({
    id: "analytics.crmSyncHealth",
    title: "Check CRM sync health",
    description:
      "Aggregate CRM-sync health for the coach's post-call summaries: counts of synced, pending, local-only, failed, and permanently-failed pushes. All zeros is the honest, expected state for a coach with no synced summaries yet — never a fabricated status.",
  }),
  op({
    id: "analytics.objections",
    title: "Read objection patterns",
    description:
      "Objection-bucket rollup over the review queue's qualifier signals for a period (price, timing, trust, fit, authority, smokescreen): per-bucket occurrence count, distinct leads, handled rate, wins, and up to three of the most frequent verbatim lead quotes. Filter by channel. An empty bucket list is the honest, expected state until objections are raised — never fabricated.",
    // `topPhrases` is lifted verbatim out of the lead's own messages by
    // `objectionRollup` in packages/db, so an objection a lead phrases as an
    // instruction arrives here as one.
    untrustedContent: true,
  }),
  op({
    id: "analytics.objectionDrilldown",
    title: "Drill into one objection type",
    description:
      "Per-conversation drilldown for one objection bucket: one row per matching conversation with the lead's display name, the verbatim objection quote, whether the draft was sent without an edit, and the lead's most recent call outcome. Bounded by a limit with a hasMore truncation flag; an empty list is the honest, expected state for a bucket with no conversations in the window.",
    // The row-level half of the rollup above: `phrase` is the same verbatim
    // lead quote, and `leadDisplayName` is whatever the lead set on their
    // channel profile.
    untrustedContent: true,
  }),
];
