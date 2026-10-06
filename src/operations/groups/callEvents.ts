import { isJsonObject, type JsonValue } from "../../serialization.ts";
import { op } from "../registry.ts";
import type { LucaOperation } from "../registry.ts";

function isNoShowReport(body: JsonValue | undefined): boolean {
  return isJsonObject(body) && body.outcome === "no_show";
}

export const callEventsOperations: readonly LucaOperation[] = [
  op({
    id: "callEvents.needingFeedback",
    title: "List calls still needing a report",
    description:
      "List calls whose time has passed that still need the coach to say what happened. The post-call work queue.",
  }),
  op({
    id: "callEvents.get",
    title: "Get a call event",
    description:
      "Read one call event: outcome, rating, summary, and CRM sync state.",
  }),
  op({
    id: "callEvents.byBooking",
    title: "Get a booking's call event",
    description:
      "Find the call event attached to a booking. A booking whose call hasn't happened yet returns 404, which is normal.",
  }),
  op({
    id: "callEvents.byLead",
    title: "List a lead's call events",
    description:
      "Read a lead's full call history, oldest first, so a second or third call reads in sequence.",
  }),
  op({
    id: "callEvents.feedback",
    title: "Report how a call went",
    // A no-show report can start recovery messaging to the lead.
    openWorld: true,
    mutatesExisting: true,
    untrustedContent: true,
    // Only a no_show can start recovery that messages the lead, so only that
    // report needs approval. The other outcomes stay ungated.
    confirm: {
      applies: (input) => isNoShowReport(input.body),
      description: "outcome is no_show (can start recovery messaging)",
    },
    description:
      "File the coach's report on how a call went. A completed or no_show outcome also records booking attendance, and a completed call queues its summary.",
  }),
  op({
    id: "callEvents.summary.generate",
    title: "Generate a call summary",
    mutatesExisting: true,
    untrustedContent: true,
    description:
      "Queue a fresh summary and return straight away. Poll the call event for the result.",
  }),
  op({
    id: "callEvents.summary.replace",
    title: "Replace a call summary",
    openWorld: true,
    confirm: "always",
    mutatesExisting: true,
    untrustedContent: true,
    description:
      "Replace the generated summary with the coach's own wording and push it. A summary already in the CRM updates that same note.",
  }),
  op({
    id: "callEvents.pushToCrm",
    title: "Push a call to the CRM",
    openWorld: true,
    confirm: "always",
    mutatesExisting: true,
    untrustedContent: true,
    description:
      "Send the current summary to the CRM now, without waiting out the review window. Re-pushing updates the existing note.",
  }),
  op({
    id: "callEvents.undoOutcome",
    title: "Undo a call's outcome",
    mutatesExisting: true,
    untrustedContent: true,
    description:
      "Clear a mistaken attendance mark and put the call back in the queue. The window is 48 hours from when the outcome was set.",
  }),
  op({
    id: "callEvents.backfill",
    title: "Backfill a booking's call event",
    untrustedContent: true,
    description:
      "Create a call event for a booking that predates automatic creation, then queue its summary. Safe to call twice: an existing call event comes back as is.",
  }),
];
