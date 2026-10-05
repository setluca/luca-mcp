import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  logAgentSurfaceEvent,
  setEventSink,
  stdoutEventSink,
} from "../src/observability.ts";
import { JsonValue } from "../src/serialization.ts";
import { runWithPlatform } from "./platform.ts";

const decodeLoggedEvent = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, JsonValue))
);

describe("logAgentSurfaceEvent", () => {
  afterEach(() => {
    setEventSink(stdoutEventSink);
    vi.restoreAllMocks();
  });

  it("writes to the sink it was given instead of stdout", () => {
    // The stdio entry swaps in a stderr sink, because stdout carries the MCP
    // protocol there and a stray log line corrupts the stream.
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const lines: string[] = [];

    setEventSink((line) => {
      lines.push(line);
    });
    logAgentSurfaceEvent("mcp.tool.called", { tool: "luca_leads_list" });

    expect(stdout).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
    expect(decodeLoggedEvent(lines[0]).tool).toBe("luca_leads_list");
  });

  it("logs a structured line with the fixed msg field and drops undefined fields", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    logAgentSurfaceEvent("mcp.prompts.get", {
      a: "x",
      skip: undefined,
      n: 0,
      b: false,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const [line] = spy.mock.calls[0] as [string];
    const parsed = decodeLoggedEvent(line);

    expect(parsed.msg).toBe("mcp.agent_surface");
    expect(parsed.event).toBe("mcp.prompts.get");
    expect(parsed.a).toBe("x");
    expect(parsed.n).toBe(0);
    expect(parsed.b).toBe(false);
    expect("skip" in parsed).toBe(false);
  });

  it("keeps a defined field of every allowed type present", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    logAgentSurfaceEvent("mcp.tool.called", {
      present: "value",
      count: 3,
      truncated: true,
      missing: undefined,
      nullable: null,
    });

    const [line] = spy.mock.calls[0] as [string];
    const parsed = decodeLoggedEvent(line);

    expect("present" in parsed).toBe(true);
    expect(parsed.present).toBe("value");
    expect("count" in parsed).toBe(true);
    expect("truncated" in parsed).toBe(true);
    expect("nullable" in parsed).toBe(true);
    expect(parsed.nullable).toBeNull();
    expect("missing" in parsed).toBe(false);
  });
});

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
