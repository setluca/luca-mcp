import { describe, expect, it } from "vitest";

import { inspectorArgs } from "../scripts/lib/inspector.ts";

const list = { method: "tools/list" } as const;

describe("Inspector CLI arguments", () => {
  it("names the target right after --cli, or the CLI fails", () => {
    const args = inspectorArgs(
      { kind: "stdio", apiKey: undefined },
      list,
      undefined
    );

    expect(args[0]).toBe("--cli");
    expect(args[1]).toBe("bun");
    expect(args[2]).toMatch(/dist\/index\.js$/u);
  });

  it("hands a stdio server its key with -e, because it gets no other environment", () => {
    expect(
      inspectorArgs({ kind: "stdio", apiKey: "key" }, list, undefined)
    ).toEqual(expect.arrayContaining(["-e", "LUCA_API_KEY=key"]));
    expect(
      inspectorArgs({ kind: "stdio", apiKey: undefined }, list, undefined)
    ).not.toContain("-e");
  });

  it("sends a bearer key as a header to the hosted server", () => {
    expect(
      inspectorArgs(
        { kind: "bearer", serverUrl: "https://mcp.test/mcp", token: "key" },
        list,
        undefined
      )
    ).toEqual(
      expect.arrayContaining([
        "--server-url",
        "https://mcp.test/mcp",
        "--header",
        "Authorization: Bearer key",
      ])
    );
  });

  it("reuses a stored sign-in, or refreshes it, and never asks both ways", () => {
    const signedIn = (auth: "refresh" | "stored") =>
      inspectorArgs(
        { kind: "oauth", serverUrl: "https://mcp.test/mcp", auth },
        list,
        undefined
      );

    expect(signedIn("refresh")).toContain("--use-stored-auth");
    expect(signedIn("refresh")).not.toContain("--stored-auth-only");
    expect(signedIn("stored")).toContain("--stored-auth-only");
    expect(signedIn("stored")).not.toContain("--use-stored-auth");
  });

  it("asks for a protocol era only when told to", () => {
    const connection = { kind: "stdio", apiKey: undefined } as const;

    expect(inspectorArgs(connection, list, "modern")).toEqual(
      expect.arrayContaining(["--protocol-era", "modern"])
    );
    expect(inspectorArgs(connection, list, undefined)).not.toContain(
      "--protocol-era"
    );
  });

  it("passes tool arguments through as one JSON value", () => {
    expect(
      inspectorArgs(
        { kind: "stdio", apiKey: undefined },
        { method: "tools/call", name: "luca_leads_get", args: { id: "012" } },
        undefined
      )
    ).toEqual(
      expect.arrayContaining([
        "--tool-name",
        "luca_leads_get",
        "--tool-args-json",
        '{"id":"012"}',
      ])
    );
  });
});
