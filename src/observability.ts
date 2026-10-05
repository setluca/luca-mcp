import * as P from "effect/Predicate";
import * as R from "effect/Record";

import { toJsonPayload } from "./serialization.ts";

export type AgentSurfaceEvent =
  | "mcp.tool.called"
  | "mcp.prompts.get"
  | "mcp.resources.read"
  | "mcp.explain"
  | "mcp.write_gate.rejected"
  | "mcp.pagination.truncated"
  | "mcp.token_verification_unavailable";

/** Where event lines go. One JSON line per call. */
export type EventSink = (line: string) => void;

/**
 * Writes one line to stdout or stderr. Event lines are emitted from plain
 * callbacks as well as from Effect programs, so this is the one place the
 * package touches the console directly.
 */
function writeLine(stream: "log" | "error", line: string): void {
  console[stream](line);
}

/** The Worker's sink: stdout is the platform log there. */
export const stdoutEventSink: EventSink = (line) => writeLine("log", line);

/** The stdio sink: stdout carries the MCP protocol there, so lines go to stderr. */
export const stderrEventSink: EventSink = (line) => writeLine("error", line);

let sink = stdoutEventSink;

/**
 * Sends event lines somewhere other than stdout. The stdio entry calls this
 * with a stderr writer before it starts serving, because stdout carries the
 * MCP protocol there and a log line on it corrupts the stream. The Worker
 * keeps the default, where stdout is the platform log.
 */
export function setEventSink(next: EventSink): void {
  sink = next;
}

/**
 * One structured line per agent-surface event. PII-safe by contract: pass only
 * names, booleans, counts, and already-coach-scoped ids. Never message text,
 * guidance text, or reasoning strings.
 *
 * A local mirror of `@luca/observability`'s `logAgentSurfaceEvent`: this package
 * builds with plain `tsc` and ships to npm as a self-contained stdio tarball, so
 * it cannot import the private workspace package. The two definitions share one
 * contract (event names + payload shape).
 */
export function logAgentSurfaceEvent(
  event: AgentSurfaceEvent,
  fields: Record<string, string | number | boolean | null | undefined>
): void {
  sink(
    toJsonPayload({
      msg: "mcp.agent_surface",
      event,
      ...R.filter(fields, P.isNotUndefined),
    })
  );
}
