import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { LucaError } from "../errors.ts";
import {
  IsoDateTime,
  NonEmptyString,
  WORKSPACE_INPUT_FIELDS,
} from "../fields.ts";
import type { LucaApi } from "../http.ts";
import { optionalField } from "../optional-field.ts";
import {
  failureAsField,
  idempotencyKeyInput,
  isPartialFailure,
  numberInput,
  operationResult,
  resultOrError,
  stringInput,
  type TaskCall,
  type TaskToolInput,
  taskTool,
} from "./runtime.ts";

/** The providers the API accepts on an availability read and on a booking. */
const BOOKING_PROVIDERS = [
  "manual",
  "calendly",
  "cal_com",
  "google_calendar",
  "iclosed",
  "gohighlevel",
] as const;

/**
 * Whether the caller is retrying under a key. A retry may follow a booking that
 * landed while its response was lost, so the slot can be taken by that very
 * booking. Checking availability first would answer slot_not_available and
 * never reach the API's replay of the first result.
 */
function isRetry(input: TaskToolInput): boolean {
  return input.idempotencyKey !== undefined;
}

/** How far past the requested slot to look when offering alternatives. */
const AVAILABILITY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The window an availability read covers, starting at the requested slot. */
type AvailabilityWindow = { readonly start: string; readonly end: string };

const AvailabilityPage = Schema.Struct({
  source: Schema.String,
  slots: Schema.Array(Schema.Struct({ startsAt: Schema.String })),
});

const decodeAvailabilityPage = Schema.decodeUnknownOption(AvailabilityPage);

const ManagedAvailabilityPage = Schema.Struct({
  slots: Schema.Array(Schema.Struct({ startsAt: Schema.String })),
});

const decodeManagedAvailabilityPage = Schema.decodeUnknownOption(
  ManagedAvailabilityPage
);

