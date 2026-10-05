// The task-tool registry: composed, intent-level entry points layered over the
// generated 1:1 operation tools. It is deliberately NOT `LUCA_OPERATIONS`,
// whose entries the OpenAPI drift checker matches one-to-one against REST
// routes, and a task tool has no route of its own. Each tool hand-writes its
// input fields and composes existing operations through `LucaApi.request`, and
// they are split one file per domain under `task-tools/`. The shape they all
// share, and the request plumbing they all use, lives in `task-tools/runtime.ts`.
import { analyticsTaskTools } from "./task-tools/analytics.ts";
import { bookingTaskTools } from "./task-tools/bookings.ts";
import { cadenceTaskTools } from "./task-tools/cadences.ts";
import { callTaskTools } from "./task-tools/calls.ts";
import { inboxTaskTools } from "./task-tools/inbox.ts";
import { leadTaskTools } from "./task-tools/leads.ts";
import type { LucaTaskTool } from "./task-tools/runtime.ts";

export type { LucaTaskTool } from "./task-tools/runtime.ts";

export const LUCA_TASK_TOOLS: readonly LucaTaskTool[] = [
  ...inboxTaskTools,
  ...leadTaskTools,
  ...bookingTaskTools,
  ...callTaskTools,
  ...cadenceTaskTools,
  ...analyticsTaskTools,
];
