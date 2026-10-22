import { op } from "../registry.ts";
import type { LucaOperation } from "../registry.ts";

export const reviewQueueOperations: readonly LucaOperation[] = [
  op({
    id: "reviewQueue.list",
    title: "List the review queue",
    description:
      "List review-queue items when the API key has review queue access.",
  }),
  op({
    id: "reviewQueue.explain",
    title: "Explain a queued draft",
    description:
      "Explain the signals behind a drafted reply: its voice-match score, any critic findings, and the qualification that motivated it.",
  }),
  op({
    id: "reviewQueue.approve",
    // Answers with ids and status flags only; no lead-authored text.
    untrustedContent: false,
    title: "Approve and send a queued draft",
    openWorld: true,
    mutatesExisting: true,
    confirm: "always",
    description:
      "Approve a pending draft for sending; dispatches through the lead's channel. Sends a real message.",
  }),
  op({
    id: "reviewQueue.reject",
    // Sends review.rejected to the coach's webhook subscribers.
    openWorld: true,
    // Answers with ids and status flags only; no lead-authored text.
    untrustedContent: false,
    title: "Reject a queued draft",
    mutatesExisting: true,
    description:
      "Reject a pending review-queue draft so it never sends. Stops any related booking-recovery cadence and emits review.rejected.",
  }),
  op({
    id: "reviewQueue.restore",
    // Answers with ids and status flags only; no lead-authored text.
    untrustedContent: false,
    title: "Restore a rejected draft",
    mutatesExisting: true,
    description:
      "Restore a rejected review-queue item back to pending. Fails if it's a booking message whose recovery window already passed.",
  }),
  op({
    id: "reviewQueue.media.retry",
    // Answers with ids and status flags only; no lead-authored text.
    untrustedContent: false,
    title: "Retry a draft's failed media",
    mutatesExisting: true,
    description:
      "Retry a failed voice-note transcription so the draft can be reviewed. Only re-transcribes; never redrafts or sends.",
  }),
  op({
    id: "reviewQueue.sla",
    title: "Check the review queue's response times",
    description:
      "Read median first-response time and its daily trend. Tells you whether the queue is being cleared fast enough.",
  }),
  op({
    id: "reviewQueue.objectionVariant",
    // Answers with ids and status flags only; no lead-authored text.
    untrustedContent: false,
    title: "Record an objection variant choice",
    description:
      "Record which objection-specialist variant was picked for one queued draft. It is how the objection tests learn which handling works, so record the variant the coach actually chose.",
  }),
  op({
    id: "reviewQueue.summary",
    title: "Summarize the review queue",
    description:
      "Read how many drafts are pending and the newest few, with lead names and hot-lead flags but no draft text. Cheaper than listing the queue.",
  }),
  op({
    id: "reviewQueue.changes",
    // Answers with ids and counts only; no lead-authored text.
    untrustedContent: false,
    title: "Read review queue changes",
    description:
      "Read which drafts entered and left the pending queue since the version an earlier call returned, with the pending and drafting counts. reload: true means that version is too old, so list the queue again.",
  }),
  op({
    id: "reviewQueue.drafting",
    title: "List drafts in progress",
    description:
      "List the inbound turns Luca is still writing a reply for, with each one's state, a preview of the lead's message, and how many restarts are left. Cancelled, paused, and failed turns stay on the list for 24 hours.",
  }),
  op({
    id: "reviewQueue.drafting.cancel",
    idempotent: true,
    // Answers with a turn id and state only; no lead-authored text.
    untrustedContent: false,
    title: "Cancel a draft in progress",
    mutatesExisting: true,
    description:
      "Stop the reply Luca is writing for one inbound turn. A queued draft that is still pending is taken back; an approved or sent one is not. The turn stays on the drafting list for 24 hours so it can be retried or dismissed.",
  }),
  op({
    id: "reviewQueue.drafting.retry",
    // Answers with a turn id and attempt number only; no lead-authored text.
    untrustedContent: false,
    title: "Retry a stopped draft",
    mutatesExisting: true,
    // The new attempt goes back through the channel's auto-send policy.
    openWorld: true,
    confirm: "always",
    description:
      "Have Luca draft again for a cancelled, paused, or failed turn. Only the lead's latest turn in a conversation restarts, at most 3 times across retry and regenerate. With auto-send on for the channel, the new draft can send without review.",
  }),
  op({
    id: "reviewQueue.drafting.dismiss",
    idempotent: true,
    // Answers with no body.
    untrustedContent: false,
    title: "Dismiss a stopped draft",
    mutatesExisting: true,
    description:
      "Remove a cancelled, paused, or failed turn from the drafting list without drafting again. Dismissing twice succeeds.",
  }),
  op({
    id: "reviewQueue.regenerate",
    // Answers with ids and an attempt number only; no lead-authored text.
    untrustedContent: false,
    title: "Redraft a queued reply",
    mutatesExisting: true,
    // The new attempt goes back through the channel's auto-send policy.
    openWorld: true,
    confirm: "always",
    description:
      "Replace a pending draft by having Luca draft its turn again, with an optional hint on what to change. An approved or sent draft can't be replaced, and a turn restarts at most 3 times across retry and regenerate. With auto-send on for the channel, the new draft can send without review.",
  }),
  op({
    id: "reviewQueue.bulkApprove",
    // Answers with one outcome per id; no lead-authored text.
    untrustedContent: false,
    title: "Approve and send several drafts",
    openWorld: true,
    mutatesExisting: true,
    confirm: "always",
    description:
      "Approve several pending drafts as they stand and send each one through its lead's channel. Returns one outcome per id; a draft already handled or not in the queue is skipped. Sends real messages.",
  }),
  op({
    id: "reviewQueue.bulkReject",
    idempotent: true,
    // Sends review.rejected for each draft to the coach's webhook subscribers.
    openWorld: true,
    // Answers with one outcome per id; no lead-authored text.
    untrustedContent: false,
    title: "Reject several drafts",
    mutatesExisting: true,
    description:
      "Reject several pending drafts so none of them sends, with no reason recorded. Returns one outcome per id; a draft already handled or not in the queue is skipped.",
  }),
];
