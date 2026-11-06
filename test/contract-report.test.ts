import { describe, expect, it } from "vitest";

import {
  changesReport,
  contractChanges,
  hasChanges,
} from "../scripts/contract-report.ts";
import type { ApiKeyPolicyEntry } from "../scripts/load-openapi.ts";
import type { JsonObject } from "../src/serialization.ts";

const policy: ApiKeyPolicyEntry = {
  id: "channels.set_ai_dm_auto_send",
  method: "PATCH",
  path: "/api/channels/{id}/auto-send",
  scopes: ["channels:write"],
  requireIdempotency: true,
};

const OLD_TEXT = "Turning this switch on also turns the master on.";

const operation = (overrides: JsonObject = {}): JsonObject => ({
  description: `${OLD_TEXT}\n\n**API key scopes:** \`channels:write\`.`,
  parameters: [{ name: "id", in: "path" }],
  responses: { "200": { description: "ok" } },
  ...overrides,
});

const contract = (
  overrides: JsonObject = {},
  policies: readonly ApiKeyPolicyEntry[] = [policy],
  schemas: JsonObject = {}
) => ({
  spec: {
    paths: { [policy.path]: { patch: operation(overrides) } },
    components: { schemas },
  },
  policies,
});

describe("contract report", () => {
  it("says so when no route a tool calls changed", () => {
    const changes = contractChanges(contract(), contract());

    expect(hasChanges(changes)).toBe(false);
    expect(changesReport(changes)).toContain("only moves the pin");
  });

  it("flags a route whose description changed, with both versions", () => {
    // The real case: the schema did not move, and only this sentence said the
    // tool's description had gone stale.
    const changes = contractChanges(
      contract(),
      contract({
        description:
          "An API key changes only this account.\n\n**API key scopes:** `channels:write`.",
      })
    );

    expect(changes.text).toHaveLength(1);
    expect(changes.input).toEqual([]);

    const report = changesReport(changes);

    expect(report).toContain("`luca_channels_set_ai_dm_auto_send`");
    expect(report).toContain(`Before: ${OLD_TEXT}`);
    expect(report).toContain("After: An API key changes only this account.");
    expect(report).not.toContain("API key scopes");
  });

  it("does not call a scope change a text change", () => {
    const changes = contractChanges(
      contract(),
      contract(
        {
          description: `${OLD_TEXT}\n\n**API key scopes:** \`channels:read\`.`,
        },
        [{ ...policy, scopes: ["channels:read"] }]
      )
    );

    expect(changes.text).toEqual([]);
    expect(changes.access.map(({ id }) => id)).toEqual([policy.id]);
  });

  it("treats a route that stops requiring idempotency as an access change", () => {
    const { requireIdempotency: _dropped, ...withoutKey } = policy;

    expect(
      contractChanges(contract(), contract({}, [withoutKey])).access
    ).toHaveLength(1);
  });

  it("lists routes added and removed from the allowlist", () => {
    const changes = contractChanges(
      contract(),
      contract({}, [{ ...policy, id: "broadcasts.resume" }])
    );

    expect(changes.removed.map(({ id }) => id)).toEqual([policy.id]);
    expect(changes.added.map(({ id }) => id)).toEqual(["broadcasts.resume"]);
  });

  it("follows a schema reference to notice an output change", () => {
    const responses = {
      "200": {
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/Result" },
          },
        },
      },
    };

    const changes = contractChanges(
      contract({ responses }, [policy], { Result: { type: "object" } }),
      contract({ responses }, [policy], { Result: { type: "array" } })
    );

    expect(changes.output.map(({ id }) => id)).toEqual([policy.id]);
    expect(changes.input).toEqual([]);
  });

  it("notices a new query parameter as an input change", () => {
    const changes = contractChanges(
      contract(),
      contract({
        parameters: [
          { name: "id", in: "path" },
          { name: "status", in: "query" },
        ],
      })
    );

    expect(changes.input.map(({ id }) => id)).toEqual([policy.id]);
    expect(changes.output).toEqual([]);
  });

  it("ignores a route no tool calls", () => {
    const before = contract();

    expect(
      hasChanges(
        contractChanges(before, {
          ...before,
          spec: {
            ...before.spec,
            paths: {
              ...before.spec.paths,
              "/api/internal": { get: { description: "New." } },
            },
          },
        })
      )
    ).toBe(false);
  });
});
