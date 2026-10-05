import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ToolFields } from "./openapi-schema.ts";

/**
 * Input field schemas that operation tools and task tools share. Both kinds of
 * tool reach a client in one list, so a field means the same thing wherever it
 * appears.
 */

/** A UUID in its canonical 8-4-4-4-12 hex form. */
export const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A leap year: divisible by 4, except centuries not divisible by 400. */
const LEAP_YEAR = String.raw`(?:\d{2}(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00)`;

/**
 * A calendar date that exists: each month's own last day, and 29 February
 * only in a leap year. `Date` cannot check this, because it rolls 31 February
 * over to early March instead of refusing it.
 */
const CALENDAR_DATE = [
  String.raw`\d{4}-(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])`,
  String.raw`\d{4}-(?:0[469]|11)-(?:0[1-9]|[12]\d|30)`,
  String.raw`\d{4}-02-(?:0[1-9]|1\d|2[0-8])`,
  `${LEAP_YEAR}-02-29`,
].join("|");

const CLOCK_TIME = String.raw`(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?`;

const UTC_OFFSET = String.raw`(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)`;

/**
 * An ISO-8601 instant with an explicit offset, such as `2026-07-14T15:00:00Z`,
 * that names a real moment: no month 13, no 31 February, no hour 25. It is one
 * pattern rather than a pattern plus a filter so the generated input schemas,
 * which can only print patterns, enforce the same rule as the task tools.
 */
// fallow-ignore-next-line security-sink -- the pattern is built from three fixed string constants in this file, never from caller input
export const ISO_DATE_TIME_PATTERN = new RegExp(
  `^(?:${CALENDAR_DATE})T${CLOCK_TIME}${UTC_OFFSET}$`
);

/** A string of at least one character. */
export const NonEmptyString = Schema.String.check(Schema.isMinLength(1));

// fallow-ignore-next-line unused-type -- required by effect/require-schema-type-alias
export type NonEmptyString = typeof NonEmptyString.Type;

const Uuid = Schema.String.check(Schema.isPattern(UUID_PATTERN)).annotate({
  format: "uuid",
});

/** An instant matching {@link ISO_DATE_TIME_PATTERN}. */
export const IsoDateTime = Schema.String.check(
  Schema.isPattern(ISO_DATE_TIME_PATTERN)
).annotate({ format: "date-time" });

// fallow-ignore-next-line unused-type -- required by effect/require-schema-type-alias
export type IsoDateTime = typeof IsoDateTime.Type;

/** An IANA time zone name the runtime knows, such as `America/New_York`. */
export const IanaTimeZone = NonEmptyString.check(
  // oxlint-disable-next-line effect/require-filter-metadata -- an identifier turns this field into a `$ref` in every tool's input schema.
  Schema.makeFilter(
    (value: string) => Option.isSome(DateTime.zoneMakeNamed(value)),
    { expected: "an IANA time zone name" }
  )
);

/** The messaging channels a lead can arrive on. */
export const MESSAGING_CHANNELS = [
  "telegram",
  "instagram",
  "messenger",
  "whatsapp",
] as const;

export const MessagingChannel = Schema.Literals(MESSAGING_CHANNELS);

// fallow-ignore-next-line unused-type -- required by effect/require-schema-type-alias
export type MessagingChannel = typeof MessagingChannel.Type;

export const WORKSPACE_INPUT_FIELDS = {
  workspaceId: Schema.optionalKey(
    Uuid.annotate({ description: "Optional Luca workspace id override." })
  ),
  workspaceSlug: Schema.optionalKey(
    NonEmptyString.annotate({
      description: "Optional Luca workspace slug override.",
    })
  ),
} satisfies ToolFields;

/**
 * The confirmation gate's input field. One wording covers both kinds of tool
 * because a client sees one tool list: the effects named here are the union of
 * what either kind can do, not a guess at which one the reader is holding.
 */
export const confirmInput = {
  confirm: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "This tool has a real-world side effect: it messages real leads, books, moves, or cancels a call, changes a lead's consent, imports leads, writes to a connected calendar or CRM, sends workspace events to an outside URL, or re-triggers downstream automations. Pass confirm: true to proceed; the call is rejected without it.",
    })
  ),
} satisfies ToolFields;
