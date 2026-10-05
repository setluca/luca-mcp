import * as Schema from "effect/Schema";

import { NonEmptyString, WORKSPACE_INPUT_FIELDS } from "../fields.ts";
import {
  idempotencyKeyInput,
  operationResult,
  stringInput,
  taskTool,
  textBody,
} from "./runtime.ts";

const rescueSilentLeads = taskTool({
  name: "luca_rescue_silent_leads",
  title: "Enroll silent leads into the rescue cadence",
  description:
    'Enroll one or more silent leads into the multi-day rescue cadence. THIS STARTS OUTBOUND TOUCHES to real leads over the coming days — pass confirm: true to proceed. cadenceTemplate is light | standard | aggressive (default standard). Example: { leadIds: ["..."], cadenceTemplate: "standard", confirm: true }.',
  inputSchema: {
    ...WORKSPACE_INPUT_FIELDS,
    leadIds: Schema.Array(NonEmptyString)
      .check(Schema.isMinLength(1), Schema.isMaxLength(100))
      .annotate({
        description:
          "Lead ids to enroll (max 100). Non-tenant ids are skipped.",
      }),
    cadenceTemplate: Schema.optionalKey(
      Schema.Literals(["light", "standard", "aggressive"]).annotate({
        description: "Cadence intensity (default standard).",
      })
    ),
    ...idempotencyKeyInput(
      "Reuse the same key when retrying this exact enrollment."
    ),
  },
  outputSchema: operationResult("cadences.rescueStart"),
  composes: ["cadences.rescueStart"],
  run: (call, input) =>
    call("cadences.rescueStart", {
      body: {
        leadIds: input.leadIds,
        ...textBody("cadenceTemplate", input.cadenceTemplate),
      },
    }),
});

const pauseCadence = taskTool({
  name: "luca_pause_cadence",
  title: "Pause a lead's rescue cadence",
  description:
    'Cancel a lead\'s running rescue cadence so no further touches are sent. Safe to call twice (a no-op once cancelled). Example: call with { leadId, reason: "lead replied elsewhere" }.',
  inputSchema: {
    ...WORKSPACE_INPUT_FIELDS,
    leadId: NonEmptyString.annotate({
      description: "The lead whose cadence to pause.",
    }),
    reason: Schema.optionalKey(
      NonEmptyString.check(Schema.isMaxLength(500)).annotate({
        description: "Optional operator reason, stored on the cadence.",
      })
    ),
    ...idempotencyKeyInput(
      "Reuse the same key when retrying this exact pause."
    ),
  },
  outputSchema: operationResult("cadences.pause"),
  composes: ["cadences.pause"],
  run: (call, input) =>
    call("cadences.pause", {
      pathParams: { id: stringInput(input.leadId) },
      body: textBody("reason", input.reason),
    }),
});

export const cadenceTaskTools = [rescueSilentLeads, pauseCadence];
