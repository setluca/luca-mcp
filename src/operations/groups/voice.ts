import { op } from "../registry.ts";
import type { LucaOperation } from "../registry.ts";

export const voiceOperations: readonly LucaOperation[] = [
  op({
    id: "voice.profile",
    title: "Read the coach's voice fingerprint",
    description:
      "Read a non-verbatim voice-fingerprint summary: version, example count, and last refresh. No corpus text.",
  }),
  op({
    id: "voice.corpus",
    title: "Read the coach's voice corpus",
    description:
      "List the coach's voice corpus: the writing every draft is matched against. Entry id, source, channel, and age always come back; the writing itself is blanked for a redacted-tier key.",
  }),
];
