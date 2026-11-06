import { describe, expect, it } from "vitest";

import {
  surfaceDrift,
  type SurfaceListings,
  surfaceOf,
} from "../scripts/lib/tool-surface.ts";

const annotations = {
  title: "Generate a campaign plan",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const generate = {
  name: "luca_campaigns_generate",
  title: "Generate a campaign plan",
  description: "Nothing is created.",
  annotations,
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  _meta: { securitySchemes: [] },
};

const listings = (
  tools: SurfaceListings["tools"]["tools"] = [generate]
): SurfaceListings => ({
  initialize: {
    serverInfo: { name: "luca-mcp", version: "1.0.0" },
    capabilities: { completions: {}, tools: { listChanged: true } },
    instructions: "Start with the review queue.",
  },
  tools: { tools },
  prompts: {
    prompts: [
      { name: "b", title: "B", description: "Second." },
      { name: "a", title: "A", description: "First." },
    ],
  },
  resources: {
    resources: [
      {
        uri: "luca://operations",
        name: "operations",
        title: "Operations",
        description: "The manifest.",
        mimeType: "application/json",
      },
    ],
  },
  resourceTemplates: { resourceTemplates: [] },
});

describe("tool surface", () => {
  it("keeps hints and text readable and hashes the schemas", () => {
    expect(surfaceOf(listings()).tools).toEqual({
      luca_campaigns_generate: {
        title: "Generate a campaign plan",
        description: "Nothing is created.",
        annotations,
        inputSchema: expect.stringMatching(/^[0-9a-f]{16}$/u),
        outputSchema: expect.stringMatching(/^[0-9a-f]{16}$/u),
        meta: expect.stringMatching(/^[0-9a-f]{16}$/u),
      },
    });
  });

  it("does not care what order a server lists things in", () => {
    expect(Object.keys(surfaceOf(listings()).prompts)).toEqual(["a", "b"]);
  });

  it("names a flipped hint, a reworded tool, and a changed schema", () => {
    const drift = surfaceDrift(
      surfaceOf(listings()),
      surfaceOf(
        listings([
          {
            ...generate,
            description: "Something is created.",
            inputSchema: { type: "object", properties: { a: {} } },
            annotations: { ...annotations, readOnlyHint: false },
          },
        ])
      )
    );

    expect(drift).toHaveLength(3);
    expect(drift).toContain(
      "tools > luca_campaigns_generate > annotations > readOnlyHint: expected true, server has false"
    );
    expect(drift).toContain(
      'tools > luca_campaigns_generate > description: expected "Nothing is created.", server has "Something is created."'
    );
    expect(drift.join("\n")).toContain("inputSchema: expected");
  });

  it("names a tool the server dropped and one it added", () => {
    const drift = surfaceDrift(
      surfaceOf(listings()),
      surfaceOf(listings([{ ...generate, name: "luca_broadcasts_resume" }]))
    ).join("\n");

    expect(drift).toContain(
      'tools > luca_campaigns_generate > title: expected "Generate a campaign plan", server has none'
    );
    expect(drift).toContain(
      'tools > luca_broadcasts_resume > title: expected none, server has "Generate a campaign plan"'
    );
  });

  it("notices a capability dropped, even one declared as an empty object", () => {
    const surface = surfaceOf(listings());

    expect(
      surfaceDrift(surface, {
        ...surface,
        server: {
          ...surface.server,
          capabilities: { tools: { listChanged: true } },
        },
      })
    ).toEqual([
      "server > capabilities > completions: expected {}, server has none",
    ]);
  });

  it("cuts a long value short", () => {
    const [line = ""] = surfaceDrift(
      { description: "a".repeat(500) },
      { description: "b" }
    );

    expect(line.length).toBeLessThan(220);
    expect(line).toContain('..., server has "b"');
  });
});
