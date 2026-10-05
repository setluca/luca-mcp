import { isJsonObject } from "../../serialization.ts";
import { op } from "../registry.ts";
import type { LucaOperation } from "../registry.ts";

export const campaignsOperations: readonly LucaOperation[] = [
  op({
    id: "campaigns.list",
    title: "List campaigns",
    description: "List campaigns. Query supports limit, cursor, and status.",
  }),
  op({
    id: "campaigns.get",
    title: "Get a campaign",
    description: "Get campaign draft and latest published version.",
  }),
  op({
    id: "campaigns.create",
    title: "Create a campaign",
    description:
      "Create a campaign draft. Body requires name and may include graph.",
  }),
  op({
    id: "campaigns.generate",
    title: "Generate a campaign draft",
    description:
      "Generate a safe AI campaign plan without creating or publishing it.",
  }),
  op({
    id: "campaigns.draft.update",
    title: "Edit a campaign draft",
    description: "Autosave a campaign draft.",
  }),
  op({
    id: "campaigns.enrollments.list",
    title: "List a campaign's enrollments",
    untrustedContent: true,
    description: "List campaign enrollments.",
  }),
  op({
    id: "campaigns.enroll",
    title: "Enroll leads in a campaign",
    openWorld: true,
    confirm: "always",
    // The enrollment's context is execution state pulled out of the lead's replies.
    untrustedContent: true,
    description:
      "Enroll a lead in the latest published campaign version. Triggers the live campaign's automation for that lead.",
  }),
  op({
    id: "campaigns.analytics",
    title: "Read a campaign's results",
    description: "Read campaign attribution and performance analytics.",
  }),
  op({
    id: "campaigns.providerCapabilities",
    title: "Check what a campaign's channel supports",
    description: "Evaluate provider capability blockers for a campaign draft.",
  }),
  op({
    id: "campaigns.commentEvents.list",
    title: "List campaign comment events",
    description:
      "List matched, suppressed, blocked, and replayed comment automation events.",
    // Each event carries verbatim external-commenter text (`body`,
    // `commenterDisplayName`), and the receipt audit alongside it carries the
    // same verbatim text for comments that never became an event, so this
    // read must be framed untrusted even though the campaigns group is not
    // blanket-untrusted.
    untrustedContent: true,
  }),
  op({
    id: "campaigns.simulations.list",
    title: "List a campaign's simulations",
    description: "List persisted campaign simulation runs.",
  }),
  op({
    id: "campaigns.simulations.create",
    title: "Simulate a campaign",
    // A simulation echoes the lead record, event payload and context it ran on, and the drafts a model wrote from them.
    untrustedContent: true,
    description: "Run a persisted dry-run simulation without sending messages.",
  }),
  op({
    id: "campaigns.simulations.get",
    title: "Get a campaign simulation",
    // A simulation echoes the lead record, event payload and context it ran on, and the drafts a model wrote from them.
    untrustedContent: true,
    description: "Get a campaign simulation run with trace.",
  }),
  op({
    id: "campaigns.commentSimulationSuite.run",
    title: "Run the comment automation suite",
    // Each simulation echoes the lead record, event payload and context it ran on, and the drafts a model wrote from them.
    untrustedContent: true,
    description:
      "Run the Instagram comment-to-DM simulation suite against a campaign. Any campaign that uses comment automation has to pass it before it can publish, so run this before reaching for publish.",
  }),
  op({
    id: "campaigns.publish",
    title: "Publish a campaign",
    openWorld: true,
    mutatesExisting: true,
    confirm: "always",
    description:
      "Freeze the draft as a new immutable version and point new enrollments at it. Published versions never change, and enrollments against a live campaign reach real leads. Publish is blocked when the target provider cannot do something the campaign needs, so read the provider capabilities first.",
  }),
  op({
    id: "campaigns.setStatus",
    title: "Pause, resume, or archive a campaign",
    openWorld: true,
    mutatesExisting: true,
    // Resuming restarts the campaign's automatic sends to real leads. Pausing
    // and archiving only stop work, so they need no confirmation.
    confirm: {
      applies: (input) =>
        isJsonObject(input.body) && input.body.status === "published",
      description: "status is published (resuming sends)",
    },
    description:
      "Pause, resume, or archive a campaign. A transition that does not make sense for the campaign's current state is rejected rather than forced through.",
  }),
  op({
    id: "campaigns.duplicate",
    title: "Duplicate a campaign",
    description:
      "Copy a campaign into a fresh unpublished draft and leave the original alone. Use it to change a live campaign without touching what is currently running.",
  }),
  op({
    id: "campaigns.versions.list",
    title: "List campaign versions",
    description:
      "List a campaign's published version history. Published versions cannot change, so this is the record of what actually ran rather than what the draft says today.",
  }),
  op({
    id: "campaigns.enrollments.timeline",
    title: "Read an enrollment timeline",
    untrustedContent: true,
    description:
      "Read every step one enrollment has been through: what got sent, when, and how the lead responded.",
  }),
];
