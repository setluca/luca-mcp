import { isJsonObject } from "../../serialization.ts";
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
  op({
    id: "channels.set_ai_dm_auto_send",
    title: "Turn auto-send on or off for a channel",
    // Turning it on lets Luca's replies reach leads without review, on this
    // account and on every other account whose own switch is on.
    openWorld: true,
    confirm: {
      applies: (input) =>
        isJsonObject(input.body) && input.body.enabled === true,
      description:
        "enabled is true (lets Luca's replies reach leads without review)",
    },
    description:
      "Turn Luca's DM auto-send on or off for one channel account. Off puts every Luca draft on that account in the review queue. On lets drafts that pass Luca's safety checks send without review, and also turns on the workspace switch, so every other account with its own switch on starts sending too. Campaign sends follow their own policy. WhatsApp and disconnected accounts answer 404.",
  }),
];
