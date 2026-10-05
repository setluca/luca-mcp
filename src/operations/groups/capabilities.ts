import { op } from "../registry.ts";
import type { LucaOperation } from "../registry.ts";

export const capabilitiesOperations: readonly LucaOperation[] = [
  op({
    id: "capabilities.get",
    title: "What this workspace supports",
    description:
      "Describe Luca's public API capabilities, scopes, and boundaries.",
  }),
];
