import {
  type ClientCapabilities,
  type InputRequiredResult,
  inputRequired,
  inputResponse,
  type McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import * as P from "effect/Predicate";
import * as R from "effect/Record";

import type { JsonObject, JsonValue } from "./serialization.ts";
import { toJsonText } from "./serialization.ts";

/**
 * Asking the coach, not the model, before a confirm-gated tool runs.
 *
 * A gated tool reaches a lead or an outside system. Without help from the
 * client, the only gate is `confirm: true`, which the model passes and the
 * coach never sees. When the client can show a form (MCP elicitation), the
 * server asks the coach itself: the call answers `input_required` with a
 * yes-or-no form describing the exact action, the client shows it, and the
 * call runs only when the coach approves. `confirm: true` from the model does
 * not skip the form.
 *
 * A client that cannot show a form keeps the `confirm: true` rule. That
 * includes every 2025-revision client on the hosted Worker, which serves
 * each request on its own and so cannot carry the client's answer back.
 */

/** The client's answers to earlier forms, exactly as the SDK lifted them. */
type InputResponses = ServerContext["mcpReq"]["inputResponses"];

/** What the server knows, for one call, about asking the coach. */
export type ApprovalContext = {
  /** Whether this client can show the coach a form for this call. */
  readonly supported: boolean;
  readonly responses: InputResponses;
};

/** A client that never shows a form, as over a transport with no context. */
export const NO_APPROVAL: ApprovalContext = {
  supported: false,
  responses: undefined,
};

/**
 * Form-mode elicitation support. In the 2025 revision an empty `elicitation`
 * object means form mode; later ones name `form` explicitly. A client that
 * declares only `url` mode can't show this form.
 */
function supportsFormElicitation(capabilities: ClientCapabilities | undefined) {
  const elicitation = capabilities?.elicitation;

  if (elicitation === undefined) {
    return false;
  }

  return R.isEmptyRecord(elicitation) || P.hasProperty(elicitation, "form");
}

/**
 * The approval context for one call. The SDK reports the client's
 * capabilities per request on the 2026 revision, and keeps the `initialize`
 * value on a 2025 connection that has one (stdio). A 2025 request on the
 * per-request Worker has none, so it falls back to `confirm: true`.
 */
export function approvalContext(
  server: McpServer,
  ctx: ServerContext
): ApprovalContext {
  return {
    supported: supportsFormElicitation(server.server.getClientCapabilities()),
    responses: ctx.mcpReq.inputResponses,
  };
}

/**
 * The call's arguments without `confirm`, which is the model's own say-so and
 * not part of the action.
 */
function actionArguments(input: JsonObject) {
  return R.remove(input, "confirm");
}

const byKey = Order.mapInput(
  Order.String,
  ([key]: readonly [string, JsonValue]) => key
);

/** The same value with every object's keys sorted, so key order can't matter. */
function canonical(value: JsonValue): JsonValue {
  if (Arr.isArray(value)) {
    // SAFETY: every element of a JSON array is a JSON value.
    return Arr.map(value as readonly JsonValue[], canonical);
  }

  if (!P.isObject(value)) {
    return value;
  }

  // SAFETY: a JSON value that is an object and not an array is a JSON object.
  const entries = R.toEntries(value as JsonObject);

  return R.fromEntries(
    Arr.map(Arr.sort(entries, byKey), ([key, field]) => [key, canonical(field)])
  );
}

const FNV_OFFSET = 0x81_1c_9d_c5;

const FNV_PRIME = 0x01_00_01_93;

/**
 * FNV-1a over the arguments' canonical JSON, as a short hex string. It ties
 * an answer to the exact arguments the coach saw: if a retry changes them,
 * the old answer no longer matches and the coach is asked again. It is a
 * consistency check against a confused retry, not a security boundary; the
 * client that shows the form is already the party the coach trusts.
 */
function fingerprint(value: JsonValue) {
  const hash = Arr.reduce(
    Array.from(toJsonText(canonical(value))),
    FNV_OFFSET,
    (acc, char) => Math.imul(acc ^ (char.codePointAt(0) ?? 0), FNV_PRIME) >>> 0
  );

  return hash.toString(16).padStart(8, "0");
}

/** The key the form and its answer travel under, unique to tool and arguments. */
export function approvalKey(toolName: string, input: JsonObject) {
  return `approve_${toolName}_${fingerprint(actionArguments(input))}`;
}

/** What the coach did with the form for this exact call, if anything yet. */
export type ApprovalDecision = "approved" | "declined" | "unanswered";

export function approvalDecision(
  approval: ApprovalContext,
  toolName: string,
  input: JsonObject
): ApprovalDecision {
  const answer = inputResponse(
    approval.responses,
    approvalKey(toolName, input)
  );

  if (answer.kind !== "elicit") {
    return "unanswered";
  }

  // Unchecked counts as no: only an explicit yes runs the action.
  return answer.action === "accept" && answer.content?.approve === true
    ? "approved"
    : "declined";
}

const MAX_SHOWN_ARGUMENTS = 12;

const MAX_SHOWN_VALUE_LENGTH = 280;

/** One argument as a line the coach can read, cut short when it's long. */
function argumentLine([key, value]: readonly [string, JsonValue]) {
  const text = P.isString(value) ? value : toJsonText(value);

  const shown =
    text.length > MAX_SHOWN_VALUE_LENGTH
      ? `${text.slice(0, MAX_SHOWN_VALUE_LENGTH)}…`
      : text;

  return `• ${key}: ${shown}`;
}

/** The parts of a tool the form names. */
type ApprovalTool = { readonly name: string; readonly title: string };

/**
 * The form's text: what will happen and with which arguments. It goes to the
 * coach's own client, never to a log.
 */
export function approvalMessage(tool: ApprovalTool, input: JsonObject) {
  const entries = R.toEntries(actionArguments(input));
  const shown = Arr.take(entries, MAX_SHOWN_ARGUMENTS);
  const hidden = entries.length - shown.length;

  return [
    `SetLuca: ${tool.title} (${tool.name})`,
    "This reaches a lead or an outside system. Approve only if this is exactly what you want.",
    "",
    ...Arr.map(shown, argumentLine),
    ...(hidden > 0 ? [`• and ${hidden} more`] : []),
  ].join("\n");
}

/** The `input_required` answer that asks the coach to approve this call. */
export function approvalRequest(
  tool: ApprovalTool,
  input: JsonObject
): InputRequiredResult {
  return inputRequired({
    inputRequests: {
      [approvalKey(tool.name, input)]: inputRequired.elicit({
        message: approvalMessage(tool, input),
        requestedSchema: {
          type: "object",
          properties: {
            approve: {
              type: "boolean",
              title: "Approve this action",
              description: "Leave unchecked, or decline, to stop it.",
              default: false,
            },
          },
          required: ["approve"],
        },
      }),
    },
  });
}
