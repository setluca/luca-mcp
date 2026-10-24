import * as Effect from "effect/Effect";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import type { LucaOperationId } from "../src/operations.ts";
import type { ConfirmCondition } from "../src/operations/registry.ts";
import { taskTool } from "../src/task-tools/runtime.ts";
import { toolProfile } from "../src/tool-profile.ts";

/**
 * A task tool that only exists for this file, composing real catalog
 * operations, so each test states the facts it combines rather than leaning on
 * whichever shipped tool happens to compose them today.
 */
function composing(
  composes: readonly [LucaOperationId, ...LucaOperationId[]],
  own: {
    readonly untrustedContent?: true;
    readonly confirm?: ConfirmCondition;
  } = {}
) {
  return taskTool({
    name: "luca_profile_test",
    title: "Profile test",
    description: "A task tool declared only by this test.",
    inputSchema: {},
    outputSchema: Schema.Null,
    composes,
    ...own,
    run: () => Effect.succeed(null),
  });
}

const OWN_GATE: ConfirmCondition = {
  applies: () => true,
  description: "the test says so",
};

describe("toolProfile for a task tool", () => {
  it("states the facts its operations share when they all agree", () => {
    const profile = toolProfile(
      composing(["capabilities.get", "channels.list"])
    );

    expect(profile).toMatchObject({
      readOnly: true,
      mutatesExisting: false,
      idempotent: true,
      untrustedContent: false,
      openWorld: false,
      oauthScope: "luca:read",
      annotations: {
        title: "Profile test",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    });
    expect(profile.confirm).toBeUndefined();
    expect("confirm" in profile.inputSchema).toBe(false);
  });

  it("is never safer than the least safe operation it composes", () => {
    const profile = toolProfile(
      composing([
        "leads.list",
        "conversations.send",
        "webhooks.subscriptions.create",
      ])
    );

    expect(profile).toMatchObject({
      readOnly: false,
      mutatesExisting: true,
      idempotent: false,
      confirm: "always",
      untrustedContent: true,
      openWorld: true,
      oauthScope: "luca:full",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    });
    expect("confirm" in profile.inputSchema).toBe(true);
  });

  it("needs every API scope its operations declare, once each and sorted", () => {
    expect(
      toolProfile(
        composing([
          "usage.messages",
          "channels.list",
          "leads.list",
          "leads.get",
        ])
      ).apiScopes
    ).toEqual(["channels:read", "leads:read", "usage:read"]);
  });

  it("reads destructive when an ungated write it composes changes existing state", () => {
    const profile = toolProfile(composing(["leads.list", "leads.update"]));

    expect(profile.confirm).toBeUndefined();
    expect(profile.annotations.destructiveHint).toBe(true);
  });

  it("gates every call over a conditionally gated operation, unless it names its own condition", () => {
    expect(toolProfile(composing(["campaigns.setStatus"])).confirm).toBe(
      "always"
    );
    expect(
      toolProfile(composing(["campaigns.setStatus"], { confirm: OWN_GATE }))
        .confirm
    ).toBe(OWN_GATE);
  });

  it("lets a composed operation gated on every call override its own condition", () => {
    expect(
      toolProfile(composing(["conversations.send"], { confirm: OWN_GATE }))
        .confirm
    ).toBe("always");
  });

  it("keeps its own condition when nothing it composes is gated", () => {
    expect(
      toolProfile(composing(["channels.list"], { confirm: OWN_GATE })).confirm
    ).toBe(OWN_GATE);
  });

  it("frames its result untrusted when it says so, over trusted operations", () => {
    const framed = toolProfile(
      composing(["channels.list"], { untrustedContent: true })
    );

    expect(framed.untrustedContent).toBe(true);
    expect(R.keys(framed.outputSchema)).toEqual(["result", "provenance"]);
    expect(
      R.keys(toolProfile(composing(["channels.list"])).outputSchema)
    ).toEqual(["result"]);
  });
});
