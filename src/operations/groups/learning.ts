import { op } from "../registry.ts";
import type { LucaOperation } from "../registry.ts";

export const learningOperations: readonly LucaOperation[] = [
  op({
    id: "learning.panel",
    title: "Read what Luca wants to learn",
    description:
      "Read which of the three profile questions Luca still owes an answer to, with suggested answers inferred from the coach's own words. The worked example pair is blanked for a redacted-tier key.",
  }),
  op({
    id: "learning.frameworkPerformance",
    title: "Read framework objection performance",
    description:
      "Win rate by objection bucket for the sales framework the coach has configured right now, over a rolling window. These numbers are correlational \u2014 read them as a signal, not as proof a framework caused the result.",
  }),
  op({
    id: "learning.abTests.list",
    title: "List A/B tests",
    description:
      "List the coach's A/B tests, newest first, optionally filtered by status. Variant config comes back as stored, since its shape depends on what the test compares. Creating, starting, stopping, and adopting a test stay in the Luca app.",
  }),
  op({
    id: "learning.abTests.get",
    title: "Get an A/B test",
    description:
      "Read one A/B test with its per-variant numbers: how many leads each arm saw, and how each is doing against the success metric. Small samples swing widely, so say how many leads each arm has before calling a winner.",
  }),
  op({
    id: "learning.proposals.list",
    title: "List learning proposals",
    description:
      "List what the coach's tests have learned and are proposing they act on, newest first. Dismissed proposals are left out unless you ask for them.",
  }),
  op({
    id: "learning.proposals.dismiss",
    // Answers with ids and status flags only; no lead-authored text.
    untrustedContent: false,
    title: "Dismiss a learning proposal",
    mutatesExisting: true,
    description:
      "Dismiss one learning proposal so it drops out of the default list. Use it when the coach has decided against the change, not when you have simply read it.",
  }),
];
