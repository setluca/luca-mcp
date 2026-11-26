import { op } from "../registry.ts";
import type { LucaOperation } from "../registry.ts";

export const autonomyOperations: readonly LucaOperation[] = [
  op({
    id: "autonomy.list",
    title: "List what Luca may do alone",
    description:
      "List every trigger that can start Luca acting without the coach, each off, review, or auto: DM replies and comment replies per channel account, then booking messages, follow-ups, campaigns, broadcasts, and business-signal actions. state is what the coach chose; effective is what Luca does now, since nothing acts on its own before Go live and a DM reply on WhatsApp or on a channel still waiting for its send mode stays in review. Campaigns, broadcasts, and comment replies send coach-written text and cannot be changed here.",
  }),
  op({
    id: "autonomy.set",
    title: "Set what Luca may do alone",
    idempotent: true,
    // Review for booking messages or follow-ups turns that feature back on,
    // which releases the sends it held.
    openWorld: true,
    confirm: "always",
    description:
      "Set one trigger to off or review. Through this connection auto answers 403 auto_needs_coach: only the coach can choose auto, in the SetLuca app. For dm_reply, body.channelAccountId names one channel account, and without it every account changes; off for dm_reply turns AI replies off for the whole workspace. Off for booking_message or follow_up turns that feature off and holds its queued work, and review turns it back on, releasing that work. campaign, broadcast, and comment_reply answer 409 autonomy_read_only. Read luca_autonomy_list first, and pass confirm: true after the coach approves.",
  }),
];
