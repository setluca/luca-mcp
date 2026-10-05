import * as R from "effect/Record";

import { analyticsOperations } from "./groups/analytics.ts";
import { bookingsOperations } from "./groups/bookings.ts";
import { broadcastsOperations } from "./groups/broadcasts.ts";
import { cadencesOperations } from "./groups/cadences.ts";
import { callEventsOperations } from "./groups/callEvents.ts";
import { campaignsOperations } from "./groups/campaigns.ts";
// The operation table: every public Luca API route this server exposes as a
// tool, one `op({...})` entry per route, split into one file per group under
// `groups/`. Data only. The model that gives those entries their shape lives in
// `registry.ts`, and the views derived from the table (the manifest, the group
// summary) live in `manifest.ts`, so adding a route stays a one-entry edit in
// the file its group already owns.
import { capabilitiesOperations } from "./groups/capabilities.ts";
import { channelsOperations } from "./groups/channels.ts";
import { coachOperations } from "./groups/coach.ts";
import { conversationsOperations } from "./groups/conversations.ts";
import { insightsOperations } from "./groups/insights.ts";
import { integrationsOperations } from "./groups/integrations.ts";
import { knowledgeOperations } from "./groups/knowledge.ts";
import { leadsOperations } from "./groups/leads.ts";
import { learningOperations } from "./groups/learning.ts";
import { memoryOperations } from "./groups/memory.ts";
import { reportsOperations } from "./groups/reports.ts";
import { reviewQueueOperations } from "./groups/reviewQueue.ts";
import { safetyOperations } from "./groups/safety.ts";
import { usageOperations } from "./groups/usage.ts";
import { voiceOperations } from "./groups/voice.ts";
import { webhooksOperations } from "./groups/webhooks.ts";
import type { LucaOperation } from "./registry.ts";

export const LUCA_OPERATIONS: readonly LucaOperation[] = [
  ...capabilitiesOperations,
  ...leadsOperations,
  ...conversationsOperations,
  ...reviewQueueOperations,
  ...bookingsOperations,
  ...callEventsOperations,
  ...campaignsOperations,
  ...broadcastsOperations,
  ...webhooksOperations,
  ...integrationsOperations,
  ...voiceOperations,
  ...coachOperations,
  ...usageOperations,
  ...safetyOperations,
  ...channelsOperations,
  ...reportsOperations,
  ...insightsOperations,
  ...learningOperations,
  ...knowledgeOperations,
  ...memoryOperations,
  ...cadencesOperations,
  ...analyticsOperations,
];

const OPERATIONS_BY_ID: Readonly<Record<string, LucaOperation>> = R.fromEntries(
  LUCA_OPERATIONS.map((operation) => [operation.id, operation] as const)
);

/**
 * The catalog entry for an id. Callers name ids in code, so a missing entry is
 * a wiring bug rather than a runtime condition, and it throws where the first
 * test that touches the caller will see it.
 */
export function operationById(id: string): LucaOperation {
  const operation = OPERATIONS_BY_ID[id];

  if (operation === undefined) {
    // oxlint-disable-next-line effect/avoid-untagged-errors -- a missing catalog entry is a programming error, not a runtime failure
    throw new Error(`Luca operation ${id} is not in the catalog.`);
  }

  return operation;
}
