import { op } from "../registry.ts";
import type { LucaOperation } from "../registry.ts";

export const safetyOperations: readonly LucaOperation[] = [
  op({
    id: "safety.accounts",
    title: "Check connected account safety",
    description:
      "Read each connected channel account's safety status and 24-hour send count.",
  }),
];