const BookingBookingType = Schema.Struct({
  booking: Schema.Struct({
    bookingTypeId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
});

const decodeBookingBookingType = Schema.decodeUnknownOption(BookingBookingType);

/**
 * Open slots from the provider route. It answers with `source: "fallback"` or
 * `"provider_error"` when it could not reach the provider, and it defaults to
 * Calendly when the caller names no provider, so a coach on Cal.com asking
 * without one gets a confident-looking answer about the wrong calendar. Only a
 * `live_provider` read counts.
 */
const providerSlots = (
  call: TaskCall<"bookings.availability">,
  input: TaskToolInput,
  window: AvailabilityWindow
) =>
  call("bookings.availability", {
    query: { ...window, ...optionalField("provider", input.provider) },
  }).pipe(
    Effect.map((page) =>
      decodeAvailabilityPage(page).pipe(
        Option.filter((parsed) => parsed.source === "live_provider"),
        Option.map((parsed) => parsed.slots)
      )
    )
  );

/**
 * Open slots for one booking type, from Luca's own scheduler. The provider
 * route knows nothing of booking types, so it would judge the slot against
 * the wrong calendar. Times are compared as instants, so the display timezone
 * does not matter.
 */
const bookingTypeSlots = (
  call: TaskCall<"bookings.managedAvailability">,
  bookingTypeId: string,
  window: AvailabilityWindow
) =>
  call("bookings.managedAvailability", {
    query: { ...window, bookingTypeId, timezone: "UTC" },
  }).pipe(
    Effect.map((page) =>
      decodeManagedAvailabilityPage(page).pipe(
        Option.map((parsed) => parsed.slots)
      )
    )
  );

/**
 * The booking type a booking was made under, read from the booking itself.
 *
 * `Option.none()` means the read failed, and `Option.some(null)` is a booking
 * on no booking type. Both are judged against the provider calendar, as before
 * this read existed. A refused token still ends the call, see
 * isPartialFailure.
 */
const bookingTypeOf = (call: TaskCall<"bookings.get">, bookingId: string) =>
  call("bookings.get", { pathParams: { id: bookingId } }).pipe(
    Effect.map((page) =>
      decodeBookingBookingType(page).pipe(
        Option.map((parsed) => parsed.booking.bookingTypeId ?? null)
      )
    ),
    Effect.catchIf(isPartialFailure, () => Effect.succeedNone)
  );

/**
 * The slots `readSlots` reports open in the window starting at `slotAt`.
 *
 * `Option.none()` means "we could not tell", which is different from "nothing
 * is open", and never blocks a booking. A call that carries an idempotency key
 * skips the read, see {@link isRetry}.
 */
const openSlotsAt = (
  input: TaskToolInput,
  slotAt: string,
  readSlots: (
    window: AvailabilityWindow
  ) => Effect.Effect<
    Option.Option<readonly { readonly startsAt: string }[]>,
    LucaError,
    LucaApi
  >
) =>
  Effect.gen(function* () {
    // A keyed call is a retry, and the API replays the first answer for it.
    if (isRetry(input)) {
      return Option.none<readonly string[]>();
    }

    // oxlint-disable-next-line effect/use-clock-service -- parse date value from stored data
    const start = new Date(slotAt);

    if (Number.isNaN(start.getTime())) {
      return Option.none<readonly string[]>();
    }

    const window: AvailabilityWindow = {
      start: start.toISOString(),
      // oxlint-disable-next-line effect/use-clock-service -- parse date value from stored data
      end: new Date(start.getTime() + AVAILABILITY_WINDOW_MS).toISOString(),
    };

    const slots = yield* readSlots(window).pipe(
      // A failed availability read must not block the booking. The agent is no
      // worse off than before this check existed. A refused token still ends
      // the call, see isPartialFailure.
      Effect.catchIf(isPartialFailure, () => Effect.succeedNone)
    );

    return Option.map(slots, (open): readonly string[] =>
      open.map((slot) => slot.startsAt)
    );
  });

/**
 * Whether two ISO-8601 instants name the same moment, whatever their offset.
 *
 * An unparseable instant is `NaN`, which is not equal to itself, so a garbled
 * slot on either side answers false without a guard of its own.
 */
function sameInstant(left: string, right: string): boolean {
  // oxlint-disable-next-line effect/use-clock-service -- parse date value from stored data
  return new Date(left).getTime() === new Date(right).getTime();
}

/** What a booking tool returns instead of writing when the slot is taken. */
function slotNotAvailable<const Key extends string>(key: Key) {
  return Schema.Struct({
    [key]: Schema.Literal(false),
    reason: Schema.Literal("slot_not_available"),
    requestedSlotAt: Schema.String,
    openSlots: Schema.Array(Schema.String),
  });
}

const bookCall = taskTool({
  name: "luca_book_call",
  title: "Book a call with a lead",
  description:
    'Book a lead into a slot the provider confirms is open. Checks availability first, against the schedule of the booking type when bookingTypeId is given, and returns the open slots instead of booking when the requested one is taken. A call with an idempotencyKey skips that check so a retry gets the original result back. Booking moves the lead to booked and notifies the coach\'s webhook subscribers, so pass confirm: true only after the coach approves this exact slot. Example: call with { leadId, slotAt: "2026-07-14T15:00:00Z", confirm: true } after the lead agreed to a time.',
  inputSchema: {
    ...WORKSPACE_INPUT_FIELDS,
    leadId: NonEmptyString.annotate({ description: "The lead to book." }),
    slotAt: IsoDateTime.annotate({
      description: "ISO-8601 start time for the call, with an offset.",
    }),
    provider: Schema.optionalKey(
      Schema.Literals(BOOKING_PROVIDERS).annotate({
        description:
          "The coach's booking provider. Sent with the booking and used for the availability check. Pass it when the coach is not on Calendly, or the availability check reads the wrong calendar. Left off, the check reads Calendly and the API records the booking as manual.",
      })
    ),
    bookingTypeId: Schema.optionalKey(
      NonEmptyString.annotate({
        description:
          "The booking type to book under, from luca_bookings_types_list. Required when provider is google_calendar, and it must be an active google_calendar type.",
      })
    ),
    ...idempotencyKeyInput(
      "Reuse the same key when retrying this exact booking. A keyed call skips the availability check and lets the API replay the first result."
    ),
  },
  outputSchema: Schema.Union([
    slotNotAvailable("booked"),
    operationResult("bookings.create"),
  ]),
  composes: [
    "bookings.availability",
    "bookings.managedAvailability",
    "bookings.create",
  ],
  run: (call, input) =>
    Effect.gen(function* () {
      const slotAt = stringInput(input.slotAt);

      // A booking type has its own schedule, which the provider route knows
      // nothing of.
      const open = yield* openSlotsAt(input, slotAt, (window) =>
        input.bookingTypeId === undefined
          ? providerSlots(call, input, window)
          : bookingTypeSlots(call, stringInput(input.bookingTypeId), window)
      );

      // Refuse only on a confident "that slot is not open". Handing back the
      // real slots lets the agent pick again in one turn instead of writing a
      // booking the provider will reject later.
      if (
        Option.isSome(open) &&
        !open.value.some((candidate) => sameInstant(candidate, slotAt))
      ) {
        return {
          booked: false,
          reason: "slot_not_available",
          requestedSlotAt: slotAt,
          openSlots: open.value,
        };
      }

      return yield* call("bookings.create", {
        body: {
          leadId: input.leadId,
          slotAt: input.slotAt,
          ...optionalField("provider", input.provider),
          ...optionalField("bookingTypeId", input.bookingTypeId),
        },
      });
    }),
});

/** How long a reschedule link stays usable when the caller names no window. */
const DEFAULT_GUEST_LINK_HOURS = 168;

const rescheduleCall = taskTool({
  name: "luca_reschedule_call",
  title: "Move a call to a new time",
  description:
    'Move a booked call to a new time and hand back a fresh reschedule link for the lead. Checks the new slot is open first, against the schedule of its booking type when it has one, and returns the open slots instead of moving the call when it is taken. A call with an idempotencyKey skips that check so a retry gets the original result back. Moving the call updates the connected calendar and re-arms the lead\'s reminder for the new time, so pass confirm: true only after the coach approves the move. Example: call with { bookingId, slotAt: "2026-07-16T15:00:00Z", confirm: true } after the lead asked to push the call. No message about the move is sent: send the lead the link yourself, or draft the message through the review queue.',
  inputSchema: {
    ...WORKSPACE_INPUT_FIELDS,
    bookingId: NonEmptyString.annotate({ description: "The booking to move." }),
    slotAt: IsoDateTime.annotate({
      description: "ISO-8601 start time to move the call to, with an offset.",
    }),
    provider: Schema.optionalKey(
      Schema.Literals(BOOKING_PROVIDERS).annotate({
        description:
          "The coach's booking provider. Used only for the availability check, and only when the booking has no booking type. The booking keeps the provider it already has. Pass it when the coach is not on Calendly, or the availability check reads the wrong calendar.",
      })
    ),
    expiresInHours: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 720 })).annotate(
        {
          description: `How long the new reschedule link stays usable. Defaults to ${DEFAULT_GUEST_LINK_HOURS} hours.`,
        }
      )
    ),
    ...idempotencyKeyInput(
      "Reuse the same key when retrying this exact reschedule. A keyed call skips the availability check and lets the API replay the first result."
    ),
  },
  outputSchema: Schema.Union([
    slotNotAvailable("rescheduled"),
    Schema.Struct({
      rescheduled: Schema.Literal(true),
      booking: operationResult("bookings.update"),
      guestLinks: resultOrError(
        "bookings.guestLinks.create",
        "guestLinksError"
      ),
    }),
  ]),
  composes: [
    "bookings.get",
    "bookings.availability",
    "bookings.managedAvailability",
    "bookings.update",
    "bookings.guestLinks.create",
  ],
  run: (call, input) =>
    Effect.gen(function* () {
      const slotAt = stringInput(input.slotAt);
      const bookingId = stringInput(input.bookingId);

      // A booking made under a booking type keeps that type's own schedule, so
      // the provider calendar would judge the new slot against the wrong
      // availability. The read happens only when the availability check does.
      const open = yield* openSlotsAt(input, slotAt, (window) =>
        Effect.flatMap(bookingTypeOf(call, bookingId), (bookingType) =>
          Option.match(
            Option.flatMapNullishOr(bookingType, (id) => id),
            {
              onNone: () => providerSlots(call, input, window),
              onSome: (bookingTypeId) =>
                bookingTypeSlots(call, bookingTypeId, window),
            }
          )
        )
      );

      if (
        Option.isSome(open) &&
        !open.value.some((candidate) => sameInstant(candidate, slotAt))
      ) {
        return {
          rescheduled: false,
          reason: "slot_not_available",
          requestedSlotAt: slotAt,
          openSlots: open.value,
        };
      }

      const booking = yield* call("bookings.update", {
        pathParams: { id: bookingId },
        body: { slotAt },
      });

      // The call has already moved by the time the link is minted. Failing the
      // whole tool here would tell the agent the reschedule did not happen,
      // when the only thing missing is a link it can mint again.
      const guestLinks = yield* failureAsField(
        "guestLinksError",
        call("bookings.guestLinks.create", {
          pathParams: { id: bookingId },
          body: {
            expiresInHours: numberInput(
              input.expiresInHours,
              DEFAULT_GUEST_LINK_HOURS
            ),
          },
        })
      );

      return { rescheduled: true, booking, guestLinks };
    }),
});

export const bookingTaskTools = [bookCall, rescheduleCall];
