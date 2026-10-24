import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as Effect from "effect/Effect";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import { describe, expect, it, onTestFinished } from "vitest";

import { connect } from "./helpers.ts";

/**
 * `submission/openai/chatgpt-app-submission.json` fills the ChatGPT app
 * submission form, in the import format OpenAI publishes at
 * developers.openai.com/plugins/schemas/chatgpt-app-submission.v1.json. The
 * review rejects a tool whose readOnlyHint, openWorldHint, or destructiveHint
 * lacks a justification that matches what the tool does, so a hint that
 * changes here has to change its justification in the same commit.
 */
const SUBMISSION = join(import.meta.dirname, "..", "submission", "openai");

const Text = Schema.String.check(Schema.isPattern(/\S/u));

/* oxlint-disable effect/require-is-prefix-for-boolean-schema-field -- MCP's ToolAnnotations names these three fields */
const Tool = Schema.Struct({
  annotations: Schema.Struct({
    readOnlyHint: Schema.Boolean,
    openWorldHint: Schema.Boolean,
    destructiveHint: Schema.Boolean,
  }),
  justifications: Schema.Struct({
    read_only_justification: Text,
    open_world_justification: Text,
    destructive_justification: Text,
  }),
});
/* oxlint-enable effect/require-is-prefix-for-boolean-schema-field */

const TestCase = Schema.Struct({
  description: Text,
  user_prompt: Text,
  file_attachment_urls: Schema.NullOr(Schema.Array(Schema.String)),
  tools_triggered: Schema.NullOr(Text),
  expected_output: Schema.NullOr(Text),
  expected_output_url: Schema.NullOr(Schema.String),
});

const Submission = Schema.Struct({
  $schema: Schema.Literal(
    "https://developers.openai.com/plugins/schemas/chatgpt-app-submission.v1.json"
  ),
  schema_version: Schema.Literal(1),
  app_info: Schema.Struct({
    display_name: Text,
    subtitle: Text.check(Schema.isMaxLength(30)),
    description: Text.check(Schema.isMaxLength(4000)),
    category: Schema.Literal("BUSINESS"),
  }),
  tools: Schema.Record(Schema.String, Tool),
  test_cases: Schema.Array(TestCase).check(Schema.isMinLength(5)),
  negative_test_cases: Schema.Array(TestCase).check(Schema.isMinLength(3)),
});

const PluginTestCase = Schema.Struct({
  description: Schema.String,
  prompt: Schema.String,
  tools_triggered: Schema.optionalKey(Schema.String),
  expected_behavior: Schema.optionalKey(Schema.String),
});

const Plugin = Schema.Struct({
  extensions: Schema.Struct({
    "com.openai": Schema.Struct({
      interface: Schema.Struct({
        displayName: Schema.String,
        shortDescription: Schema.String,
        longDescription: Schema.String,
      }),
      review: Schema.Struct({
        test_cases: Schema.Struct({
          positive: Schema.Array(PluginTestCase),
          negative: Schema.Array(PluginTestCase),
        }),
      }),
    }),
  }),
});

/**
 * The portal reads the server's authentication only from `mcp.json`. Without
 * this declaration the connect drawer starts at "No authentication" and
 * reconnecting only refreshes the tool list instead of signing in again.
 */
const PluginMcp = Schema.Struct({
  mcpServers: Schema.Struct({
    luca: Schema.Struct({
      type: Schema.Literal("streamable-http"),
      url: Schema.Literal("https://mcp.setluca.com/mcp"),
      extensions: Schema.Struct({
        "com.openai": Schema.Struct({
          auth: Schema.Struct({
            type: Schema.Literal("oauth"),
            client: Schema.Struct({ mode: Schema.Literal("cimd") }),
          }),
        }),
      }),
    }),
  }),
});

function readSubmissionFile(...path: string[]): string {
  return readFileSync(join(SUBMISSION, ...path), "utf-8");
}

const submission = Schema.decodeSync(Schema.fromJsonString(Submission))(
  readSubmissionFile("chatgpt-app-submission.json")
);

const plugin = Schema.decodeSync(Schema.fromJsonString(Plugin))(
  readSubmissionFile("luca-mcp", "plugin.json")
).extensions["com.openai"];

async function listedTools() {
  const { client, close } = await connect(() => Effect.succeed({}));

  onTestFinished(close);

  const { tools } = await client.listTools();

  return tools;
}

describe("OpenAI app submission", () => {
  it("justifies every listed tool and no other", async () => {
    const tools = await listedTools();

    expect(R.keys(submission.tools).toSorted()).toEqual(
      tools.map((tool) => tool.name).toSorted()
    );
  });

  it("states the hints each tool lists", async () => {
    const tools = await listedTools();

    expect(R.map(submission.tools, ({ annotations }) => annotations)).toEqual(
      R.fromEntries(
        tools.map((tool) => [
          tool.name,
          {
            readOnlyHint: tool.annotations?.readOnlyHint,
            openWorldHint: tool.annotations?.openWorldHint,
            destructiveHint: tool.annotations?.destructiveHint,
          },
        ])
      )
    );
  });

  it("names the confirmation step of exactly the gated tools", async () => {
    // OpenAI asks a destructive tool's justification to name its safeguards,
    // and a justification that claims a gate the tool lacks is a mismatch.
    const gate = "refuses to run without confirm: true.";

    const tools = await listedTools();

    const gated = new Set(
      tools
        .filter((tool) => tool.inputSchema.properties?.confirm !== undefined)
        .map((tool) => tool.name)
    );

    const mismatched = R.toEntries(submission.tools)
      .filter(([name, { justifications }]) =>
        gated.has(name)
          ? !justifications.destructive_justification
              .toLowerCase()
              .includes(gate)
          : R.values(justifications).some((text) =>
              text.includes("confirm: true")
            )
      )
      .map(([name]) => name);

    expect(mismatched).toEqual([]);
  });

  it("declares the hosted server's OAuth for the portal scan", () => {
    expect(() =>
      Schema.decodeSync(Schema.fromJsonString(PluginMcp))(
        readSubmissionFile("luca-mcp", "mcp.json")
      )
    ).not.toThrow();
  });

  it("repeats the listing and review cases from plugin.json", () => {
    // The package ZIP carries plugin.json; this file fills the form. A
    // reviewer who sees two versions of a test case cannot tell which holds.
    const { interface: listing, review } = plugin;

    expect(submission.app_info).toMatchObject({
      display_name: listing.displayName,
      subtitle: listing.shortDescription,
      description: listing.longDescription,
    });

    expect(submission.test_cases).toEqual(
      review.test_cases.positive.map((testCase) => ({
        description: testCase.description,
        user_prompt: testCase.prompt,
        file_attachment_urls: null,
        tools_triggered: testCase.tools_triggered,
        expected_output: testCase.expected_behavior,
        expected_output_url: null,
      }))
    );

    expect(submission.negative_test_cases).toEqual(
      review.test_cases.negative.map((testCase) => ({
        description: testCase.description,
        user_prompt: testCase.prompt,
        file_attachment_urls: null,
        tools_triggered: null,
        expected_output: null,
        expected_output_url: null,
      }))
    );
  });
});
