import { describe, expect, it } from "vitest";

import {
  auditHeadOf,
  judgeAuditHead,
  sweepSignIn,
} from "../scripts/sweep/run.ts";

const row = { id: "row-1", action: "campaign.generate" };

describe("the sweep's read-only audit check", () => {
  it("reads the newest row, an empty log, and an answer it does not know", () => {
    expect(auditHeadOf({ items: [row] })).toEqual(row);
    expect(auditHeadOf({ items: [] })).toBe("none");
    expect(auditHeadOf({ error: "nope" })).toBeUndefined();
    expect(auditHeadOf(undefined)).toBeUndefined();
  });

  it("passes when the newest row did not change", () => {
    expect(judgeAuditHead(row, row).verdict).toBe("pass");
    expect(judgeAuditHead("none", "none").verdict).toBe("pass");
  });

  it("fails and names the action when a read-only tool wrote a row", () => {
    // What this tool did before it was fixed: a read that wrote an audit row.
    const result = judgeAuditHead("none", row);

    expect(result.verdict).toBe("fail");
    expect(result.note).toContain("campaign.generate");
  });

  it("fails rather than passes when it could not read the log", () => {
    expect(judgeAuditHead(undefined, row).verdict).toBe("fail");
    expect(judgeAuditHead(row, undefined).verdict).toBe("fail");
  });
});

describe("how a sweep signs in", () => {
  const serverUrl = "https://mcp.setluca.com/mcp";

  it("uses the stored sign-in without a key", () => {
    expect(sweepSignIn({ serverUrl, stdio: false, apiKey: undefined })).toEqual(
      { kind: "stored-oauth", serverUrl }
    );
    expect(sweepSignIn({ serverUrl, stdio: false, apiKey: "" }).kind).toBe(
      "stored-oauth"
    );
  });

  it("sends a key to the hosted server", () => {
    expect(sweepSignIn({ serverUrl, stdio: false, apiKey: "key" })).toEqual({
      kind: "key",
      connection: { kind: "bearer", serverUrl, token: "key" },
    });
  });

  it("gives a key to the local build", () => {
    expect(sweepSignIn({ serverUrl, stdio: true, apiKey: "key" })).toEqual({
      kind: "key",
      connection: { kind: "stdio", env: { LUCA_API_KEY: "key" } },
    });
  });

  it("refuses a local sweep with no key, since nothing could sign in", () => {
    expect(() =>
      sweepSignIn({ serverUrl, stdio: true, apiKey: undefined })
    ).toThrow("LUCA_SWEEP_API_KEY");
  });
});
