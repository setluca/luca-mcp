import { op } from "../registry.ts";
import type { LucaOperation } from "../registry.ts";

export const safetyOperations: readonly LucaOperation[] = [
  op({
    id: "safety.accounts",
    title: "Check connected account safety",
    description:
      "Read each connected channel account's safety status and 24-hour send count.",
  }),
  op({
    id: "safety.deadLetters.list",
    title: "List dead letters",
    description:
      "List the workspace's dead letters, newest first: work Luca gave up on after its retries, with the lane, event, error, and attempts. The stored message is not returned. Filter by query.status (open, replayed, discarded, quarantined) and query.lane.",
  }),
  op({
    id: "safety.deadLetters.metrics",
    title: "Read dead letter metrics",
    description:
      "Read per-lane counts for the workspace: open dead letters, failures in the last 24 hours, and events still waiting in the outbox.",
  }),
  op({
    id: "safety.deadLetters.get",
    title: "Get a dead letter",
    description:
      "Read one dead letter's lane, event, error, attempts, and status. The stored message is not returned.",
  }),
  op({
    id: "safety.deadLetters.replay",
    title: "Replay a dead letter",
    mutatesExisting: true,
    idempotent: true,
    // The message goes back to its lane, and an outbound or reply lane
    // sends it to the lead.
    openWorld: true,
    confirm: "always",
    description:
      "Send a dead letter's original message back to its lane and mark it replayed. A message on an outbound or reply lane can then reach the lead, so pass confirm: true only after the coach approves. It keeps its idempotency key, so work that already happened is not done twice. Answers 409 dead_letter_not_open or not_replayable, and 503 replay_unavailable when the lane refuses it.",
  }),
  op({
    id: "safety.deadLetters.discard",
    title: "Discard a dead letter",
    mutatesExisting: true,
    idempotent: true,
    description:
      "Mark an open dead letter handled without resending it, so its work never happens. Answers 409 dead_letter_not_open when it is not open. Use luca_safety_dead_letters_replay instead to retry it.",
  }),
];
