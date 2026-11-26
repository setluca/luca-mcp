import { op } from "../registry.ts";
import type { LucaOperation } from "../registry.ts";

/**
 * A call into a feature the coach turned off answers this, from whichever tool
 * made it. Every tool here says so, because these are the tools that explain it.
 */
const FEATURE_OFF =
  "Any Luca tool that answers 409 feature_off was refused because the feature behind it is turned off.";

export const featuresOperations: readonly LucaOperation[] = [
  op({
    id: "features.list",
    title: "List feature switches",
    description: `List Luca's six features and whether each one runs for the coach: ai_replies (off, review or auto_send), and campaigns, broadcasts, follow_ups, booking_messages and call_summaries (on or off). An isLocked feature is not in the coach's plan, so its switch does nothing until they upgrade to requiredPlanId. changedBy and changedAt say who last changed a switch and when. ${FEATURE_OFF} Read this to see which one, and preview with luca_features_preview before changing a switch.`,
  }),
  op({
    id: "features.preview",
    title: "Preview a feature switch change",
    // A POST only so the requested state fits in a body. It counts work and
    // stores nothing.
    readOnly: true,
    description: `Preview setting one feature to body.state, changing nothing. Answers the feature's current state and the work turning it down would hold: active campaign enrollments, queued sends, scheduled follow-ups, running broadcasts and booking messages still to go out. Turning a feature up holds nothing, so its counts are zero. Call this before luca_features_set and show the coach the counts, so they know what the change holds. Held work keeps its place and continues when the feature is turned back on. ${FEATURE_OFF}`,
  }),
  op({
    id: "features.set",
    title: "Turn a feature on or off",
    idempotent: true,
    // Turning a feature back on releases the sends it held, and those reach
    // leads.
    openWorld: true,
    confirm: "always",
    description: `Set one feature's switch, which changes what Luca does for the coach. Preview the change with luca_features_preview first, show the coach what it holds, and pass confirm: true only after they approve this exact change. ai_replies takes off, review or auto_send; every other feature takes on or off. Turning a feature off stops new work at once and holds queued work; turning it back on releases the held work in order, so held messages go out to leads. ai_replies at review moves every channel's DM replies to review. Through this connection auto_send is only stored: no channel moves to auto, and nothing auto-sends until the coach chooses auto in the SetLuca app. After Go live, turning on a feature whose skipped setup steps are still unconfirmed answers 409 confirm_steps_needed. Nothing sends on its own before Go live. ${FEATURE_OFF}`,
  }),
  op({
    id: "features.setMany",
    title: "Set several feature switches",
    idempotent: true,
    // Turning a feature back on releases the sends it held.
    openWorld: true,
    confirm: "always",
    description: `Set several feature switches in one change, as Luca's setup step does for a preset. Each entry in body.features works as luca_features_set does, a feature may appear once, and either every change is stored or none is. Preview each change with luca_features_preview, and pass confirm: true only after the coach approves the whole set. Answers every feature as it now reads. ${FEATURE_OFF}`,
  }),
];
