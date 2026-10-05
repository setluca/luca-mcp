import * as Schema from "effect/Schema";

import {
  MessagingChannel,
  NonEmptyString,
  WORKSPACE_INPUT_FIELDS,
} from "../fields.ts";
import { optionalField } from "../optional-field.ts";
import {
  idempotencyKeyInput,
  numberInput,
  operationResult,
  stringInput,
  taskTool,
  textBody,
} from "./runtime.ts";

const findLeads = taskTool({
  name: "luca_find_leads",
  title: "Find leads",
  description:
    "Search the coach's leads by free-text query and optional channel. Use this to locate a lead before drafting, booking, or flagging. Example: call with { query: \"maria instagram\" } to find Maria's Instagram lead.",
  inputSchema: {
    ...WORKSPACE_INPUT_FIELDS,
    query: NonEmptyString.annotate({
      description: "Free-text search: name, handle, or keyword.",
    }),
    channel: Schema.optionalKey(
      MessagingChannel.annotate({ description: "Optional channel filter." })
    ),
    limit: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })).annotate({
        description: "Max results (default 10).",
      })
    ),
  },
  outputSchema: operationResult("leads.list"),
  composes: ["leads.list"],
  run: (call, input) =>
    call("leads.list", {
      query: {
        q: stringInput(input.query),
        ...optionalField("channel", input.channel),
        limit: numberInput(input.limit, 10),
      },
    }),
});

const flagForHuman = taskTool({
  name: "luca_flag_for_human",
  title: "Flag a lead for human attention",
  description:
    'Add a note to a lead, tagged [needs-human], that the coach sees on the lead\'s timeline. This is an ordinary note with a prefix — it does not route, alert, or reprioritize anything. Use when a conversation needs judgment an agent should not exercise (payment claims, distress, legal), and tell the coach directly if it is urgent. Example: call with { leadId, reason: "lead mentioned a refund dispute" }.',
  inputSchema: {
    ...WORKSPACE_INPUT_FIELDS,
    leadId: NonEmptyString.annotate({ description: "The lead to flag." }),
    reason: NonEmptyString.annotate({
      description: "Why a human should look — shown to the coach verbatim.",
    }),
    ...idempotencyKeyInput("Reuse the same key when retrying this exact flag."),
  },
  outputSchema: operationResult("leads.notes.add"),
  composes: ["leads.notes.add"],
  run: (call, input) =>
    call("leads.notes.add", {
      pathParams: { id: stringInput(input.leadId) },
      body: { body: `[needs-human] ${stringInput(input.reason)}` },
    }),
});

const draftReply = taskTool({
  name: "luca_draft_reply",
  title: "Draft a reply for a lead",
  description:
    'Draft a voice-matched reply for a lead on demand and queue it for review — the middle step of the reply loop (triage → draft → approve). Optional guidance steers tone or content. Nothing is sent; approve it with luca_approve_and_send. Example: call with { leadId, guidance: "keep it short and warm" }.',
  inputSchema: {
    ...WORKSPACE_INPUT_FIELDS,
    leadId: NonEmptyString.annotate({
      description: "The lead to draft a reply for.",
    }),
    guidance: Schema.optionalKey(
      NonEmptyString.check(Schema.isMaxLength(500)).annotate({
        description: "Optional steer for tone or content of the draft.",
      })
    ),
    ...idempotencyKeyInput(
      "Reuse the same key when retrying this exact draft."
    ),
  },
  outputSchema: operationResult("leads.draft"),
  composes: ["leads.draft"],
  run: (call, input) =>
    call("leads.draft", {
      pathParams: { id: stringInput(input.leadId) },
      body: textBody("guidance", input.guidance),
    }),
});

const approveAndSend = taskTool({
  name: "luca_approve_and_send",
  title: "Approve a drafted reply and send it",
  description:
    "Approve a pending review-queue draft and dispatch it through the lead's channel. THIS SENDS A REAL MESSAGE TO A REAL PERSON — only call it after a human has reviewed and intends to send. Pass confirm: true to proceed. Optional finalBody replaces the draft text before sending. Example: { reviewQueueId, confirm: true }.",
  inputSchema: {
    ...WORKSPACE_INPUT_FIELDS,
    reviewQueueId: NonEmptyString.annotate({
      description: "The review-queue item to approve.",
    }),
    finalBody: Schema.optionalKey(
      NonEmptyString.annotate({
        description:
          "Optional edited body to send instead of the drafted text.",
      })
    ),
    ...idempotencyKeyInput(
      "Reuse the same key when retrying this exact approval."
    ),
  },
  outputSchema: operationResult("reviewQueue.approve"),
  composes: ["reviewQueue.approve"],
  run: (call, input) =>
    call("reviewQueue.approve", {
      pathParams: { id: stringInput(input.reviewQueueId) },
      body: textBody("finalBody", input.finalBody),
    }),
});

export const leadTaskTools = [
  findLeads,
  flagForHuman,
  draftReply,
  approveAndSend,
];
