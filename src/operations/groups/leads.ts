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
    mutatesExisting: true,
    description:
      "Create or upsert a lead identity. Body requires channel and externalUserId.",
  }),
  op({
    id: "leads.update",
    title: "Update a lead",
    description:
      "Update a lead's display name, stage, score, tags, or custom fields.",
  }),
  op({
    id: "leads.fieldDefinitions.list",
    title: "List custom lead fields",
    description: "List custom lead field definitions.",
  }),
  op({
    id: "leads.fieldDefinitions.upsert",
    // Echoes the coach's own field definition back.
    untrustedContent: false,
    title: "Define a custom lead field",
    mutatesExisting: true,
    description: "Create or update a custom lead field definition.",
  }),
  op({
    id: "leads.importPreview",
    title: "Preview a lead import",
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
    description:
      "Draft a voice-matched reply for a lead on demand and queue it for review. Optional guidance steers tone or content.",
  }),
  op({
    id: "leads.notes.delete",
    // Answers with ids and status flags only; no lead-authored text.
    untrustedContent: false,
    title: "Delete a lead note",
    description:
      "Remove one coach note from a lead and leave the rest of the timeline alone. This is how a note filed by mistake gets taken back.",
  }),
];
