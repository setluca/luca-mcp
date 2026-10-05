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
    mutatesExisting: true,
    // Recipient snapshot, see the note above this list.
    untrustedContent: true,
    description: "Pause a running broadcast with an optional operator reason.",
  }),
  op({
    id: "broadcasts.retry",
    title: "Retry a broadcast's failed sends",
    openWorld: true,
    mutatesExisting: true,
    confirm: "always",
    // Recipient snapshot, see the note above this list.
    untrustedContent: true,
    description:
      "Retry failed broadcast recipients after operator review. Re-sends messages to leads.",
  }),
  op({
    id: "broadcasts.cancel",
    title: "Cancel a broadcast",
    mutatesExisting: true,
    // Recipient snapshot, see the note above this list.
    untrustedContent: true,
    description:
      "Cancel a draft, approved, running, paused, or failed broadcast.",
  }),
];
