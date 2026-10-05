import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { MESSAGING_CHANNELS } from "../src/fields.ts";

describe("MESSAGING_CHANNELS", () => {
  // The published package cannot depend on @luca/schemas, so it carries its
  // own list. This keeps the two from drifting.
  it("names the same channels as CHANNELS", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../contracts/channel.ts"),
      "utf-8"
    );

    const literal = source.match(
      /export const CHANNELS = \[([\s\S]*?)\] as const/
    );

    const CHANNELS = [...(literal?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(
      (match) => match[1]
    );

    expect([...MESSAGING_CHANNELS].toSorted()).toEqual(
      [...CHANNELS].toSorted()
    );
  });
});
