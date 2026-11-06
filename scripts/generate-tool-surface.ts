/**
 * Generates `tool-surface.json` from this checkout's build, through the MCP
 * Inspector CLI. Run `bun run build` first. See `lib/tool-surface.ts`.
 */
import * as Effect from "effect/Effect";

import { writeOrCheck } from "./lib/generated-file.ts";
import type { InspectorConnection } from "./lib/inspector.ts";
import { exitWith, prettyJson, runScript, scriptMode } from "./lib/script.ts";
import { readSurface, surfaceDrift } from "./lib/tool-surface.ts";

const LOCAL_BUILD: InspectorConnection = {
  kind: "stdio",
  apiKey: undefined,
};

const program = Effect.fn("generate-tool-surface")(function* () {
  const mode = yield* scriptMode(
    "usage: generate-tool-surface.ts --write|--check"
  );

  const [legacy, modern] = yield* Effect.all(
    [readSurface(LOCAL_BUILD, "legacy"), readSurface(LOCAL_BUILD, "modern")],
    { concurrency: "unbounded" }
  );

  const disagreement = surfaceDrift(legacy, modern);

  if (disagreement.length > 0) {
    return yield* exitWith([
      "The legacy and modern protocol eras list different things:",
      ...disagreement.map((line) => `  ${line}`),
    ]);
  }

  yield* writeOrCheck({
    mode,
    target: "tool-surface.json",
    content: `${prettyJson(legacy)}\n`,
    staleMessage:
      "tool-surface.json differs from the build. Run: bun run build && bun run surface:generate, then review the diff.",
    syncMessage: "tool-surface.json matches the build, in both protocol eras.",
  });
});

runScript(program());
