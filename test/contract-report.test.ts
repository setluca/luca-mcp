import { describe, expect, it } from "vitest";

import {
  changesReport,
  contractChanges,
  hasChanges,
} from "../scripts/contract-report.ts";
import type { JsonObject } from "../src/serialization.ts";

const policy = (overrides: JsonObject = {}): JsonObject => ({
  id: "channels.set_ai_dm_auto_send",
  method: "PATCH",
  path: "/api/channels/{id}/auto-send",
  scopes: ["channels:write"],
  requireIdempotency: true,
  ...overrides,
});

const openApi = (operation: JsonObject, schemas: JsonObject = {}) => ({
  paths: { "/api/channels/{id}/auto-send": { patch: operation } },
  components: { schemas },
});

const operation = (overrides: JsonObject = {}): JsonObject => ({
  description:
    "Turning this switch on also turns the master on.\n\n**API key scopes:** `channels:write`.",
  parameters: [{ name: "id", in: "path" }],
  responses: { "200": { description: "ok" } },
  ...overrides,
});

const contract = (
  operationOverrides: JsonObject = {},
  policies: readonly JsonObject[] = [policy()],
  schemas: JsonObject = {}
) => ({
  openApi: openApi(operation(operationOverrides), schemas),
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
          "An API key changes only this account and leaves the master as it was.\n\n**API key scopes:** `channels:write`.",
      })
    );

    expect(changes.text).toHaveLength(1);
    expect(changes.input).toEqual([]);

    const report = changesReport(changes);

    expect(report).toContain("`luca_channels_set_ai_dm_auto_send`");
    expect(report).toContain(
      "Before: Turning this switch on also turns the master on."
    );
    expect(report).toContain("After: An API key changes only this account");
    expect(report).not.toContain("API key scopes");
  });

  it("does not call a scope change a text change", () => {
    const changes = contractChanges(
      contract(),
      contract(
        {
          description:
            "Turning this switch on also turns the master on.\n\n**API key scopes:** `channels:read`.",
        },
        [policy({ scopes: ["channels:read"], requireIdempotency: false })]
      )
    );

    expect(changes.text).toEqual([]);
    expect(changes.access.map(({ id }) => id)).toEqual([
      "channels.set_ai_dm_auto_send",
    ]);
  });

  it("lists routes added and removed from the allowlist", () => {
    const changes = contractChanges(
      contract(),
      contract({}, [policy({ id: "broadcasts.resume" })])
    );

    expect(changes.removed.map(({ id }) => id)).toEqual([
      "channels.set_ai_dm_auto_send",
    ]);
    expect(changes.added.map(({ id }) => id)).toEqual(["broadcasts.resume"]);
  });

  it("follows a schema reference to notice an output change", () => {
    const responses = {
      "200": { $ref: "#/components/schemas/Result" },
    };

    const changes = contractChanges(
      contract({ responses }, [policy()], { Result: { type: "object" } }),
      contract({ responses }, [policy()], { Result: { type: "array" } })
    );

    expect(changes.output.map(({ id }) => id)).toEqual([
      "channels.set_ai_dm_auto_send",
    ]);
    expect(changes.input).toEqual([]);
  });

  it("survives a schema that refers to itself", () => {
    const responses = { "200": { $ref: "#/components/schemas/Node" } };

    const schemas = {
      Node: { properties: { next: { $ref: "#/components/schemas/Node" } } },
    };

    expect(
      hasChanges(
        contractChanges(
          contract({ responses }, [policy()], schemas),
          contract({ responses }, [policy()], schemas)
        )
      )
    ).toBe(false);
  });

  it("ignores a route no tool calls", () => {
    const before = contract();

    expect(
      hasChanges(
        contractChanges(before, {
          ...before,
          openApi: {
            ...before.openApi,
            paths: {
              ...before.openApi.paths,
              "/api/internal": { get: { description: "New." } },
            },
          },
        })
      )
    ).toBe(false);
  });
});
