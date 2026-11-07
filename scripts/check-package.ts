/**
 * Checks an installed copy of the package the way a user runs it: starts its
 * `luca-mcp` bin, which runs under the Node on PATH, with no API key. Listing has to
 * work, and the first tool call has to say the key is missing. This script itself
 * runs under Bun, so it needs nothing the Node being tested may lack.
 */
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { LUCA_OPERATIONS } from "../src/operations.ts";
import { LUCA_TASK_TOOLS } from "../src/task-tools.ts";
import { LUCA_MCP_VERSION } from "../src/version.ts";

const bin = process.argv[2];

if (bin === undefined) {
  throw new Error(
    "Usage: bun scripts/check-package.ts <path to the luca-mcp bin>"
  );
}

const transport = new StdioClientTransport({ command: bin, stderr: "pipe" });

const client = new Client({ name: "luca-mcp-package-check", version: "0.1.0" });

await client.connect(transport);

const version = client.getServerVersion()?.version;

if (version !== LUCA_MCP_VERSION) {
  throw new Error(`Expected version ${LUCA_MCP_VERSION}, got ${version}`);
}

const { tools } = await client.listTools();

const expectedTools = LUCA_OPERATIONS.length + LUCA_TASK_TOOLS.length;

if (tools.length !== expectedTools) {
  throw new Error(`Expected ${expectedTools} tools, got ${tools.length}`);
}

const call = await client.callTool({
  name: "luca_capabilities_get",
  arguments: {},
});

if (!call.isError || !JSON.stringify(call.content).includes("LUCA_API_KEY")) {
  throw new Error(
    `A call with no key should name LUCA_API_KEY, got ${JSON.stringify(call.content)}`
  );
}

await transport.close();

console.log(
  `The installed package runs: ${tools.length} tools, version ${version}.`
);
