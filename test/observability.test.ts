import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  logAgentSurfaceEvent,
  setEventSink,
  stdoutEventSink,
} from "../src/observability.ts";
import { JsonValue } from "../src/serialization.ts";

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
