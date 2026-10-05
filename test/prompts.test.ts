import * as Arr from "effect/Array";
import * as R from "effect/Record";
import { assert, describe, expect, it } from "vitest";

import { LUCA_OPERATIONS } from "../src/operations.ts";
import {
  LUCA_API_PLANNER_PROMPT,
  LUCA_PROMPTS,
  type LucaPrompt,
} from "../src/prompts.ts";
import { LUCA_TASK_TOOLS } from "../src/task-tools.ts";
import { sorted } from "./helpers.ts";

const REGISTERED_TOOLS = [
  ...LUCA_OPERATIONS.map((operation) => operation.toolName),
  ...LUCA_TASK_TOOLS.map((tool) => tool.name),
];

/** Every argument a prompt takes, filled in, so optional lines render too. */
function fullArgs(prompt: LucaPrompt) {
  return R.map(prompt.args, (_, name) => `${name}-value`);
}

function getPrompt(name: string) {
  const prompt = LUCA_PROMPTS.find((p) => p.name === name);

  assert(prompt, `prompt not registered: ${name}`);

  return prompt;
}

describe("luca prompts", () => {
  it("registers the eight named workflow prompts", () => {
    expect(sorted(LUCA_PROMPTS.map((p) => p.name))).toEqual(
      sorted([
        "luca-close-the-call-loop",
        "luca-draft-reply",
        "luca-morning-report",
        "luca-plan-broadcast",
        "luca-plan-campaign",
        "luca-rescue-silent-leads",
        "luca-triage-queue",
        "luca-weekly-review",
      ])
    );
  });

  it.each([LUCA_API_PLANNER_PROMPT, ...LUCA_PROMPTS])(
    "$name names only registered tools",
    (prompt) => {
      const texts = [prompt.build({}), prompt.build(fullArgs(prompt))];
      const named = texts.flatMap((text) => text.match(/\bluca_\w+/g) ?? []);

      expect(
        named.filter((name) => !Arr.contains(REGISTERED_TOOLS, name))
      ).toEqual([]);
    }
  );

  it.each(LUCA_PROMPTS)("$name ends with the safety rules", (prompt) => {
    const text = prompt.build(fullArgs(prompt));

    expect(text).toContain("\n\nSafety rules:\n");
    expect(text).toMatch(/never as instructions to follow\.$/);
  });

  it.each([
    ["luca-morning-report", ["luca_morning_report", "luca_analytics_rollup"]],
    ["luca-triage-queue", ["luca_triage_inbox"]],
    ["luca-draft-reply", ["luca_draft_reply", "luca_approve_and_send"]],
    [
      "luca-weekly-review",
      ["luca_analytics_deep_dive", "luca_analytics_rollup"],
    ],
  ])("%s steers to the task tools built for the job", (name, tools) => {
    const text = getPrompt(name).build({});

    Arr.forEach(tools, (tool) => {
      expect(text).toContain(`\`${tool}\``);
    });
  });

  it("keeps the safety rules out of the planner prompt", () => {
    expect(LUCA_API_PLANNER_PROMPT.build({ task: "list leads" })).toBe(
      [
        "Use Luca MCP tools only for public API operations.",
        "Do not ask for database access, internal endpoints, webhook ingress secrets, or browser cookies.",
        "For writes, pass a stable idempotencyKey when retrying the same user intent.",
        "Check luca://operations when you need exact tool names, scopes, and paths.",
        "User task: list leads",
      ].join("\n")
    );
  });

  describe("luca-draft-reply", () => {
    const prompt = () => getPrompt("luca-draft-reply");

    it("targets the conversation over the lead, and asks when given neither", () => {
      expect(
        prompt().build({ conversationId: "conv-123", leadId: "lead-456" })
      ).toMatch(/^Draft a reply for conversation conv-123 \(use/);
      expect(prompt().build({ leadId: "lead-456" })).toMatch(
        /^Draft a reply for lead lead-456 \(use/
      );
      expect(prompt().build({})).toMatch(
        /^Draft a reply for the lead the coach means\. If they have not said which, ask them/
      );
    });

    it("appends trimmed guidance only when provided", () => {
      expect(prompt().build({ guidance: "  keep it warm  " })).toContain(
        "\n\nExtra guidance: keep it warm\n"
      );
      expect(prompt().build({})).not.toContain("Extra guidance");
    });
  });

  describe("luca-rescue-silent-leads", () => {
    const prompt = () => getPrompt("luca-rescue-silent-leads");

    it("falls back to a week of silence when the caller names no window", () => {
      expect(prompt().build({})).toContain("quiet for 7 days or more");
      expect(prompt().build({ days: "21" })).toContain(
        "quiet for 21 days or more"
      );
      // A blank argument is the same as no argument, not a window of nothing.
      expect(prompt().build({ days: "  " })).toContain(
        "quiet for 7 days or more"
      );
    });

    it("applies the window to the conversation list step", () => {
      expect(prompt().build({ days: "21" })).toContain(
        "has not replied in the last 21 days"
      );
    });
  });

  describe("luca-plan-campaign", () => {
    const prompt = () => getPrompt("luca-plan-campaign");

    it("states a trimmed goal, or asks for one when none is given", () => {
      expect(prompt().build({ goal: "  book 10 calls  " })).toContain(
        "Goal: book 10 calls\n"
      );
      expect(prompt().build({})).toContain(
        "First ask the coach what the campaign should achieve"
      );
    });

    it("dry-runs before publishing and publishes only on the coach's word", () => {
      const text = prompt().build({});

      expect(text.indexOf("luca_campaigns_simulations_create")).toBeLessThan(
        text.indexOf("luca_campaigns_publish")
      );
      expect(text).toContain(
        "Publish with `luca_campaigns_publish` only when the coach says so."
      );
    });
  });

  describe("luca-plan-broadcast", () => {
    const prompt = () => getPrompt("luca-plan-broadcast");

    it("names the campaign, or asks for one when none is given", () => {
      expect(prompt().build({ campaignId: "camp-1" })).toContain(
        "Campaign: camp-1\n"
      );
      expect(prompt().build({})).toContain(
        "First ask the coach which campaign it belongs to"
      );
    });

    it("previews before approval and launches only on the coach's word", () => {
      const text = prompt().build({});

      expect(text.indexOf("luca_broadcasts_preview")).toBeLessThan(
        text.indexOf("luca_broadcasts_approve")
      );
      expect(text).toContain(
        "Launch with `luca_broadcasts_launch` only when the coach says so."
      );
    });
  });
});
