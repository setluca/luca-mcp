import { op } from "../registry.ts";
import type { LucaOperation } from "../registry.ts";

export const usageOperations: readonly LucaOperation[] = [
  op({
    id: "usage.spend",
    title: "Read this period's spend",
    description:
      "Read model spend for the period, rolled up by agent and by day, against the plan's cap.",
  }),
  op({
    id: "usage.messages",
    title: "Read this period's message count",
    description:
      "Read the message pool: used, allowed, and remaining for the period. Check this before starting work that drafts in bulk.",
  }),
];
