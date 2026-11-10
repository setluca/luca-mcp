import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  checkPluginManifests,
  checkRegistry,
  PLUGIN_MANIFESTS,
  READ_ENVIRONMENT_VARIABLES,
  type PackageJson,
  type PluginManifest,
  type RegistryCheckInputs,
  type ServerJson,
} from "../scripts/check-registry.ts";
import { LUCA_MCP_USER_AGENT, LUCA_MCP_VERSION } from "../src/version.ts";

const VALID_VERSION = "0.2.0";

const VALID_OPERATION_COUNT = 96;

const VALID_TASK_TOOL_COUNT = 12;

function declaredEnvironmentVariables() {
  return READ_ENVIRONMENT_VARIABLES.map((name) => ({ name }));
}

function validServer(): ServerJson {
  return {
    name: "io.github.setluca/luca-mcp",
    version: VALID_VERSION,
    description: `Work your Luca workspace from any MCP client: ${VALID_OPERATION_COUNT} API tools + ${VALID_TASK_TOOL_COUNT} task tools for leads and campaigns.`,
    packages: [
      {
        version: VALID_VERSION,
        identifier: "@setluca/mcp",
        environmentVariables: declaredEnvironmentVariables(),
      },
    ],
  };
}

function validPackage(): PackageJson {
  return {
    version: VALID_VERSION,
    name: "@setluca/mcp",
    mcpName: "io.github.setluca/luca-mcp",
  };
}

function validInputs(): RegistryCheckInputs {
  return {
    server: validServer(),
    pkg: validPackage(),
    lucaMcpVersion: VALID_VERSION,
    operationCount: VALID_OPERATION_COUNT,
    taskToolCount: VALID_TASK_TOOL_COUNT,
  };
}

