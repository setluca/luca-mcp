import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";

import { formatError } from "../errors.ts";
import { WORKSPACE_INPUT_FIELDS } from "../fields.ts";
import { logAgentSurfaceEvent } from "../observability.ts";
import type { JsonValue } from "../serialization.ts";
import {
  isPartialFailure,
  listingIds,
  numberInput,
  operationResult,
  resultOrError,
  type TaskCall,
  taskTool,
} from "./runtime.ts";

const DEFAULT_QUEUE_LIMIT = 20;

const DEFAULT_EXPLAIN_TOP = 3;

const TRIAGE_INBOX_TOOL_NAME = "luca_triage_inbox";

/** One explanation lookup: the queue item, what came back, and whether it failed. */
type ExplainAttempt = {
  readonly id: string;
  readonly explanation: JsonValue;
  readonly failed: boolean;
};

/**
 * One explanation, with a failed lookup carried in the result instead of
 * cancelling the others. A queue the coach can read with two explanations
 * missing beats no queue at all. An authorization failure still ends the call,
 * see {@link isPartialFailure}.
 */
function explainOne(call: TaskCall<"reviewQueue.explain">, id: string) {
  return call("reviewQueue.explain", { pathParams: { id } }).pipe(
    Effect.map((explanation): ExplainAttempt => ({
      id,
      explanation,
      failed: false,
    })),
    // Keep the structured formatter, not a lossy String(error): a
    // LucaHttpError's status/requestId survive for debugging a partial
    // failure inside the composed tool.
    Effect.catchIf(isPartialFailure, (error) =>
      Effect.succeed<ExplainAttempt>({
        id,
        explanation: { explainError: formatError(error) },
        failed: true,
      })
    )
  );
}

/**
 * How the explain fan-out went, as counts.
 *
 * `mcp.tool.called` reports this tool as a success even when every explanation
 * inside it failed, because a failed lookup comes back as an `explainError`
 * field rather than an error result. Without this line, an explain route that
 * is broken for every caller looks identical in logs to one that works.
 *
 * The single-route explain tools need no line of their own: `mcp.tool.called`
 * already carries their name and outcome. This fan-out is the only place where
 * a failure has nowhere else to show up.
 *
 * Counts only, never an id or an explanation. Both are lead-derived.
 */
function logExplainFanOut(attempts: readonly ExplainAttempt[]) {
  if (Arr.isReadonlyArrayEmpty(attempts)) {
    return;
  }

  const failed = attempts.filter((attempt) => attempt.failed).length;
  logAgentSurfaceEvent("mcp.explain", {
    toolName: TRIAGE_INBOX_TOOL_NAME,
    requested: attempts.length,
    explained: attempts.length - failed,
    failed,
  });
}

/** The review session's entry point: the queue, with the top items explained. */
const triageInbox = taskTool({
  name: TRIAGE_INBOX_TOOL_NAME,
  title: "Triage the review queue",
  description:
    "Return the coach's prioritized reply queue: pending drafts with lead context and, for the top items, why Luca drafted what it drafted. Start every review session here, then act on an item with luca_approve_and_send, luca_draft_reply, or luca_review_queue_reject. Example: call with { explainTop: 3 } to get the queue plus explanations for the three most urgent drafts.",
  inputSchema: {
    ...WORKSPACE_INPUT_FIELDS,
    limit: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })).annotate({
        description: "Max queue items to return (default 20).",
      })
    ),
    explainTop: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })).annotate({
        description:
          "How many of the top items to attach a full explanation to (default 3).",
      })
    ),
  },
  outputSchema: Schema.Struct({
    queue: operationResult("reviewQueue.list"),
    explanations: Schema.Record(
      Schema.String,
      resultOrError("reviewQueue.explain", "explainError")
    ),
  }),
  composes: ["reviewQueue.list", "reviewQueue.explain"],
  run: (call, input) =>
    Effect.gen(function* () {
      const queue = yield* call("reviewQueue.list", {
        query: { limit: numberInput(input.limit, DEFAULT_QUEUE_LIMIT) },
      });

      const ids = listingIds(
        queue,
        numberInput(input.explainTop, DEFAULT_EXPLAIN_TOP)
      );

      const attempts = yield* Effect.forEach(
        ids,
        (id) => explainOne(call, id),
        // Effect.forEach defaults to concurrency 1 (sequential). `explainTop`
        // caps this fan-out at 5 independent lookups, so unbounded is fine.
        // No caller input can grow it into a thundering herd.
        { concurrency: "unbounded" }
      );

      logExplainFanOut(attempts);

      return {
        queue,
        explanations: R.fromEntries(
          attempts.map((attempt): [string, JsonValue] => [
            attempt.id,
            attempt.explanation,
          ])
        ),
      };
    }),
});

/** The day's opening read: the last 24h of queue activity, already counted. */
const morningReport = taskTool({
  name: "luca_morning_report",
  title: "Get the morning digest",
  description:
    "Return the coach's structured last-24h review-queue digest: queued drafts with status and confidence, plus counts by status. No model call — summarize it client-side. Example: call with {} at the start of the day.",
  inputSchema: {
    ...WORKSPACE_INPUT_FIELDS,
  },
  outputSchema: operationResult("reports.morning"),
  composes: ["reports.morning"],
  run: (call) => call("reports.morning"),
});

export const inboxTaskTools = [triageInbox, morningReport];
