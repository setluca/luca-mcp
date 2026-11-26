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
    // Turning it on lets Luca's replies reach leads on this account without
    // review, while the workspace switch is on. An API key leaves that switch
    // as it was.
    openWorld: true,
    confirm: {
      applies: (input) =>
        isJsonObject(input.body) && input.body.enabled === true,
      description:
        "enabled is true (lets Luca's replies reach leads without review)",
    },
    description:
      "Turn Luca's DM auto-send on or off for one channel account. Off moves that account's DM replies to review, so every Luca draft on it lands in the review queue; other accounts keep theirs. Turning it on is the coach's choice in the SetLuca app: through this connection Luca answers 403 auto_needs_coach. workspaceAutoSendEnabled in the response says whether any account is at auto. Luca has deprecated this route in favor of its Autonomy settings, and each change is saved as a Set up Luca version the coach can undo. Campaign sends follow their own policy. WhatsApp and disconnected accounts answer 404.",
  }),
];
