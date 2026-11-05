import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect, it } from "vitest";

import { runWithPlatform } from "./platform.ts";

/**
 * The event union is a contract, not a wish list. A name declared here and
 * emitted nowhere reads like a signal a dashboard can filter on, and there is
 * no such signal. `mcp.explain` sat dead in this union for two releases.
 */
const sources = await runWithPlatform(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const src = path.resolve(import.meta.dirname, "../src");

    const mirror = path.resolve(
      import.meta.dirname,
      "../contracts/agent-surface-log.ts"
    );

    // Every `.ts` file under `src`, generated code included.
    const files = Arr.filter(
      yield* fs.readDirectory(src, { recursive: true }),
      (name) => name.endsWith(".ts")
    );

    return {
      local: yield* fs.readFileString(path.join(src, "observability.ts")),
      mirror: yield* fs.readFileString(mirror),
      src: yield* Effect.forEach(
        files,
        (name) => fs.readFileString(path.join(src, name)),
        { concurrency: "unbounded" }
      ),
    };
  })
);

describe("AgentSurfaceEvent declarations", () => {
  /** The string literals in the source's `AgentSurfaceEvent` union, in order. */
  function declaredEvents(source: string): string[] {
    const union = source.slice(
      source.indexOf("export type AgentSurfaceEvent"),
      source.indexOf(";", source.indexOf("export type AgentSurfaceEvent"))
    );

    return [...union.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
  }

  const events = declaredEvents(sources.local);

  const emitted = Arr.dedupe(
    sources.src.flatMap((source) =>
      [...source.matchAll(/logAgentSurfaceEvent\(\s*"([^"]+)"/g)].map(
        (match) => match[1] ?? ""
      )
    )
  );

  it("declares the seven events the server emits", () => {
    expect(events).toEqual([
      "mcp.tool.called",
      "mcp.prompts.get",
      "mcp.resources.read",
      "mcp.explain",
      "mcp.write_gate.rejected",
      "mcp.pagination.truncated",
      "mcp.token_verification_unavailable",
    ]);
  });

  it.each(declaredEvents(sources.local))(
    "emits %s from somewhere in src",
    (event) => {
      expect(Arr.contains(emitted, event)).toBe(true);
    }
  );

  it("emits nothing it has not declared", () => {
    expect(emitted.filter((event) => !events.includes(event))).toEqual([]);
  });

  it("keeps the local mirror and @luca/observability in lockstep", () => {
    // This package builds with plain tsc and ships as a self-contained npm
    // tarball, so it cannot import the workspace package. Nothing but this
    // assertion stops the two copies from drifting.
    expect(declaredEvents(sources.mirror)).toEqual(events);
  });
});
