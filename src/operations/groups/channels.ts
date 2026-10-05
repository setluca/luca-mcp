import { op } from "../registry.ts";
import type { LucaOperation } from "../registry.ts";

export const channelsOperations: readonly LucaOperation[] = [
  op({
    id: "channels.list",
    title: "List channel accounts",
    description:
      "List the coach's current channel accounts, one per provider account, with each one's status, health, and what the composer can send through it. Connecting, pausing, and repairing an account stay in the Luca app.",
  }),
  op({
    id: "channels.catalog",
    title: "List available channels",
    description:
      "List every channel Luca supports and whether it can be connected yet. Availability is per channel, not per coach.",
  }),
  op({
    id: "channels.features",
    title: "List channel features",
    description:
      "List what each provider supports, from sending media to interactive replies, and what still blocks a feature: a permission, a webhook field, or a provider approval. Check this before telling the coach a channel can do something.",
  }),
  op({
    id: "channels.get",
    title: "Get a channel account",
    description:
      "Read one channel account: status, health, cleanup state after a disconnect, and the actions the coach can take on it. Older rows stay readable by ID.",
  }),
];
