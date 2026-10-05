import { op } from "../registry.ts";
import type { LucaOperation } from "../registry.ts";

export const reportsOperations: readonly LucaOperation[] = [
  op({
    id: "reports.scorecard",
    title: "Read the scorecard",
    description:
      "Read the sales scorecard for a window: calls booked and completed, show rate, won and lost, draft approvals, and hours saved.",
  }),
  op({
    id: "reports.morning",
    title: "Read the morning report",
    untrustedContent: true,
    description:
      "Structured 24h review-queue digest (items + counts) for the coach. No model call; summarize client-side.",
  }),
];
