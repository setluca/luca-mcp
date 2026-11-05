import { describe, expect, it } from "vitest";

import { surfaceDrift, surfaceFromListings } from "../scripts/tool-surface.ts";
import type { JsonObject } from "../src/serialization.ts";

const annotations = {
  title: "Generate a campaign plan",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const tool = (overrides: JsonObject = {}): JsonObject => ({
  name: "luca_campaigns_generate",
  title: "Generate a campaign plan",
  description: "Nothing is created.",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  annotations,
  ...overrides,
});

const listings = (tools: readonly JsonObject[]) => ({
  initialize: {
    protocolVersion: "2026-07-28",
    serverInfo: { name: "luca-mcp", version: "1.0.0" },
    capabilities: { tools: {} },
    instructions: "Start with the review queue.",
  },
  tools: { tools },
  prompts: { prompts: [{ name: "b" }, { name: "a" }] },
  resources: {
    resources: [{ uri: "luca://operations", name: "Operations" }],
  },
  resourceTemplates: { resourceTemplates: [] },
});

describe("tool surface", () => {
  it("reads the same surface in either protocol era", () => {
    const legacy = surfaceFromListings(listings([tool()]));

    const modern = surfaceFromListings({
      ...listings([tool()]),
      initialize: {
        protocolVersion: "2025-11-25",
        serverInfo: { name: "luca-mcp", version: "1.0.0" },
        capabilities: { tools: {} },
        instructions: "Start with the review queue.",
      },
    });

    expect(surfaceDrift(legacy, modern)).toEqual([]);
  });

  it("keeps hints and text readable and hashes the schemas", () => {
    const { tools } = surfaceFromListings(listings([tool()]));

    expect(tools).toEqual({
      luca_campaigns_generate: {
        title: "Generate a campaign plan",
        description: "Nothing is created.",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        inputSchema: expect.stringMatching(/^[0-9a-f]{16}$/u),
        outputSchema: expect.stringMatching(/^[0-9a-f]{16}$/u),
        meta: null,
      },
    });
  });

  it("does not care what order a server lists things or keys its schemas in", () => {
    const shuffled = surfaceFromListings(
      listings([
        tool({
          inputSchema: { properties: {}, type: "object" },
        }),
      ])
    );

    const sorted = surfaceFromListings(
      listings([
        tool({
          inputSchema: { type: "object", properties: {} },
        }),
      ])
    );

    expect(surfaceDrift(shuffled, sorted)).toEqual([]);
  });

  it("names a flipped hint, a reworded tool, and a changed schema", () => {
    const expected = surfaceFromListings(listings([tool()]));

    const actual = surfaceFromListings(
      listings([
        tool({
          description: "Something is created.",
          inputSchema: { type: "object", properties: { a: {} } },
          annotations: { ...annotations, readOnlyHint: false },
        }),
      ])
    );

    const drift = surfaceDrift(expected, actual);

    expect(drift).toHaveLength(3);
    expect(drift).toContain(
      "tools > luca_campaigns_generate > readOnlyHint: expected true, server has false"
    );
    expect(drift.join("\n")).toContain(
      'description: expected "Nothing is created.", server has "Something is created."'
    );
    expect(drift.join("\n")).toContain("inputSchema: expected");
  });

  it("names a tool the server dropped and one it added", () => {
    const expected = surfaceFromListings(listings([tool()]));

    const actual = surfaceFromListings(
      listings([tool({ name: "luca_broadcasts_resume" })])
    );

    const drift = surfaceDrift(expected, actual).join("\n");

    expect(drift).toContain(
      "tools > luca_campaigns_generate > title: expected"
    );
    expect(drift).toContain("server has none");
    expect(drift).toContain(
      "tools > luca_broadcasts_resume > title: not expected"
    );
  });

  it("names a changed server version and instructions", () => {
    const expected = surfaceFromListings(listings([]));

    const drift = surfaceDrift(expected, {
      ...expected,
      server: {
        capabilities: { tools: {} },
        instructions: "Something else.",
        serverInfo: { name: "luca-mcp", version: "2.0.0" },
      },
    }).join("\n");

    expect(drift).toContain(
      'server > serverInfo > version: expected "1.0.0", server has "2.0.0"'
    );
    expect(drift).toContain("server > instructions: expected");
  });
});
