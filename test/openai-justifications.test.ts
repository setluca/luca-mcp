import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as Effect from "effect/Effect";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import { describe, expect, it, onTestFinished } from "vitest";

import { connect } from "./helpers.ts";

/**
 * OpenAI's plugin review asks for a justification of every tool's
 * readOnlyHint, destructiveHint, and openWorldHint, and rejects one that does
 * not match what the tool does. The justifications live beside the submission
 * package, so a hint that changes here has to change its justification too.
 */
/* oxlint-disable effect/require-is-prefix-for-boolean-schema-field -- MCP's ToolAnnotations names these four fields */
const Justification = Schema.Struct({
  readOnlyHint: Schema.Boolean,
  destructiveHint: Schema.Boolean,
  openWorldHint: Schema.Boolean,
  idempotentHint: Schema.Boolean,
  justification: Schema.String.check(Schema.isMinLength(1)),
});
/* oxlint-enable effect/require-is-prefix-for-boolean-schema-field */

const JustificationFile = Schema.Struct({
  tools: Schema.Record(Schema.String, Justification),
});

const { tools: justifications } = Schema.decodeSync(
  Schema.fromJsonString(JustificationFile)
)(
  readFileSync(
    join(
      import.meta.dirname,
      "..",
      "submission",
      "openai",
      "annotation-justifications.json"
    ),
    "utf-8"
  )
);

async function listedTools() {
  const { client, close } = await connect(() => Effect.succeed({}));

  onTestFinished(close);

  const { tools } = await client.listTools();

  return tools;
}

describe("OpenAI annotation justifications", () => {
  it("justify every listed tool and no other", async () => {
    const tools = await listedTools();

    expect(R.keys(justifications).toSorted()).toEqual(
      tools.map((tool) => tool.name).toSorted()
    );
  });

  it("justify the hints each tool lists", async () => {
    const tools = await listedTools();

    const listed = R.fromEntries(
      tools.map((tool) => [
        tool.name,
        {
          readOnlyHint: tool.annotations?.readOnlyHint,
          destructiveHint: tool.annotations?.destructiveHint,
          openWorldHint: tool.annotations?.openWorldHint,
          idempotentHint: tool.annotations?.idempotentHint,
        },
      ])
    );

    expect(
      R.map(
        justifications,
        ({ readOnlyHint, destructiveHint, openWorldHint, idempotentHint }) => ({
          readOnlyHint,
          destructiveHint,
          openWorldHint,
          idempotentHint,
        })
      )
    ).toEqual(listed);
  });

  it("name the confirmation step of every gated tool", async () => {
    // OpenAI asks a destructive tool's justification to name its safeguards.
    // A bare "confirm" is not enough: "confirm a no-show" names an action.
    const namesGate =
      /gated by confirm|needs? confirm|confirm is required|confirm: true/u;

    const tools = await listedTools();

    const unnamed = tools
      .filter((tool) => tool.inputSchema.properties?.confirm !== undefined)
      .map((tool) => tool.name)
      .filter(
        (name) => !namesGate.test(justifications[name]?.justification ?? "")
      );

    expect(unnamed).toEqual([]);
  });
});
