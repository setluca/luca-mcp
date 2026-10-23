import { op } from "../registry.ts";
import type { LucaOperation } from "../registry.ts";

export const leadsOperations: readonly LucaOperation[] = [
  op({
    id: "leads.list",
    title: "List leads",
    description:
      "List leads. Query supports limit, cursor, channel, and q according to Luca OpenAPI.",
  }),
  op({
    id: "leads.get",
    title: "Get a lead's timeline",
    description: "Get a lead's full timeline and notes.",
  }),
  op({
    id: "leads.explain",
    title: "Explain why a lead qualified",
    description:
      "Explain why a lead qualified: the qualifier's reasoning, signals, and confidence from its most recent drafted turn.",
  }),
  op({
    id: "leads.create",
    title: "Create or upsert a lead",
    // Sends lead.created to the coach's webhook subscribers.
    openWorld: true,
    mutatesExisting: true,
    description:
      "Create or upsert a lead identity. Body requires channel and externalUserId.",
  }),
  op({
    id: "leads.update",
    title: "Update a lead",
    // Sends lead.updated to the coach's webhook subscribers, and a tag change
    // can resume a campaign step that messages the lead.
    openWorld: true,
    description:
      "Update a lead's display name, stage, tags, or custom fields. Tags are replaced as a whole list.",
  }),
  op({
    id: "leads.fieldDefinitions.list",
    title: "List custom lead fields",
    description: "List custom lead field definitions.",
  }),
  op({
    id: "leads.fieldDefinitions.upsert",
    idempotent: true,
    // Echoes the coach's own field definition back.
    untrustedContent: false,
    title: "Define a custom lead field",
    mutatesExisting: true,
    description: "Create or update a custom lead field definition.",
  }),
  op({
    id: "leads.importPreview",
    title: "Preview a lead import",
    // A POST only so the CSV fits in a body. It checks the mapping and saves nothing.
    readOnly: true,
    description: "Preview a mapped CSV lead import before applying it.",
  }),
  op({
    id: "leads.importApply",
    title: "Apply a lead import",
    mutatesExisting: true,
    // Writes many leads and their consent records at once.
    confirm: "always",
    description: "Apply a mapped lead import with consent evidence.",
  }),
  op({
    id: "leads.identities.attach",
    title: "Attach a channel identity to a lead",
    // Sends lead.updated to the coach's webhook subscribers.
    openWorld: true,
    mutatesExisting: true,
    description: "Attach a verified or claimed identity to a lead.",
  }),
  op({
    id: "leads.consents.grant",
    // Echoes the consent record the coach filed.
    untrustedContent: false,
    title: "Record a lead's consent",
    mutatesExisting: true,
    // Consent is what lets Luca message the lead on that channel.
    confirm: "always",
    openWorld: true,
    description: "Grant explicit lead consent for a channel purpose.",
  }),
  op({
    id: "leads.consents.revoke",
    idempotent: true,
    // Echoes the consent record the coach revoked.
    untrustedContent: false,
    title: "Revoke a lead's consent",
    mutatesExisting: true,
    description: "Revoke explicit lead consent for a channel purpose.",
  }),
  op({
    id: "leads.notes.add",
    // Echoes the coach's own note back.
    untrustedContent: false,
    title: "Add a note to a lead",
    description: "Append a coach note to a lead. Body requires body.",
  }),
  op({
    id: "leads.draft",
    title: "Draft a reply to a lead",
    untrustedContent: true,
    // Drafting again replaces the lead's pending on-demand draft, as
    // reviewQueue.regenerate replaces a queued one.
    mutatesExisting: true,
    // The drafter sends the conversation to OpenRouter's language model, the
    // same reach that makes a transcription retry open-world.
    openWorld: true,
    description:
      "Draft a reply for a lead, written the way the coach writes, and put it in the review queue for the coach to approve. Drafting again replaces this lead's earlier unapproved draft from this tool. It never sends, whatever the channel's auto-send setting. Optional guidance steers tone or content.",
  }),
  op({
    id: "leads.notes.delete",
    idempotent: true,
    // Answers with ids and status flags only; no lead-authored text.
    untrustedContent: false,
    title: "Delete a lead note",
    description:
      "Remove one coach note from a lead and leave the rest of the timeline alone. This is how a note filed by mistake gets taken back.",
  }),
  op({
    id: "leads.drafting.pause",
    // Answers with the pause's end time only; no lead-authored text.
    untrustedContent: false,
    title: "Pause Luca for a lead",
    mutatesExisting: true,
    // The API asks queue_ops of a key for this route although its
    // leads:write scope sits at the draft tier.
    capability: "queue_ops",
    description:
      "Stop Luca drafting replies, running follow-up cadences, and sending campaign messages to one lead, for 1h, 24h, 7d, 30d, or until resumed. A draft in flight stops at its next step. Opt-outs and crisis messages are still handled. Pausing again replaces the earlier pause. A timed pause resumes the lead by itself when it ends.",
  }),
  op({
    id: "leads.drafting.resume",
    // Answers with turn ids and a skip reason only; no lead-authored text.
    untrustedContent: false,
    title: "Resume Luca for a lead",
    mutatesExisting: true,
    // A restarted turn goes back through the channel's auto-send policy, so
    // with auto-send on its reply can reach the lead without review.
    openWorld: true,
    confirm: "always",
    description:
      "Clear a lead's pause and have Luca draft one reply over each conversation's unanswered messages. With auto-send on for the channel, that reply can send without review. A conversation is skipped when the coach already replied or the messaging window closed, and skippedReason says why nothing restarted. Resuming a lead that isn't paused succeeds.",
  }),
];
