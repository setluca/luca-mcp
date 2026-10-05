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
    mutatesExisting: true,
    description:
      "Record which objection-specialist variant was picked for one queued draft. It is how the objection tests learn which handling works, so record the variant the coach actually chose.",
  }),
];
