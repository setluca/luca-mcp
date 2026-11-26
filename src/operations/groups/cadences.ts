import { op } from "../registry.ts";
import type { LucaOperation } from "../registry.ts";

export const cadencesOperations: readonly LucaOperation[] = [
  op({
    id: "cadences.rescueStart",
    title: "Start a silent-lead rescue",
    openWorld: true,
    confirm: "always",
    description:
      "Enroll silent leads into the follow-up plan that fits each one: day 1, 3, 7 and 14 for a lead who went quiet, a faster plan for one who asked about price, timing or booking, and a rebook plan after a missed call. Luca writes each touch when it is due. Starts outbound touches to real leads. Before the coach presses Go live in the SetLuca app, the touches wait for it, and the cadence is cancelled if the workspace is still not live after 30 days.",
  }),
  op({
    id: "cadences.pause",
    title: "Pause a lead's cadence",
    idempotent: true,
    mutatesExisting: true,
    description:
      "Pause (cancel) a lead's running rescue cadence with an optional reason.",
  }),
];
