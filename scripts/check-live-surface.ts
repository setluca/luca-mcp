/**
 * Fails when the hosted server lists something other than a release's
 * `tool-surface.json`. See `lib/tool-surface.ts`.
 */
import { parseArgs } from "node:util";

import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import { parseJson } from "../src/serialization.ts";
import { packagePath } from "./lib/generated-file.ts";
import { exitWith, runScript } from "./lib/script.ts";
import { driftAcrossEras } from "./lib/tool-surface.ts";

/** A deploy can take a moment to reach every edge, so a miss is tried again. */
const RETRIES = 2;

const RETRY_EVERY = "1 minute";

class SurfaceDrifted extends Schema.TaggedError<
  SurfaceDrifted,
  { readonly brand: unique symbol }
>()("SurfaceDrifted", {
  message: Schema.String,
  lines: Schema.Array(Schema.String),
}) {}

const program = Effect.fn("check-live-surface")(function* () {
  const { values } = parseArgs({
    options: {
      expected: { type: "string" },
      "server-url": { type: "string", default: "https://mcp.setluca.com/mcp" },
    },
  });

  const token = process.env.LUCA_MCP_LIVE_KEY;

  if (token === undefined || token === "") {
    return yield* exitWith(["LUCA_MCP_LIVE_KEY is not set."]);
  }

  const fs = yield* FileSystem.FileSystem;

  const expected = yield* parseJson(
    yield* fs.readFileString(
      values.expected ?? (yield* packagePath("tool-surface.json"))
    )
  );

  const serverUrl = values["server-url"];

  yield* driftAcrossEras({ kind: "bearer", serverUrl, token }, expected).pipe(
    Effect.filterOrFail(
      (lines) => lines.length === 0,
      (lines) =>
        new SurfaceDrifted({
          message: `${lines.length} difference(s)`,
          lines,
        })
    ),
    Effect.tapError((error) =>
      Console.log(`Live check missed, trying again: ${error.message}`)
    ),
    Effect.retry({ schedule: Schedule.spaced(RETRY_EVERY), times: RETRIES }),
    Effect.catchTag("SurfaceDrifted", ({ message, lines }) =>
      exitWith([
        `${serverUrl} has drifted, ${message}:`,
        ...lines.map((line) => `  ${line}`),
      ])
    )
  );

  yield* Console.log(`${serverUrl} matches, in both protocol eras.`);
});

runScript(program());
