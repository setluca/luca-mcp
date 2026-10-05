import { op } from "../registry.ts";
import type { LucaOperation } from "../registry.ts";

export const bookingsOperations: readonly LucaOperation[] = [
  op({
    id: "bookings.list",
    title: "List bookings",
    description:
      "List bookings. Query supports limit, cursor, status, and upcoming.",
    // Each booking carries a cancellation reason the invitee may have written.
    untrustedContent: true,
  }),
  op({
    id: "bookings.create",
    title: "Book a call",
    // Moves the lead to booked and tells every webhook subscriber. Gated like
    // reschedule and cancel so one approval covers each change to a lead's call.
    confirm: "always",
    // The booking webhook reaches subscribers outside Luca.
    openWorld: true,
    description:
      "Create a provider-neutral booking record. Body requires leadId and slotAt.",
    // Each booking carries a cancellation reason the invitee may have written.
    untrustedContent: true,
  }),
  op({
    id: "bookings.get",
    title: "Get a booking",
    description: "Read one booking: its slot, status, provider, and lead.",
    // Each booking carries a cancellation reason the invitee may have written.
    untrustedContent: true,
  }),
  op({
    id: "bookings.availability",
    title: "Read open call slots",
    description:
      "List open slots the coach can actually be booked into. Check this before booking.",
  }),
  op({
    id: "bookings.managedAvailability",
    title: "Read Luca-managed call slots",
    description:
      "List open slots for one of Luca's own call types, with calendar conflicts already removed.",
  }),
  op({
    id: "bookings.types.list",
    title: "List call types",
    description:
      "List the call types a booking can use, with their duration and provider.",
  }),
  op({
    id: "bookings.types.schedule",
    title: "Read a call type's schedule",
    description:
      "Read a call type's weekly schedule: the hours it can be booked and its time zone.",
  }),
  op({
    id: "bookings.types.attendees",
    title: "List a call type's attendees",
    description:
      "List the people invited to every call of this type, on top of the lead.",
  }),
  op({
    id: "bookings.providers.list",
    title: "List booking providers",
    description:
      "List every booking provider, what each can do, and whether this coach's connection is healthy.",
  }),
  op({
    id: "bookings.providers.get",
    title: "Get a booking provider",
    description:
      "List the event types and calendars in one connected provider account.",
  }),
  op({
    id: "bookings.calendars.list",
    title: "List connected calendars",
    description:
      "List the calendars Luca reads for conflicts, and which one it writes new events to.",
  }),
  op({
    id: "bookings.outcomeReasons.list",
    title: "List loss reasons",
    description:
      "List the reasons a sale can be lost or a call cancelled. Use one of these codes when recording an outcome.",
  }),
  op({
    id: "bookings.outcome.get",
    title: "Get a booking's outcome",
    description:
      "Read where the sale stands on a booking, plus the version you send back to correct it.",
  }),
  op({
    id: "bookings.outcome.history",
    title: "Read a booking's outcome history",
    description:
      "Read every outcome ever recorded on a booking, in order. Corrections append rather than overwrite.",
  }),
  op({
    id: "bookings.needsOutcome",
    title: "List calls with no outcome recorded",
    description:
      "List attended calls with no outcome recorded yet. The work list for closing revenue attribution.",
    // Each row carries the lead's name, which the lead controls.
    untrustedContent: true,
  }),
  op({
    id: "bookings.lifecycleAttention",
    title: "List bookings needing attention",
    description:
      "List bookings where Luca's record and the provider's disagree and a human has to decide.",
    // Each booking carries a cancellation reason the invitee may have written.
    untrustedContent: true,
  }),
  op({
    id: "bookings.brief",
    title: "Read a pre-call brief",
    description:
      "Read the pre-call brief: who the lead is, what they want, and the objections to expect.",
    untrustedContent: true,
  }),
  op({
    id: "bookings.update",
    title: "Reschedule or edit a booking",
    openWorld: true,
    mutatesExisting: true,
    // Moves the call on the provider calendar and re-arms the lead's reminder.
    confirm: "always",
    description: "Reschedule or update booking status.",
    // Each booking carries a cancellation reason the invitee may have written.
    untrustedContent: true,
  }),
  op({
    id: "bookings.cancel",
    title: "Cancel a booking",
    openWorld: true,
    mutatesExisting: true,
    // Cancels a real call on the lead's and the coach's calendars.
    confirm: "always",
    description: "Cancel a booking.",
    // Each booking carries a cancellation reason the invitee may have written.
    untrustedContent: true,
  }),
  op({
    id: "bookings.outcome.record",
    title: "Record a booking's outcome",
    mutatesExisting: true,
    description:
      "Record what the call was worth: won, lost with a reason, or still open. To correct an earlier outcome send the expectedVersion you read; a stale version returns 409 with the current one.",
  }),
  op({
    id: "bookings.lifecycleResolution",
    title: "Resolve a booking's lifecycle flag",
    openWorld: true,
    confirm: "always",
    mutatesExisting: true,
    description:
      "Settle one booking whose record disagrees with the provider's: retry the sync, dismiss the duplicate, or keep Luca's version.",
    // Each booking carries a cancellation reason the invitee may have written.
    untrustedContent: true,
  }),
  op({
    id: "bookings.providerSync.retry",
    title: "Retry a booking's provider sync",
    openWorld: true,
    confirm: "always",
    mutatesExisting: true,
    description:
      "Retry a failed write-back to the booking provider. A permanent failure returns 409 rather than retrying forever.",
  }),
  op({
    id: "bookings.guestLinks.create",
    title: "Create a guest link for a booking",
    description:
      "Mint revocable reschedule and cancel links for one booking, so a lead can move the call without an account.",
  }),
  op({
    id: "bookings.guestLinks.revoke",
    title: "Revoke a booking's guest links",
    mutatesExisting: true,
    description: "Kill every outstanding guest link on a booking at once.",
  }),
  op({
    id: "bookings.outcomeReasons.create",
    title: "Create a loss reason",
    description:
      "Add a lost-sale or cancellation reason in the workspace's own wording. A code already in use returns 409.",
  }),
  op({
    id: "bookings.outcomeReasons.update",
    title: "Update a loss reason",
    mutatesExisting: true,
    description:
      "Rename, reorder, or archive an outcome reason. Archiving hides it from the picker and leaves recorded outcomes alone.",
  }),
  op({
    id: "bookings.types.create",
    title: "Create a booking type",
    description:
      "Define a bookable call: how long it runs, where it happens, and how it looks to the lead. Give it a schedule next \u2014 a booking type with no schedule offers no slots and will never appear in availability.",
  }),
  op({
    id: "bookings.types.update",
    title: "Update a booking type",
    mutatesExisting: true,
    description:
      "Update only the fields you send on one booking type. Sending `location` replaces the whole location, because its shape depends on the type.",
  }),
  op({
    id: "bookings.types.delete",
    title: "Delete a booking type",
    description:
      "Remove a booking type and get back the types that are left. Calls already booked against it are not cancelled.",
  }),
  op({
    id: "bookings.types.schedule.replace",
    title: "Replace a booking type schedule",
    mutatesExisting: true,
    description:
      "Replace a booking type's schedule outright. Send every rule and override you want to keep \u2014 anything left out is dropped, which is also how you clear a day. Read the current schedule first unless you mean to start over.",
  }),
  op({
    id: "bookings.types.attendees.add",
    title: "Add a booking type attendee",
    description:
      "Add a standing attendee to one booking type, so they are invited to every call booked against it. Returns the full attendee list.",
  }),
  op({
    id: "bookings.types.attendees.remove",
    title: "Remove a booking type attendee",
    mutatesExisting: true,
    description:
      "Remove a standing attendee from one booking type and get back the ones that are left. Calls already booked keep the invitees they were created with.",
  }),
  op({
    id: "bookings.calendars.select",
    title: "Select a booking calendar",
    mutatesExisting: true,
    description:
      "Add or update a calendar selection, either for conflict checks or as the destination new bookings are written to. The destination has to be writable: a read-only calendar returns 400, and a Google connection needing attention returns 409.",
  }),
  op({
    id: "bookings.calendars.remove",
    title: "Remove a booking calendar",
    mutatesExisting: true,
    description:
      "Stop using a calendar for conflict checks or as the booking destination. The calendar itself is left alone in Google; only Luca's selection changes.",
  }),
];
