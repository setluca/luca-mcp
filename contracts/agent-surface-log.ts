import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import { encodeJson } from "./json";

export type AgentSurfaceEvent =
  | "mcp.tool.called"
  | "mcp.prompts.get"
  | "mcp.resources.read"
  | "mcp.explain"
  | "mcp.write_gate.rejected"
  | "mcp.pagination.truncated"
  | "mcp.token_verification_unavailable";

/**
 * One structured line per agent-surface event. PII-safe by contract: pass only
 * names, booleans, counts, and already-coach-scoped ids — never message text,
 * guidance text, or reasoning strings.
 */
export function logAgentSurfaceEvent(
  event: AgentSurfaceEvent,
  fields: Record<string, string | number | boolean | null | undefined>
): void {
  Effect.runSync(
    Console.log(encodeJson({ msg: "mcp.agent_surface", event, ...fields }))
  );
}
