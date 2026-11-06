import { op } from "../registry.ts";
import type { LucaOperation } from "../registry.ts";

export const usageOperations: readonly LucaOperation[] = [
  op({
    id: "usage.spend",
    title: "Read this period's spend",
    description:
      "Read model spend for the period, rolled up by agent and by day, against the billing account's monthly budget, and whether AI replies have paused.",
  }),
];
