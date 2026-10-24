import * as Arr from "effect/Array";
import { describe, expect, it } from "vitest";

import { LUCA_OPERATIONS } from "../src/operations.ts";
import { LUCA_TASK_TOOLS } from "../src/task-tools.ts";
import { toolProfile } from "../src/tool-profile.ts";
import {
  CLAUDE_TOOL_NAMES,
  sessionTools,
  type ToolSession,
} from "../src/toolsets.ts";
import { sorted } from "./helpers.ts";

function listedNames(session: ToolSession) {
  return sessionTools(session).map((source) => toolProfile(source).name);
}

describe("sessionTools", () => {
  it("lists every operation, then every task tool, in catalog order", () => {
    expect(listedNames({ toolset: "full" })).toEqual([
      ...LUCA_OPERATIONS.map((operation) => operation.toolName),
      ...LUCA_TASK_TOOLS.map((tool) => tool.name),
    ]);
  });

  it("lists the whole claude allowlist for a session with no grant", () => {
    expect(sorted(listedNames({ toolset: "claude" }))).toEqual(
      sorted(CLAUDE_TOOL_NAMES)
    );
  });

  it("drops the claude tools a read grant does not reach", () => {
    const listed = sessionTools({ toolset: "claude", grant: "luca:read" });

    Arr.forEach(listed, (source) => {
      expect(toolProfile(source).oauthScope).toBe("luca:read");
    });

    const names = listed.map((source) => toolProfile(source).name);

    expect(names).toContain("luca_leads_list");
    // Adding a note needs luca:draft.
    expect(names).not.toContain("luca_leads_notes_add");
  });

  it("ignores the grant outside the claude toolset", () => {
    Arr.forEach(["full", "tasks"] as const, (toolset) => {
      expect(listedNames({ toolset, grant: "luca:read" })).toEqual(
        listedNames({ toolset })
      );
    });
  });
});
