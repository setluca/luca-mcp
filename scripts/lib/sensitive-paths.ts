import * as Arr from "effect/Array";
import * as MutableHashSet from "effect/MutableHashSet";
import * as Order from "effect/Order";
import * as P from "effect/Predicate";
import * as R from "effect/Record";

import { isJsonObject, type JsonValue } from "../../src/serialization.ts";

/** The vendor extension `sensitive()` in `@luca/schemas` writes into OpenAPI. */
const SENSITIVE_KEY = "x-luca-sensitive";

/**
 * Every field the API marks as lead-derived, sorted, as a dotted path with `[]`
 * for an array hop and `{}` for a record hop. These are the paths a tool
 * advertises in `x-luca-redacted-fields`.
 *
 * The schema must have its references inlined already. A branch schema
 * (`anyOf`, `oneOf`, `allOf`) contributes the union of its branches: a field
 * marked in one variant is still a field an agent can read, so leaving it out
 * would tell the agent a blanked field is verbatim.
 */
export function sensitivePathsInJsonSchema(
  schema: JsonValue | undefined
): readonly string[] {
  const found = MutableHashSet.empty<string>();

  walk(schema, "", found);

  return Arr.sort(found, Order.String);
}

function walk(
  schema: JsonValue | undefined,
  prefix: string,
  found: MutableHashSet.MutableHashSet<string>
): void {
  if (!isJsonObject(schema)) {
    return;
  }

  if (P.isString(schema[SENSITIVE_KEY])) {
    if (prefix) {
      MutableHashSet.add(found, prefix);
    }

    return;
  }

  Arr.forEach(["anyOf", "oneOf", "allOf"] as const, (branchKey) => {
    const branches = schema[branchKey];

    if (Array.isArray(branches)) {
      Arr.forEach(branches, (branch) => {
        walk(branch, prefix, found);
      });
    }
  });

  const properties = schema.properties;

  if (isJsonObject(properties)) {
    Arr.forEach(R.toEntries(properties), ([key, child]) => {
      walk(child, prefix ? `${prefix}.${key}` : key, found);
    });
  }

  walk(schema.items, `${prefix}[]`, found);
  walk(schema.additionalProperties, `${prefix}{}`, found);
}
