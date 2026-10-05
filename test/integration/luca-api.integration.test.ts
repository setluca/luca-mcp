import * as Effect from "effect/Effect";
import { assert, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.ts";
import { createLucaApi } from "../../src/http.ts";
import { LUCA_OPERATIONS, type LucaOperation } from "../../src/operations.ts";

const RUN_LIVE = process.env.LUCA_INTEGRATION === "1";

const RUN_WRITES = process.env.LUCA_INTEGRATION_WRITE === "1";

function operation(id: string): LucaOperation {
  const found = LUCA_OPERATIONS.find((item) => item.id === id);

  assert(found, `Missing operation: ${id}`);

  return found;
}

function liveApi() {
  return createLucaApi(Effect.runSync(loadConfig(process.env)));
}

describe.skipIf(!RUN_LIVE)("Luca API integration", () => {
  it("reads public API capabilities with the configured key", async () => {
    const result = await Effect.runPromise(
      liveApi().request({ operation: operation("capabilities.get") })
    );

    expect(result).toEqual(
      expect.objectContaining({
        apiBasePath: "/api",
        boundary: expect.objectContaining({
          internalEndpointsAllowed: false,
          databaseAccessAllowed: false,
        }),
      })
    );
  });

  it("lists leads with a minimal read-only query", async () => {
    const result = await Effect.runPromise(
      liveApi().request({
        operation: operation("leads.list"),
        query: { limit: 1 },
      })
    );

    expect(result).toEqual(
      expect.objectContaining({
        leads: expect.any(Array),
      })
    );
  });
});

describe.skipIf(!(RUN_LIVE && RUN_WRITES))("Luca API write integration", () => {
  it("upserts a deterministic test lead with an idempotency key", async () => {
    const channel = process.env.LUCA_INTEGRATION_LEAD_CHANNEL ?? "telegram";

    const externalUserId =
      process.env.LUCA_INTEGRATION_LEAD_EXTERNAL_ID ?? "mcp-integration-smoke";

    const result = await Effect.runPromise(
      liveApi().request({
        operation: operation("leads.create"),
        idempotencyKey: `mcp-integration-lead-${channel}-${externalUserId}`,
        body: {
          channel,
          externalUserId,
          displayName: "MCP Integration Smoke",
          tags: ["mcp-integration"],
        },
      })
    );

    expect(result).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        lead: expect.objectContaining({
          channel,
          externalUserId,
        }),
      })
    );
  });
});
