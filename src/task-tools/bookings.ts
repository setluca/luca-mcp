import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";

import type { LucaError } from "../errors.ts";
import {
  IanaTimeZone,
  IsoDateTime,
  NonEmptyString,
  WORKSPACE_INPUT_FIELDS,
} from "../fields.ts";
import type { LucaApi } from "../http.ts";
import { optionalField } from "../optional-field.ts";
import type { JsonValue } from "../serialization.ts";
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

/** A slot from Luca's own scheduler, as the provider booking route takes it. */
const ManagedSlotPage = Schema.Struct({
  slots: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      startsAt: Schema.String,
      endsAt: Schema.String,
      timezone: Schema.String,
    })
  ),
});

const decodeManagedSlotPage = Schema.decodeUnknownOption(ManagedSlotPage);

const SlotTakenBody = Schema.Struct({
  error: Schema.Struct({ code: Schema.Literal("slot_unavailable") }),
});

const isSlotTakenBody = Schema.is(SlotTakenBody);

/**
 * The provider booking route's answer when the slot went between the
 * availability read and the booking: a 409 whose code names it.
 */
function isSlotTaken(error: LucaError): boolean {
  return (
    P.isTagged(error, "LucaHttpError") &&
    error.status === 409 &&
    isSlotTakenBody(error.body)
  );
}

const bookCall = taskTool({
  name: "luca_book_call",
  title: "Book a call with a lead",
  description:
    'Book a call on the coach\'s calendar provider and have the provider invite the lead\'s email. Reads the open slots of the call type first and books the one that starts at slotAt. When that slot is taken it books nothing and returns the open slots instead, so pick one of them and call again. The answer can be pending while the provider confirms; check it with luca_bookings_provider_requests_get. Booking moves the lead to booked, so pass confirm: true only after the coach approves this exact slot. Reuse the idempotencyKey when retrying the same booking. If a retry answers slot_not_available, the first attempt may have taken the slot, so check luca_bookings_list before booking again. To record a call that is already on a calendar, use luca_bookings_create instead. Example: call with { leadId, bookingTypeId, slotAt: "2026-07-14T15:00:00Z", inviteeEmail: "sam@example.com", confirm: true } after the lead agreed to a time.',
  inputSchema: {
    ...WORKSPACE_INPUT_FIELDS,
    leadId: NonEmptyString.annotate({ description: "The lead to book." }),
    bookingTypeId: NonEmptyString.annotate({
      description:
        "The call type to book, from luca_bookings_types_list. Its provider is the calendar the call lands on.",
    }),
    slotAt: IsoDateTime.annotate({
      description:
        "ISO-8601 start time for the call, with an offset. It must be an open slot of the call type, as luca_bookings_managed_availability lists them.",
    }),
    inviteeEmail: NonEmptyString.annotate({
      description: "The lead's email. The provider sends the invite there.",
    }),
    inviteeName: Schema.optionalKey(
      NonEmptyString.check(Schema.isMaxLength(200)).annotate({
        description: "The lead's name as the invite should show it.",
      })
    ),
    timezone: Schema.optionalKey(
      IanaTimeZone.annotate({
        description:
          "IANA time zone the booking is shown in, such as Europe/Madrid. Defaults to UTC.",
      })
    ),
    ...idempotencyKeyInput(
      "Reuse the same key when retrying this exact booking, so the API replays the first result instead of booking twice."
    ),
  },
  outputSchema: Schema.Union([
    slotNotAvailable("booked"),
    operationResult("bookings.providerRequests.create"),
  ]),
  composes: [
    "bookings.managedAvailability",
    "bookings.providerRequests.create",
  ],
  run: (call, input) =>
    Effect.gen(function* () {
      const slotAt = stringInput(input.slotAt);
      // oxlint-disable-next-line effect/use-clock-service -- parse date value from stored data
      const start = new Date(slotAt);

      // The provider route books only a slot the scheduler offers, so its id
      // and end come from this read. A failed read fails the tool: there is
      // nothing to book without it.
      const page = yield* call("bookings.managedAvailability", {
        query: {
          bookingTypeId: stringInput(input.bookingTypeId),
          timezone:
            input.timezone === undefined ? "UTC" : stringInput(input.timezone),
          start: start.toISOString(),
          // oxlint-disable-next-line effect/use-clock-service -- parse date value from stored data
          end: new Date(start.getTime() + AVAILABILITY_WINDOW_MS).toISOString(),
        },
      });

      const slots = decodeManagedSlotPage(page).pipe(
        Option.map((parsed) => parsed.slots),
        Option.getOrElse(() => [])
      );

      const slot = slots.find((candidate) =>
        sameInstant(candidate.startsAt, slotAt)
      );

      const others = slots
        .filter((candidate) => candidate !== slot)
        .map((candidate) => candidate.startsAt);

      const taken = {
        booked: false,
        reason: "slot_not_available",
        requestedSlotAt: slotAt,
        openSlots: others,
      };

      if (slot === undefined) {
        return taken;
      }

      return yield* call("bookings.providerRequests.create", {
        body: {
          leadId: input.leadId,
          bookingTypeId: input.bookingTypeId,
          slotId: slot.id,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          timezone: slot.timezone,
          inviteeEmail: input.inviteeEmail,
          ...optionalField("inviteeName", input.inviteeName),
        },
      }).pipe(
        // The slot went between the read and the booking. Hand back the rest
        // so the agent can pick again in one turn.
        Effect.catchIf(isSlotTaken, () => Effect.succeed<JsonValue>(taken))
      );
    }),
});

/** How long a reschedule link stays usable when the caller names no window. */
const DEFAULT_GUEST_LINK_HOURS = 168;

const rescheduleCall = taskTool({
  name: "luca_reschedule_call",
  title: "Move a call to a new time",
  description:
    'Move a booked call to a new time and hand back a fresh reschedule link for the lead. Checks the new slot is open first, against the schedule of its booking type when it has one, and returns the open slots instead of moving the call when it is taken. A call with an idempotencyKey skips that check so a retry gets the original result back. A manual booking moves in Luca only. A Cal.com or Google Calendar booking moves on that calendar too. A Calendly, GoHighLevel or iClosed booking is refused so the coach can move it with the provider, and so is a provider booking with no calendar event, such as one recorded with luca_bookings_create. Moving the call re-arms the lead\'s reminder for the new time, so pass confirm: true only after the coach approves the move. Example: call with { bookingId, slotAt: "2026-07-16T15:00:00Z", confirm: true } after the lead asked to push the call. No message about the move is sent: send the lead the link yourself, or draft the message through the review queue.',
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
