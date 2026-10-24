import * as Arr from "effect/Array";

import { LUCA_OPERATIONS } from "./operations.ts";
import { grantReaches, type LucaCapabilityScope } from "./scopes.ts";
import { LUCA_TASK_TOOLS } from "./task-tools.ts";
import { toolProfile, type ToolSource } from "./tool-profile.ts";

/**
 * Which tool surface a server session exposes.
 *
 * - `full` (default) registers every 1:1 operation tool plus the task tools.
 * - `tasks` trims to the task-shaped tools plus capability discovery, a smaller
 *   intent-level set for coach-facing assistants that don't need raw API
 *   coverage.
 * - `claude` is a fixed read and draft set for a coach who wants Claude kept to
 *   that. The Claude directory listing serves `full`, like every other client.
 */
export type LucaToolset = "full" | "tasks" | "claude";

/**
 * The tools the `claude` toolset exposes, and a test pins it name for name.
 * Coaches who chose `?toolset=claude` rely on it staying read and draft, so a
 * tool that sends, books, or changes settings does not belong here.
 */
export const CLAUDE_TOOL_NAMES: readonly string[] = [
  "luca_triage_inbox",
  "luca_morning_report",
  "luca_find_leads",
  "luca_post_call_queue",
  "luca_analytics_rollup",
  "luca_analytics_magic_monday",
  "luca_analytics_deep_dive",
  "luca_capabilities_get",
  "luca_leads_list",
  "luca_leads_get",
  "luca_leads_explain",
  "luca_conversations_list",
  "luca_conversations_get",
  "luca_conversations_messages",
  "luca_review_queue_list",
  "luca_review_queue_explain",
  "luca_review_queue_sla",
  "luca_bookings_list",
  "luca_bookings_get",
  "luca_bookings_availability",
  "luca_bookings_brief",
  "luca_bookings_needs_outcome",
  "luca_call_events_needing_feedback",
  "luca_call_events_get",
  "luca_channels_list",
  "luca_channels_catalog",
  "luca_reports_scorecard",
  "luca_reports_morning",
  "luca_campaigns_list",
  "luca_campaigns_get",
  "luca_campaigns_analytics",
  "luca_broadcasts_list",
  "luca_broadcasts_get",
  "luca_voice_profile",
  "luca_analytics_funnel",
  "luca_analytics_ghosted_leads",
  "luca_analytics_objections",
  "luca_analytics_insights",
  "luca_memory_list",
  "luca_draft_reply",
  "luca_flag_for_human",
  "luca_leads_notes_add",
  "luca_leads_update",
];

/**
 * What one toolset registers. `tools` is an allowlist of tool names, absent
 * for every tool. `grantFiltered` hides a tool whose OAuth scope outranks the
 * connection's grant, so a read-only grant never lists a tool it cannot call.
 * Only the `claude` toolset does that; the others list the same tools for
 * every caller and let the API refuse.
 */
export type ToolsetDefinition = {
  readonly tools?: readonly string[];
  readonly hiddenPrompts: readonly string[];
  readonly grantFiltered: boolean;
};

export const TOOLSETS: Readonly<Record<LucaToolset, ToolsetDefinition>> = {
  full: { hiddenPrompts: [], grantFiltered: false },
  tasks: {
    tools: [
      "luca_capabilities_get",
      ...LUCA_TASK_TOOLS.map((tool) => tool.name),
    ],
    hiddenPrompts: [],
    grantFiltered: false,
  },
  claude: {
    tools: CLAUDE_TOOL_NAMES,
    hiddenPrompts: [
      "luca-rescue-silent-leads",
      "luca-plan-campaign",
      "luca-plan-broadcast",
      "luca-close-the-call-loop",
      // These name approve-and-send, reject, or learning tools the set leaves out.
      "luca-triage-queue",
      "luca-draft-reply",
      "luca-weekly-review",
    ],
    grantFiltered: true,
  },
};

/** Who one server session is for. */
export type ToolSession = {
  readonly toolset: LucaToolset;
  /**
   * The capability tier the connection's OAuth grant holds. Absent for a
   * developer key, which has no grant to read.
   */
  readonly grant?: LucaCapabilityScope;
};

/**
 * The tools one session lists, operations first and then task tools, each in
 * catalog order. A toolset with an allowlist keeps only the tools it names. A
 * grant-filtered toolset also drops every tool the grant does not reach, so a
 * read-only grant never lists a tool it cannot call; a session with no grant
 * keeps them all.
 */
export function sessionTools(session: ToolSession): readonly ToolSource[] {
  const { tools, grantFiltered } = TOOLSETS[session.toolset];
  const { grant } = session;

  const inToolset = (source: ToolSource) =>
    tools === undefined || Arr.contains(tools, toolProfile(source).name);

  const reachable = (source: ToolSource) =>
    !grantFiltered ||
    grant === undefined ||
    grantReaches(grant, toolProfile(source).oauthScope);

  return Arr.filter(
    [...LUCA_OPERATIONS, ...LUCA_TASK_TOOLS],
    (source) => inToolset(source) && reachable(source)
  );
}

// Only "tasks" and "claude" select a trimmed surface; every other value,
// including an unset query param, takes the full-surface branch.
export function parseToolset(value: string | undefined): LucaToolset {
  return value === "tasks" || value === "claude" ? value : "full";
}
