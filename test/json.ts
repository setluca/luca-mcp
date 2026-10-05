import * as Schema from "effect/Schema";

/** The same unshaped JSON codec used by Luca's shared schema package. */
export const decodeUnknownJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Unknown)
);

export const encodeUnknownJson = Schema.encodeSync(
  Schema.fromJsonString(Schema.Unknown)
);
