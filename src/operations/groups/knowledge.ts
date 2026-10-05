import { op } from "../registry.ts";
import type { LucaOperation } from "../registry.ts";

export const knowledgeOperations: readonly LucaOperation[] = [
  op({
    id: "knowledge.suggestions",
    title: "List knowledge suggestions",
    description:
      "List profile changes proposed from the coach's own knowledge sources, each with the excerpt it was drawn from and the value it would replace.",
  }),
  op({
    id: "knowledge.approveSuggestion",
    title: "Approve a knowledge suggestion",
    mutatesExisting: true,
    confirm: "always",
    description:
      "Approve a profile suggestion and write it into the coach's profile. Every later draft reads the result, so check the excerpt supports the change before approving.",
  }),
  op({
    id: "knowledge.rejectSuggestion",
    title: "Reject a knowledge suggestion",
    mutatesExisting: true,
    description:
      "Reject a profile suggestion so it stops being offered. The profile is left as it stands.",
  }),
  op({
    id: "knowledge.sources.list",
    title: "List knowledge sources",
    description:
      "List the content sources the coach has connected \u2014 Notion, Google Docs, a website, an Instagram bio \u2014 with the sync state of each one. Connecting a new source is app-only; this lists what is already there.",
  }),
  op({
    id: "knowledge.sources.sync",
    title: "Re-sync a knowledge source",
    mutatesExisting: true,
    description:
      "Queue a re-read of one knowledge source now rather than waiting for its next scheduled sync. It returns as soon as the job is queued, so any new suggestions appear on a later read.",
  }),
  op({
    id: "knowledge.sources.disconnect",
    title: "Disconnect a knowledge source",
    mutatesExisting: true,
    description:
      "Delete a knowledge source. Its pending suggestions go with it; values the coach already approved stay in the profile, because approving copies them there.",
  }),
];
