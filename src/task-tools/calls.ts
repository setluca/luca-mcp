import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { isNotFound, LucaToolInputError, type LucaError } from "../errors.ts";
import {
  IanaTimeZone,
  IsoDateTime,
  NonEmptyString,
  WORKSPACE_INPUT_FIELDS,
} from "../fields.ts";
import { optionalField } from "../optional-field.ts";
import type {
  JsonInputObject,
  JsonValue,
  JsonValueInput,
} from "../serialization.ts";
import {
  failureAsField,
  idempotencyKeyInput,
  operationResult,
  resultOrError,
  stringInput,
  taskTool,
  textBody,
} from "./runtime.ts";

const isNonEmptyString = Schema.is(NonEmptyString);

const postCallQueue = taskTool({
  name: "luca_post_call_queue",
  title: "List the post-call work",
  description:
    "Return everything waiting on the coach after a call: calls that still need a report on how they went, and attended calls with no revenue outcome recorded. The two halves are tracked separately by the API, so a call can sit on one list and not the other. Close an item with luca_close_call_loop. Example: call with {} after a day of calls.",
  inputSchema: {
    ...WORKSPACE_INPUT_FIELDS,
  },
  outputSchema: Schema.Struct({
    needingFeedback: operationResult("callEvents.needingFeedback"),
    needingOutcome: operationResult("bookings.needsOutcome"),
  }),
  composes: ["callEvents.needingFeedback", "bookings.needsOutcome"],
  run: (call) =>
    // Neither read depends on the other, and Effect.all defaults to
    // concurrency 1, so without this the second waits on the first for nothing.
    Effect.all(
      {
        needingFeedback: call("callEvents.needingFeedback"),
        needingOutcome: call("bookings.needsOutcome"),
      },
      { concurrency: "unbounded" }
    ),
});

/**
 * The id of the call event attached to a booking, if the API has one. A booking
 * whose call has not happened yet answers 404, which is the normal case rather
 * than a failure. So is any other read error here, because the outcome write
 * below is worth doing on its own.
 */
const CallEventId = Schema.Struct({
  callEvent: Schema.Struct({ id: Schema.String }),
});

const decodeCallEventId = Schema.decodeUnknownOption(CallEventId);

const ATTENDANCE_VALUES = [
  "completed",
  "no_show",
  "rescheduled",
  "cancelled",
] as const;

const OUTCOME_VALUES = ["won", "lost", "open"] as const;

const decodeOutcomeStatus = Schema.decodeUnknownOption(
  Schema.Literals(OUTCOME_VALUES)
);

/**
 * A field the chosen outcome status makes mandatory. The tool schema marks all
 * three optional because which one is required depends on `outcome`, and a flat
 * field list cannot say that, so the check lands here.
 *
 * It has to reach the error channel rather than throw. `outcomeBody` is built
 * as an argument to the request the tool sends, so a throw would escape the
 * `failureAsField` around that request and surface as a defect — after the
 * attendance report had already landed, which is the one thing that call is
 * there to prevent.
 */
function requiredFor(
  status: (typeof OUTCOME_VALUES)[number],
  field: string,
  value: JsonValueInput
): Effect.Effect<string, LucaError, never> {
  return isNonEmptyString(value)
    ? Effect.succeed(value)
    : Effect.fail(
        new LucaToolInputError({
          message: `${field} is required when outcome is ${status}.`,
        })
      );
}

/**
 * The revenue half of the body, shaped by the status it carries. The API takes
 * one of three variants and rejects a mix, so building it here keeps the tool
 * from sending, say, an amount alongside a loss reason.
 */
function outcomeBody(input: {
  readonly status: (typeof OUTCOME_VALUES)[number];
  readonly note: JsonValueInput;
  readonly amountMinor: JsonValueInput;
  readonly currency: JsonValueInput;
  readonly lossReasonDefinitionId: JsonValueInput;
  readonly nextFollowUpAt: JsonValueInput;
  readonly followUpTimezone: JsonValueInput;
  readonly expectedVersion: JsonValueInput;
}): Effect.Effect<JsonInputObject, LucaError, never> {
  const common = {
    status: input.status,
    ...textBody("note", input.note),
    ...optionalField("expectedVersion", input.expectedVersion),
  };

  if (input.status === "won") {
    return Effect.succeed({
      ...common,
      ...optionalField("amountMinor", input.amountMinor),
      ...textBody("currency", input.currency),
    });
  }

  if (input.status === "lost") {
    return Effect.map(
      requiredFor(
        "lost",
        "lossReasonDefinitionId",
        input.lossReasonDefinitionId
      ),
      (lossReasonDefinitionId) => ({ ...common, lossReasonDefinitionId })
    );
  }

  return Effect.map(
    Effect.all(
      {
        nextFollowUpAt: requiredFor(
          "open",
          "nextFollowUpAt",
          input.nextFollowUpAt
        ),
        followUpTimezone: requiredFor(
          "open",
          "followUpTimezone",
          input.followUpTimezone
        ),
      },
      { concurrency: 1 }
    ),
    (followUp) => ({ ...common, ...followUp })
  );
}

