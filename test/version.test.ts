import { describe, expect, it } from "vitest";

import { LUCA_MCP_USER_AGENT, LUCA_MCP_VERSION } from "../src/version.ts";

describe("version", () => {
  it("derives the user-agent from the version constant", () => {
    expect(LUCA_MCP_USER_AGENT).toBe(`luca-mcp/${LUCA_MCP_VERSION}`);
  });

  it("is not the stale 0.1.0 release", () => {
    expect(LUCA_MCP_VERSION).not.toBe("0.1.0");
  });
});
