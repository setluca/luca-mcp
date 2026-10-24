import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Order from "effect/Order";
import { describe, expect, it, onTestFinished } from "vitest";

import {
  type Fixture,
  SWEEP_PHASES,
  SWEEP_PLAN,
  SWEEP_SURFACES,
  type SweepStep,
} from "../scripts/sweep/plan.ts";
import { LUCA_API_PLANNER_PROMPT, LUCA_PROMPTS } from "../src/prompts.ts";
import {
  LUCA_OPERATION_MANIFEST_RESOURCE,
  LUCA_RESOURCES,
} from "../src/resources.ts";
import { connect } from "./helpers.ts";

/**
 * `scripts/sweep/plan.ts` drives the live sweep of every tool (LUC-515). These
 * checks keep it honest without calling anything: a tool added to the server
 * without a sweep step, or a step that needs a record nothing provides, fails
 * here rather than in a sweep run against production.
 */

async function listedTools() {
  const { client, close } = await connect(() => Effect.succeed({}));

  onTestFinished(close);

  const { tools } = await client.listTools();

  return tools;
}

const primarySteps = SWEEP_PLAN.filter((step) => step.extra === undefined);

const runOrder = Arr.sort(
  SWEEP_PLAN,
  Order.mapInput(Order.Number, (step: SweepStep) =>
    SWEEP_PHASES.indexOf(step.phase)
  )
);

describe("tool sweep plan", () => {
  it("has exactly one primary step for every listed tool", async () => {
    const tools = await listedTools();

    expect(primarySteps.map((step) => step.tool).toSorted()).toEqual(
      tools.map((tool) => tool.name).toSorted()
    );
  });

  it("names only listed tools in its extra steps", async () => {
    const names = new Set((await listedTools()).map((tool) => tool.name));

    expect(
      SWEEP_PLAN.filter((step) => !names.has(step.tool)).map(
        (step) => step.tool
      )
    ).toEqual([]);
  });

  it("keeps every write out of the discovery and read phases", async () => {
    const readOnly = new Set(
      (await listedTools())
        .filter((tool) => tool.annotations?.readOnlyHint === true)
        .map((tool) => tool.name)
    );

    expect(
      SWEEP_PLAN.filter(
        (step) =>
          (step.phase === "discover" || step.phase === "read") &&
          !readOnly.has(step.tool)
      ).map((step) => step.tool)
    ).toEqual([]);
  });

  it("marks exactly the tools that take confirm: true as gated", async () => {
    const takesConfirm = (await listedTools())
      .filter((tool) => tool.inputSchema.properties?.confirm !== undefined)
      .map((tool) => tool.name)
      .toSorted();

    expect(
      primarySteps
        .filter((step) => step.gated === true)
        .map((step) => step.tool)
        .toSorted()
    ).toEqual(takesConfirm);
  });

  it("only uses records an earlier step provides", () => {
    const provided = new Set<Fixture>();
    const unmet: string[] = [];

    for (const step of runOrder) {
      for (const need of step.needs ?? []) {
        if (!provided.has(need)) {
          unmet.push(`${step.tool} needs ${need}`);
        }
      }

      for (const name of Object.keys(step.provides ?? {})) {
        provided.add(name as Fixture);
      }
    }

    for (const surface of SWEEP_SURFACES) {
      if (surface.method === "resources/read") {
        for (const need of surface.needs ?? []) {
          if (!provided.has(need)) {
            unmet.push(`resource read needs ${need}`);
          }
        }
      }
    }

    expect(unmet).toEqual([]);
  });

  it("explains every refusal and every pending step", () => {
    const unexplained = SWEEP_PLAN.filter(
      (step: SweepStep) =>
        step.expect !== undefined &&
        step.expect.kind !== "ok" &&
        step.expect.because === ""
    );

    expect(unexplained).toEqual([]);
  });

  it("gets every prompt and reads every resource", () => {
    expect(
      SWEEP_SURFACES.flatMap((surface) =>
        surface.method === "prompts/get" ? [surface.name] : []
      ).toSorted()
    ).toEqual(
      [LUCA_API_PLANNER_PROMPT, ...LUCA_PROMPTS]
        .map((prompt) => prompt.name)
        .toSorted()
    );

    const fixtures = { lead: "LEAD", conversation: "CONVERSATION" } as Record<
      Fixture,
      string
    >;

    const read = SWEEP_SURFACES.flatMap((surface) =>
      surface.method === "resources/read" ? [surface.uri(fixtures)] : []
    ).toSorted();

    const declared = [
      LUCA_OPERATION_MANIFEST_RESOURCE.uri,
      ...LUCA_RESOURCES.map((resource) =>
        "uri" in resource
          ? resource.uri
          : resource.uriTemplate
              .replace("{leadId}", "LEAD")
              .replace("{conversationId}", "CONVERSATION")
      ),
    ].toSorted();

    expect(read).toEqual(declared);
  });
});
