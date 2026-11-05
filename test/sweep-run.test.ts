import { describe, expect, it } from "vitest";

import type { InspectorOutcome } from "../scripts/lib/inspector.ts";
import {
  auditRowsOf,
  judgeAuditLog,
  hostedConnection,
} from "../scripts/sweep/run.ts";
import type { JsonValue } from "../src/serialization.ts";

const row = { id: "row-1", action: "campaign.generate" };

const answered = (result: JsonValue): InspectorOutcome => ({
  exitCode: 0,
  durationMs: 1,
  output: { result: { structuredContent: { result } } },
  error: undefined,
  text: "",
});

describe("the sweep's read-only audit check", () => {
  it("reads the rows, an empty log, and an answer it does not understand", () => {
    expect(auditRowsOf(answered({ items: [row] }))).toEqual([row]);
    expect(auditRowsOf(answered({ items: [] }))).toEqual([]);
    expect(auditRowsOf(answered({ error: "nope" }))).toBeUndefined();
    expect(
      auditRowsOf({ ...answered({ items: [row] }), exitCode: 5 })
    ).toBeUndefined();
  });

  it("passes when the newest row did not change", () => {
    expect(judgeAuditLog([row], [row]).verdict).toBe("pass");
    expect(judgeAuditLog([], []).verdict).toBe("pass");
  });

  it("fails and names the action when a read-only tool wrote a row", () => {
    // What this tool did before it was fixed: a read that wrote an audit row.
    const result = judgeAuditLog([], [row]);

    expect(result.verdict).toBe("fail");
    expect(result.note).toContain("campaign.generate");
  });

  it("fails rather than passes when it could not read the log", () => {
    expect(judgeAuditLog(undefined, [row]).verdict).toBe("fail");
    expect(judgeAuditLog([row], undefined).verdict).toBe("fail");
  });
});

describe("how a sweep reaches the hosted server", () => {
  const serverUrl = "https://mcp.setluca.com/mcp";

  it("uses the stored sign-in without a key", () => {
    const stored = { kind: "oauth", serverUrl, auth: "refresh" };

    expect(hostedConnection(serverUrl, undefined)).toEqual(stored);
    expect(hostedConnection(serverUrl, "")).toEqual(stored);
  });

  it("sends a key when there is one", () => {
    expect(hostedConnection(serverUrl, "key")).toEqual({
      kind: "bearer",
      serverUrl,
      token: "key",
    });
  });
});
