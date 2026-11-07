import { describe, expect, it, vi } from "vitest";

import type { InspectorOutcome } from "../scripts/lib/inspector.ts";
import type { ApiBody, Settlement } from "../scripts/sweep/plan.ts";
import {
  auditRowsOf,
  judgeAuditLog,
  judge,
  judgeSettled,
  hostedConnection,
  untilSettled,
  workspaceRefusal,
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

describe("the sweep's workspace check", () => {
  const coach = "someone@example.com";

  it("lets only the sweep account through", () => {
    expect(
      workspaceRefusal(answered({ email: "support@setluca.com" }))
    ).toBeUndefined();
    expect(workspaceRefusal(answered({ email: coach }))).toContain(
      "does not belong to support@setluca.com"
    );
  });

  it("leaves out whose account it found, because CI logs keep it", () => {
    expect(workspaceRefusal(answered({ email: coach }))).not.toContain(coach);
  });

  it("refuses when it cannot tell whose account it is", () => {
    const unreadable = "could not read which account this is";

    expect(
      workspaceRefusal({
        ...answered({ email: "support@setluca.com" }),
        exitCode: 5,
      })
    ).toContain(unreadable);
    expect(workspaceRefusal(answered({ error: "nope" }))).toContain(
      "does not belong to support@setluca.com"
    );
  });
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

describe("waiting for a sweep step's background work", () => {
  const step = {
    settles: (body: ApiBody): Settlement => {
      const answer = JSON.stringify(body);

      if (answer.includes("confirmed")) {
        return "done";
      }

      return answer.includes("pending_provider") ? "waiting" : "failed";
    },
  };

  const noWait = async () => undefined;

  it("repeats a step until its work finishes", async () => {
    const repeat = vi.fn(async () => answered({ state: "confirmed" }));

    const outcome = await untilSettled(
      step,
      repeat,
      answered({ state: "pending_provider" }),
      noWait
    );

    expect(repeat).toHaveBeenCalledTimes(1);
    expect(judgeSettled(step, outcome)).toBeUndefined();
  });

  it("fails a step whose work never finishes, after trying for a while", async () => {
    const repeat = vi.fn(async () => answered({ state: "pending_provider" }));

    const outcome = await untilSettled(
      step,
      repeat,
      answered({ state: "pending_provider" }),
      noWait
    );

    expect(repeat).toHaveBeenCalledTimes(20);
    expect(judgeSettled(step, outcome)?.note).toContain(
      "still unfinished after waiting"
    );
  });

  it("stops at once when the work ends badly, and fails the step", async () => {
    const repeat = vi.fn(async () => answered({ state: "confirmed" }));

    const outcome = await untilSettled(
      step,
      repeat,
      answered({ state: "failed" }),
      noWait
    );

    expect(repeat).not.toHaveBeenCalled();
    expect(judgeSettled(step, outcome)?.note).toContain("ended badly");
  });

  it("leaves a step with no background work alone", async () => {
    const repeat = vi.fn(async () => answered({ state: "confirmed" }));
    const first = answered({ state: "pending_provider" });

    expect(await untilSettled({}, repeat, first, noWait)).toBe(first);
    expect(repeat).not.toHaveBeenCalled();
    expect(judgeSettled({}, first)).toBeUndefined();
  });
});

describe("a step that may succeed or be refused", () => {
  const onAnyPlan = {
    kind: "okOrRefused",
    because: "a trial refuses this",
    match: /trial_campaign_cap_reached/,
  } as const;

  const answer = (exitCode: number, text: string) => ({
    exitCode,
    text,
    durationMs: 10,
    output: undefined,
    error: undefined,
  });

  it("passes on success and on the refusal it names", () => {
    expect(judge(answer(0, "{}"), onAnyPlan).verdict).toBe("pass");
    expect(
      judge(answer(5, "402 trial_campaign_cap_reached"), onAnyPlan).verdict
    ).toBe("pass");
  });

  it("fails on any other refusal, and on a server error", () => {
    expect(judge(answer(5, "403 needs_scope"), onAnyPlan).verdict).toBe("fail");
    expect(
      judge(answer(5, "500 Internal Server Error"), onAnyPlan).verdict
    ).toBe("fail");
  });
});
