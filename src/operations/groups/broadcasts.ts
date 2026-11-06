import { op } from "../registry.ts";
import type { LucaOperation } from "../registry.ts";

// Operations that return a broadcast carry its recipient snapshot: each lead's
// display name and custom fields, which the lead wrote on their own profile.
// The coach-written message body alone would not need the untrusted frame.
export const broadcastsOperations: readonly LucaOperation[] = [
  op({
    id: "broadcasts.list",
    title: "List broadcasts",
    description: "List broadcasts. Query supports limit, cursor, and status.",
  }),
  op({
    id: "broadcasts.get",
    title: "Get a broadcast",
    // Recipient snapshot, see the note above this list.
    untrustedContent: true,
    description: "Get broadcast detail.",
  }),
  op({
    id: "broadcasts.create",
    title: "Create a broadcast",
    // Recipient snapshot, see the note above this list.
    untrustedContent: true,
    description: "Create a broadcast draft. Body requires campaignId and name.",
  }),
  op({
    id: "broadcasts.preview",
    title: "Preview a broadcast",
    mutatesExisting: true,
    // Recipient snapshot, see the note above this list.
    untrustedContent: true,
    description: "Refresh broadcast recipient and sample-message preview.",
  }),
  op({
    id: "broadcasts.approve",
    title: "Approve a broadcast",
    mutatesExisting: true,
    // Recipient snapshot, see the note above this list.
    untrustedContent: true,
    description: "Approve a safe broadcast draft and snapshot recipients.",
  }),
  op({
    id: "broadcasts.launch",
    title: "Launch a broadcast",
    openWorld: true,
    mutatesExisting: true,
    confirm: "always",
    // Recipient snapshot, see the note above this list.
    untrustedContent: true,
    description: "Launch an approved broadcast. Sends messages to live leads.",
  }),
  op({
    id: "broadcasts.pause",
    title: "Pause a broadcast",
    idempotent: true,
    // Sends broadcast.paused to the coach's webhook subscribers.
    openWorld: true,
    mutatesExisting: true,
    // Recipient snapshot, see the note above this list.
    untrustedContent: true,
    description: "Pause a running broadcast with an optional operator reason.",
  }),
  op({
    id: "broadcasts.resume",
    title: "Resume a broadcast billing paused",
    openWorld: true,
    mutatesExisting: true,
    confirm: "always",
    // Recipient snapshot, see the note above this list.
    untrustedContent: true,
    description:
      "Resume a broadcast that billing paused, after buying a pack or updating the card. Sends the remaining messages to live leads; recipients already sent are left alone. A broadcast paused by hand is resumed with luca_broadcasts_retry instead.",
  }),
  op({
    id: "broadcasts.retry",
    title: "Retry or resume a broadcast",
    openWorld: true,
    mutatesExisting: true,
    confirm: "always",
    // Recipient snapshot, see the note above this list.
    untrustedContent: true,
    description:
      "Retry failed broadcast recipients after operator review, or resume a broadcast paused by hand, which also sends to recipients not yet reached. Sends messages to leads.",
  }),
  op({
    id: "broadcasts.cancel",
    title: "Cancel a broadcast",
    idempotent: true,
    mutatesExisting: true,
    // Recipient snapshot, see the note above this list.
    untrustedContent: true,
    description:
      "Cancel a draft, approved, running, paused, or failed broadcast.",
  }),
];
