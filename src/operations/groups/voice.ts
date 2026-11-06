import { op } from "../registry.ts";
import type { LucaOperation } from "../registry.ts";

export const voiceOperations: readonly LucaOperation[] = [
  op({
    id: "voice.profile",
    title: "Read the coach's voice fingerprint",
    // A model writes the brief from the coach's replies, which can quote leads.
    untrustedContent: true,
    description:
      "Read a non-verbatim voice-fingerprint summary: version, example count, last refresh, the measured style of the coach's replies, and the short brief Luca drafts from. A model writes the brief from those replies, and a redacted-tier key reads it as null. No corpus text.",
  }),
  op({
    id: "voice.corpus",
    title: "Read the coach's voice corpus",
    description:
      "List the coach's voice corpus: the writing every draft is matched against. Entry id, source, channel, and age always come back; the writing itself is blanked for a redacted-tier key.",
  }),
];