const closeCallLoop = taskTool({
  name: "luca_close_call_loop",
  title: "Close the loop on a call",
  description:
    'File what happened on a call and what it was worth, in one call. Reports attendance on the call event (completed, no_show, rescheduled, or cancelled) and, when an outcome is given, records the booking outcome: won with an amount, lost with a reason id from luca_bookings_outcome_reasons_list, or open with the next follow-up. This tool sends no message to the lead itself, but the records it files start work in the API. Reporting a no_show can start no-show recovery, which schedules a message to the lead when the booking type has recovery on. A completed call queues its summary, which can later sync to the connected CRM. A won or lost outcome queues a CRM deal-stage update, and lost also moves the lead to lost. Pass confirm: true before reporting a no_show or recording a won or lost outcome. Example: { bookingId, attendance: "completed", outcome: "won", amountMinor: 250000, currency: "USD", confirm: true }.',
  // Recovery messaging and CRM deal updates are the two external effects.
  confirm: {
    applies: (input) =>
      input.attendance === "no_show" ||
      input.outcome === "won" ||
      input.outcome === "lost",
    description:
      "attendance is no_show or outcome is won or lost (can message a lead or update a connected CRM deal)",
  },
  inputSchema: {
    ...WORKSPACE_INPUT_FIELDS,
    bookingId: NonEmptyString.annotate({
      description: "The booking whose call just happened.",
    }),
    attendance: Schema.Literals(ATTENDANCE_VALUES).annotate({
      description: "What happened to the call itself.",
    }),
    rating: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })).annotate({
        description: "The coach's 1-5 rating of the call.",
      })
    ),
    notes: Schema.optionalKey(
      NonEmptyString.check(Schema.isMaxLength(4000)).annotate({
        description: "The coach's notes on the call, stored on the call event.",
      })
    ),
    outcome: Schema.optionalKey(
      Schema.Literals(OUTCOME_VALUES).annotate({
        description:
          "The revenue outcome. Leave it off to report attendance only and record the money later.",
      })
    ),
    amountMinor: Schema.optionalKey(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
        description: "Deal value in minor units (cents) when outcome is won.",
      })
    ),
    currency: Schema.optionalKey(
      Schema.String.check(
        Schema.isMinLength(3),
        Schema.isMaxLength(3)
      ).annotate({
        description: "ISO-4217 currency for amountMinor, uppercase.",
      })
    ),
    lossReasonDefinitionId: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "Required when outcome is lost: a reason id from luca_bookings_outcome_reasons_list.",
      })
    ),
    nextFollowUpAt: Schema.optionalKey(
      IsoDateTime.annotate({
        description: "Required when outcome is open: ISO-8601 follow-up time.",
      })
    ),
    followUpTimezone: Schema.optionalKey(
      IanaTimeZone.annotate({
        description:
          "Required when outcome is open: IANA timezone the follow-up is scheduled in.",
      })
    ),
    outcomeNote: Schema.optionalKey(
      NonEmptyString.check(Schema.isMaxLength(5000)).annotate({
        description: "Note stored on the revenue outcome, separate from notes.",
      })
    ),
    expectedVersion: Schema.optionalKey(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
        description:
          "The outcome version you read, when correcting an earlier outcome. A stale version returns 409 with the current one.",
      })
    ),
    ...idempotencyKeyInput(
      "Reuse the same key when retrying this exact report. Both writes are scoped by route, so one key covers the pair."
    ),
  },
  outputSchema: Schema.Struct({
    feedback: Schema.Union([
      resultOrError("callEvents.feedback", "feedbackError"),
      Schema.Struct({
        reported: Schema.Literal(false),
        reason: Schema.Literal("no_call_event_for_booking"),
      }),
    ]),
    outcome: Schema.optionalKey(
      resultOrError("bookings.outcome.record", "outcomeError")
    ),
  }),
  composes: [
    "callEvents.byBooking",
    "callEvents.feedback",
    "bookings.outcome.record",
  ],
  run: (call, input) =>
    Effect.gen(function* () {
      const bookingId = stringInput(input.bookingId);

      const outcomeStatus = decodeOutcomeStatus(input.outcome);

      // Built before either write. A revenue body this tool cannot assemble is
      // a bad call rather than a failed write, and refusing it up front leaves
      // nothing half-filed for the agent's retry to duplicate.
      const body = Option.isSome(outcomeStatus)
        ? yield* outcomeBody({
            status: outcomeStatus.value,
            note: input.outcomeNote,
            amountMinor: input.amountMinor,
            currency: input.currency,
            lossReasonDefinitionId: input.lossReasonDefinitionId,
            nextFollowUpAt: input.nextFollowUpAt,
            followUpTimezone: input.followUpTimezone,
            expectedVersion: input.expectedVersion,
          })
        : undefined;

      // The revenue write below is worth doing even when the attendance half
      // fails, so a failed lookup or report becomes a field rather than ending
      // the tool call. Only a 404 means the booking has no call event; any
      // other failure is reported as one, not mistaken for that answer.
      const feedback = yield* failureAsField(
        "feedbackError",
        call("callEvents.byBooking", { pathParams: { bookingId } }).pipe(
          Effect.catchIf(isNotFound, () => Effect.succeed(null)),
          Effect.flatMap((page) =>
            Option.match(decodeCallEventId(page), {
              onNone: () =>
                // No call event means attendance has nowhere to go. The
                // revenue write below still runs, and that is the half the
                // coach is usually after.
                Effect.succeed<JsonValue>({
                  reported: false,
                  reason: "no_call_event_for_booking",
                }),
              onSome: (decoded) =>
                call("callEvents.feedback", {
                  pathParams: { id: decoded.callEvent.id },
                  body: {
                    outcome: input.attendance,
                    ...optionalField("rating", input.rating),
                    ...textBody("notes", input.notes),
                  },
                }),
            })
          )
        )
      );

      if (body === undefined) {
        return { feedback };
      }

      // The attendance report already landed. Failing the whole tool here
      // would tell the agent nothing was written and invite a retry that files
      // the attendance twice under a fresh key.
      const outcome = yield* failureAsField(
        "outcomeError",
        call("bookings.outcome.record", {
          pathParams: { id: bookingId },
          body,
        })
      );

      return { feedback, outcome };
    }),
});

export const callTaskTools = [postCallQueue, closeCallLoop];
