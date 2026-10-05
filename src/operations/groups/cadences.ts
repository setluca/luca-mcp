import { op } from "../registry.ts";
import type { LucaOperation } from "../registry.ts";

export const cadencesOperations: readonly LucaOperation[] = [
  op({
    id: "cadences.rescueStart",
    title: "Start a silent-lead rescue",
    openWorld: true,
    confirm: "always",
    description:
      "Enroll silent leads into the multi-day rescue cadence. Starts outbound touches to real leads.",
  }),
  op({
    id: "cadences.pause",
    title: "Pause a lead's cadence",
    mutatesExisting: true,
    description:
      "Pause (cancel) a lead's running rescue cadence with an optional reason.",
  }),
];
