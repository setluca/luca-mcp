import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import * as Schema from "effect/Schema";
import { assert, describe, expect, it, onTestFinished } from "vitest";

import { LUCA_OPERATIONS } from "../src/operations.ts";
import { LUCA_TASK_TOOLS } from "../src/task-tools.ts";

const decodeManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ operations: Schema.Array(Schema.Unknown) })
  )
);

describe("built stdio server", () => {
  it("starts and exposes tools, resources, and prompts", async () => {
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["dist/index.js"],
      cwd: process.cwd(),
      stderr: "pipe",
      env: {
        LUCA_API_KEY: "luca_test_stdio_smoke",
      },
    });

    const client = new Client({
      name: "luca-mcp-stdio-smoke",
      version: "0.1.0",
    });

    onTestFinished(() => transport.close());

    await client.connect(transport);

    const [tools, resources, prompts, manifestResource] = await Promise.all([
      client.listTools(),
      client.listResources(),
      client.listPrompts(),
      client.readResource({ uri: "luca://operations" }),
    ]);

    // This runs against dist/, not src/. A tool count that trails the
    // catalog means the bundle predates the last catalog edit, so say that
    // rather than leaving a bare number mismatch.
    expect(
      tools.tools,
      "dist/index.js is stale — run `bun run build` before this test"
    ).toHaveLength(LUCA_OPERATIONS.length + LUCA_TASK_TOOLS.length);
    expect(resources.resources.map((resource) => resource.uri)).toContain(
      "luca://operations"
    );
    expect(prompts.prompts.map((prompt) => prompt.name)).toContain(
      "luca-api-planner"
    );

    const manifestContent = manifestResource.contents[0];

    assert(
      manifestContent && "text" in manifestContent,
      "Expected text manifest content"
    );

    const manifest = decodeManifest(manifestContent.text);

    expect(
      manifest.operations,
      "dist/index.js is stale — run `bun run build` before this test"
    ).toHaveLength(LUCA_OPERATIONS.length);
  });
});