describe("checkRegistry", () => {
  it("passes for a fully consistent fixture", () => {
    expect(checkRegistry(validInputs())).toEqual([]);
  });

  type Case = {
    readonly name: string;
    readonly build: (inputs: RegistryCheckInputs) => RegistryCheckInputs;
    readonly expectedSubstring: string;
  };

  const cases: readonly Case[] = [
    {
      name: "server.json version drifts from package.json",
      build: (inputs) => ({
        ...inputs,
        server: { ...inputs.server, version: "0.1.0" },
      }),
      expectedSubstring: "server.json version",
    },
    {
      name: "src/version.ts drifts from package.json",
      build: (inputs) => ({ ...inputs, lucaMcpVersion: "0.1.0" }),
      expectedSubstring: "src/version.ts LUCA_MCP_VERSION",
    },
    {
      name: "server.json packages[0].version drifts from package.json",
      build: (inputs) => ({
        ...inputs,
        server: {
          ...inputs.server,
          packages: [{ ...inputs.server.packages?.[0], version: "0.1.0" }],
        },
      }),
      expectedSubstring: "server.json packages[0].version",
    },
    {
      name: "server.json packages[0].identifier drifts from package.json name",
      build: (inputs) => ({
        ...inputs,
        server: {
          ...inputs.server,
          packages: [
            { ...inputs.server.packages?.[0], identifier: "@wrong/mcp" },
          ],
        },
      }),
      expectedSubstring: "server.json packages[0].identifier",
    },
    {
      name: "package.json mcpName does not match server.json name",
      build: (inputs) => ({
        ...inputs,
        pkg: { ...inputs.pkg, mcpName: "io.github.wrong/name" },
      }),
      expectedSubstring: "package.json mcpName",
    },
    {
      name: "description is missing the API operation count",
      build: (inputs) => ({
        ...inputs,
        server: {
          ...inputs.server,
          description: "Work your Luca workspace: 12 task tools only.",
        },
      }),
      expectedSubstring: "real API operation count",
    },
    {
      name: "description is missing the task tool count",
      build: (inputs) => ({
        ...inputs,
        server: {
          ...inputs.server,
          description: "Work your Luca workspace: 96 API tools only.",
        },
      }),
      expectedSubstring: "real task tool count",
    },
    {
      name: "description contains the count only as a substring of a bigger number",
      build: (inputs) => ({
        ...inputs,
        server: {
          ...inputs.server,
          description: "Work your Luca workspace: 196 API tools, 12 tasks.",
        },
      }),
      expectedSubstring: "real API operation count",
    },
    {
      name: "description is over the registry's 100 character limit",
      build: (inputs) => ({
        ...inputs,
        server: {
          ...inputs.server,
          description: `Work your Luca workspace from any MCP client, and take advantage of every single one of the ${VALID_OPERATION_COUNT} API tools plus the ${VALID_TASK_TOOL_COUNT} task tools built for leads and campaigns.`,
        },
      }),
      expectedSubstring: "the MCP registry allows at most 100",
    },
    {
      name: "an environment variable the code reads is not declared",
      build: (inputs) => ({
        ...inputs,
        server: {
          ...inputs.server,
          packages: [
            {
              ...inputs.server.packages?.[0],
              environmentVariables: declaredEnvironmentVariables().filter(
                (entry) => entry.name !== "LUCA_TOOLSET"
              ),
            },
          ],
        },
      }),
      expectedSubstring: "LUCA_TOOLSET is read",
    },
  ];

  it.each(cases)("$name", ({ build, expectedSubstring }) => {
    const errors = checkRegistry(build(validInputs()));
    expect(errors.some((error) => error.includes(expectedSubstring))).toBe(
      true
    );
  });

  it("reports every mismatch at once, not just the first", () => {
    const errors = checkRegistry({
      ...validInputs(),
      lucaMcpVersion: "0.1.0",
      server: { ...validServer(), version: "0.1.0" },
    });

    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe("checkPluginManifests", () => {
  const REMOTE_URL = "https://mcp.setluca.com/mcp";

  const server: ServerJson = {
    ...validServer(),
    remotes: [{ type: "streamable-http", url: REMOTE_URL }],
  };

  function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
    return {
      path: "plugins/claude/.claude-plugin/plugin.json",
      version: VALID_VERSION,
      serverUrls: [REMOTE_URL],
      ...overrides,
    };
  }

  it("accepts manifests at the package version that point at the hosted server", () => {
    expect(checkPluginManifests([manifest()], validPackage(), server)).toEqual(
      []
    );
  });

  it("names a manifest left at an older version", () => {
    const errors = checkPluginManifests(
      [manifest({ version: "0.1.0" })],
      validPackage(),
      server
    );

    expect(errors).toEqual([
      expect.stringContaining(
        "plugins/claude/.claude-plugin/plugin.json version (0.1.0)"
      ),
    ]);
  });

  it.each([
    { name: "another server", serverUrls: ["https://example.com/mcp"] },
    {
      name: "the Claude toolset",
      serverUrls: [`${REMOTE_URL}?toolset=claude`],
    },
    { name: "no server", serverUrls: [] },
    { name: "two servers", serverUrls: [REMOTE_URL, REMOTE_URL] },
  ])("rejects a manifest that declares $name", ({ serverUrls }) => {
    const errors = checkPluginManifests(
      [manifest({ serverUrls })],
      validPackage(),
      server
    );

    expect(errors).toEqual([
      expect.stringContaining("must declare exactly one MCP server"),
    ]);
  });

  it("checks every plugin the repository ships", () => {
    expect(PLUGIN_MANIFESTS.map((entry) => entry.manifest)).toEqual([
      "plugins/claude/.claude-plugin/plugin.json",
      "plugins/cursor/.cursor-plugin/plugin.json",
      "gemini-extension.json",
    ]);
  });
});

const decodePackageVersion = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String }))
);

layer(BunServices.layer)("the shipped version literal", (it) => {
  it.effect(
    "matches package.json, which is the value every drift check compares to",
    () =>
      Effect.gen(function* () {
        // `checkRegistry` above runs on fixtures, so nothing there reads the
        // real literal. The stdio build cannot import package.json at runtime,
        // which is why the value is hand-written, and this is what catches a
        // bump that touched only one of the two.
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const pkg = yield* decodePackageVersion(
          yield* fs.readFileString(
            path.resolve(import.meta.dirname, "../package.json")
          )
        );

        expect(LUCA_MCP_VERSION).toBe(pkg.version);
        expect(LUCA_MCP_USER_AGENT).toBe(`luca-mcp/${pkg.version}`);
      })
  );
});
