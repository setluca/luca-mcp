import { op } from "../registry.ts";
import type { LucaOperation } from "../registry.ts";

export const webhooksOperations: readonly LucaOperation[] = [
  op({
    id: "webhooks.subscriptions.list",
    title: "List webhook subscriptions",
    description: "List outbound webhook subscriptions.",
  }),
  op({
    id: "webhooks.subscriptions.create",
    title: "Create a webhook subscription",
    openWorld: true,
    mutatesExisting: true,
    // Starts streaming workspace events to an outside URL.
    confirm: "always",
    // Naturally idempotent: an active subscription with the same target URL
    // is updated in place (target URLs are unique per Zap/scenario webhook),
    // so this route requires no Idempotency-Key (see the matching comment on
    // its policy entry in apps/api/src/lib/public-route-policy.ts).
    description: "Create an outbound webhook subscription.",
  }),
  op({
    id: "webhooks.subscriptions.update",
    title: "Update a webhook subscription",
    openWorld: true,
    // Can point the event stream at a different outside URL.
    confirm: "always",
    description: "Update an outbound webhook subscription.",
  }),
  op({
    id: "webhooks.subscriptions.delete",
    title: "Delete a webhook subscription",
    // Deleting by id is naturally idempotent (the route matches its policy
    // entry, which carries no requireIdempotency), so no Idempotency-Key is
    // sent and it stays out of the confirm-gated tier that re-triggers live
    // downstream automation; re-running the delete is a safe no-op.
    description:
      "Delete an outbound webhook subscription. Terminal, idempotent soft delete: delivery history stays queryable and the subscription can never be resurrected.",
  }),
  op({
    id: "webhooks.testDelivery",
    title: "Send a test webhook",
    openWorld: true,
    confirm: "always",
    description: "Queue a canonical test webhook event.",
  }),
  op({
    id: "webhooks.deliveries.list",
    title: "List webhook deliveries",
    description: "List webhook deliveries.",
  }),
  op({
    id: "webhooks.signatureGuide",
    title: "Read the webhook signature guide",
    description: "Describe Luca webhook HMAC verification.",
  }),
  op({
    id: "webhooks.deliveries.replay",
    title: "Replay a webhook delivery",
    openWorld: true,
    confirm: "always",
    description:
      "Replay one webhook delivery without changing the event id. Re-triggers the subscriber's downstream automation.",
  }),
  op({
    id: "webhooks.events.list",
    title: "List webhook events",
    description:
      "List canonical webhook events of one type, newest first, in the delivered payload fields. Falls back to a documented sample payload when the workspace has none yet.",
    // Not framed untrusted: every event's delivered payload is structured ids,
    // enums, and counts (e.g. `message.received` is
    // `{ leadId, conversationId, channel, providerMessageId }`). No verbatim
    // lead text, draft body, or PII. The one content-shaped field in the whole
    // catalog is a fictional `text` in the "no events yet" sample fallback,
    // which the live pipeline never emits. Contrast `campaigns.commentEvents.list`,
    // which reads real verbatim commenter text and stays untrusted.
  }),
  op({
    id: "webhooks.events.replay",
    title: "Replay a webhook event",
    openWorld: true,
    confirm: "always",
    description:
      "Replay one canonical webhook event. Re-triggers subscribers' downstream automations.",
  }),
  op({
    id: "webhooks.events.bulkReplay",
    title: "Replay a batch of webhook events",
    openWorld: true,
    confirm: "always",
    description:
      "Bulk replay webhook events by type and time range. Re-triggers downstream automations at scale.",
  }),
];
