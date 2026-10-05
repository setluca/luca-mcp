import { op } from "../registry.ts";
import type { LucaOperation } from "../registry.ts";

export const memoryOperations: readonly LucaOperation[] = [
  op({
    id: "memory.list",
    title: "List what Luca remembers",
    description:
      "List what Luca remembers, filtered by lead, scope, source, trust level, or free text. The fact, the reasoning, and the quoted evidence are blanked for a redacted-tier key; trust level, lead, and dates always come back.",
  }),
  op({
    id: "memory.update",
    title: "Edit a memory",
    mutatesExisting: true,
    // The corrected memory comes back in full, and a memory is a fact Luca
    // extracted from what a lead wrote.
    untrustedContent: true,
    description:
      "Correct one memory: edit the fact, flag it disputed when it turns out to be wrong, restore an archived one, or make it win over a conflicting memory.",
  }),
  op({
    id: "memory.setArchived",
    // Answers with ids and status flags only; no lead-authored text.
    untrustedContent: false,
    title: "Archive or restore memories",
    mutatesExisting: true,
    description:
      "Archive or restore several memories at once. Archiving stops Luca using a fact while the record and its provenance survive, so it is always reversible.",
  }),
];
