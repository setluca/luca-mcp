import type { McpServer } from "@modelcontextprotocol/server";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  formatError,
  LucaConfirmationRequired,
  type LucaError,
  LucaToolInputError,
} from "./errors.ts";
import { LucaApi } from "./http.ts";
import { authChallengeMeta } from "./oauth-challenge.ts";
import { logAgentSurfaceEvent } from "./observability.ts";
import type { ToolFields } from "./openapi-schema.ts";
import {
  type LucaOperation,
  type LucaToolInput,
  needsConfirmation,
  operationById,
} from "./operations.ts";
import { optionalField } from "./optional-field.ts";
import { paginatedProgram } from "./pagination.ts";
import { provenanceFields, UNTRUSTED_CONTENT_NOTE } from "./provenance.ts";
import { JsonObject, type JsonValue, toJsonText } from "./serialization.ts";
import { toolInputSchema, toolSchema } from "./standard-schema.ts";
import { taskRequest } from "./task-tools/runtime.ts";
import { buildCache } from "./tool-cache.ts";
import {
  type ToolProfile,
  toolProfile,
  type ToolSource,
} from "./tool-profile.ts";

/**
 * How a tool reaches an MCP client and runs, for both kinds of Luca tool.
 *
 * What a client is told about a tool comes from `tool-profile.ts`. What
 * happens here is the same work on both kinds, so it happens once: the
 * confirmation gate, the untrusted-content wrapper, the error result, the call
 * log. Only {@link toolProgram} tells the two kinds apart, because only the
 * call itself differs.
 */

/**
 * The Standard Schema objects are cached on the identity of the fields they
 * render, because the Worker builds a fresh server per request. See
 * `tool-cache.ts` for what that buys and how a test empties it.
 */
const inputSchemas = buildCache<
  ToolFields,
  ReturnType<typeof toolInputSchema>
>();

const outputSchemas = buildCache<ToolFields, ReturnType<typeof toolSchema>>();

/**
 * A tool's fields as one Standard Schema object, built once per fields object.
 * Building one renders its JSON Schema, which is the expensive part. Inputs and
 * outputs are cached apart because only an input refuses undeclared keys.
 */
function inputObjectSchema(fields: ToolFields) {
  return inputSchemas.get(fields, () => toolInputSchema(fields));
}

function outputObjectSchema(fields: ToolFields) {
  return outputSchemas.get(fields, () => toolSchema(fields));
}

/**
 * The Effect program one call to a tool runs, with the `LucaApi` requirement
 * still open. The pipeline provides the layer in one place, so a tool body
 * never carries a client.
 */
export function toolProgram(
  source: ToolSource,
  input: JsonObject
): Effect.Effect<JsonValue, LucaError, LucaApi> {
  if (source.kind === "operation") {
    return operationProgram(source, input);
  }

  return source.run(
    (id, parts) =>
      Effect.flatMap(LucaApi, (api) =>
        api.request(taskRequest(operationById(id), input, parts))
      ),
    input
  );
}

/**
 * What the server registering a tool knows and the tool does not. The same
 * `LucaOperation` serves both toolsets and both transports, so a tool has no
 * business claiming to know which one registered it.
 */
export type ToolSurface = {
  /** The toolset that registered the tool, for the call log. */
  readonly toolset: string;
  /**
   * The remote Worker's RFC 9728 protected-resource metadata URL. Present, it
   * turns an auth failure into a re-authorization challenge; see
   * `oauth-challenge.ts`. Absent over stdio.
   */
  readonly resourceMetadataUrl?: string;
};

export function registerTool(
  server: McpServer,
  source: ToolSource,
  lucaLayer: Layer.Layer<LucaApi, LucaError, never>,
  surface: ToolSurface
) {
  const tool = toolProfile(source);

  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: inputObjectSchema(tool.inputSchema),
      outputSchema: outputObjectSchema(tool.outputSchema),
      annotations: tool.annotations,
      // ChatGPT reads this to know a tool needs a linked account, and which
      // scope to ask for when it does.
      _meta: {
        securitySchemes: [{ type: "oauth2", scopes: [tool.oauthScope] }],
      },
    },
    // The client's cancellation interrupts the program, which aborts the
    // request it has in flight.
    (input, ctx) =>
      Effect.runPromise(toolResult(source, lucaLayer, surface, input), {
        signal: ctx.mcpReq.signal,
      })
  );
}

/**
 * The call's arguments as a JSON object, failing into the error channel rather
 * than throwing. The SDK validates against the tool's own input schema before
 * the handler runs, so a real client never lands here; the point is that no
 * code ahead of `runPromise` can throw where the error channel cannot see it.
 */
const decodeToolInput = Schema.decodeUnknownEffect(JsonObject);

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the SDK hands over the arguments its own schema decoded, typed loosely; this is where they become a JSON object.
function parseToolInput(input: unknown) {
  return decodeToolInput(input).pipe(
    Effect.mapError(
      () =>
        new LucaToolInputError({
          message: "Tool arguments must be a JSON object",
        })
    )
  );
}

/**
 * How a tool call ended. `error` covers everything the error channel carries:
 * a refused confirmation, unreadable arguments, a failed request. `defect` is
 * a throw that escaped it, which is a bug in this server rather than in the
 * call. `interrupted` is a call the client cancelled, logged by `onInterrupt`
 * because a cancelled program never reaches `settle`.
 */
type ToolOutcome = "success" | "error" | "defect" | "interrupted";

/**
 * A tool call's result, confirmation gate included. Every way the call can end
 * leaves as a tool result, so nothing reaches the transport as an unhandled
 * rejection, and every way logs exactly one line.
 */
function toolResult(
  source: ToolSource,
  lucaLayer: Layer.Layer<LucaApi, LucaError, never>,
  surface: ToolSurface,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- input is the same raw MCP JSON-RPC tool-call arguments registerTool's server.registerTool callback hands in; parseToolInput below is what actually validates it.
  input: unknown
) {
  const tool = toolProfile(source);

  const logCall = (outcome: ToolOutcome, elapsed?: Duration.Duration) =>
    // A defect's own message never lands here or in the tool result: it can
    // carry arbitrary thrown text derived from the call's input.
    logAgentSurfaceEvent("mcp.tool.called", {
      toolName: tool.name,
      toolset: surface.toolset,
      outcome,
      durationMs:
        elapsed === undefined
          ? undefined
          : Math.round(Duration.toMillis(elapsed)),
    });

  return parseToolInput(input).pipe(
    Effect.flatMap(
      (
        parsed
      ): Effect.Effect<
        JsonValue,
        LucaError | LucaConfirmationRequired,
        LucaApi
      > =>
        needsConfirmation(tool.confirm, parsed) && parsed.confirm !== true
          ? Effect.fail(new LucaConfirmationRequired({ toolName: tool.name }))
          : toolProgram(source, parsed)
    ),
    Effect.provide(lucaLayer),
    Effect.exit,
    Effect.timed,
    Effect.map(([elapsed, exit]) => {
      const [outcome, result] = settle(tool, surface, exit);
      logCall(outcome, elapsed);

      return result;
    }),
    // A cancellation from the client stops the program before the exit above
    // is read, so it is logged on the way out instead.
    Effect.onInterrupt(() => Effect.sync(() => logCall("interrupted")))
  );
}

/** A finished call as the outcome it logs and the result the client gets. */
function settle(
  tool: ToolProfile,
  surface: ToolSurface,
  exit: Exit.Exit<JsonValue, LucaError | LucaConfirmationRequired>
): readonly [ToolOutcome, ToolCallResult] {
  if (Exit.isSuccess(exit)) {
    return ["success", asSuccessResult(tool, exit.value)];
  }

  const { cause } = exit;
  const error = Cause.findErrorOption(cause);

  if (Option.isSome(error)) {
    const failure = error.value;

    if (failure instanceof LucaConfirmationRequired) {
      logAgentSurfaceEvent("mcp.write_gate.rejected", { toolName: tool.name });

      return ["error", confirmationError(tool.name)];
    }

    return [
      "error",
      asErrorResult(
        failure,
        authChallengeMeta(failure, tool.oauthScope, surface.resourceMetadataUrl)
      ),
    ];
  }

  return [
    "defect",
    // A defect may include request data or credentials in its message. Keep
    // the protocol error generic and record only the defect outcome in logs.
    asErrorResult("Unexpected Luca MCP tool failure"),
  ];
}

/** Every result a tool call can end in. */
type ToolCallResult =
  | ToolErrorResult
  | ReturnType<typeof confirmationError>
  | ReturnType<typeof asSuccessResult>;

const POSSIBLE_REDACTION_NOTE =
  "If this connection has redacted content access, Luca may blank lead names, messages, and draft text. A blank sensitive field may mean unavailable; do not claim the underlying record is empty.";

/** The Effect program that runs an operation, auto-paginating list tools. */
export function operationProgram(
  operation: LucaOperation,
  toolInput: LucaToolInput
) {
  const baseRequest = operation.buildRequest(toolInput);
  const { pageContract } = operation;

  if (pageContract) {
    return paginatedProgram(
      operation,
      pageContract,
      baseRequest,
      toolInput.maxPages
    );
  }

  // An operation with no page shape has no pagination to follow, so it is one
  // request, sent as-is.
  return Effect.gen(function* () {
    const api = yield* LucaApi;

    return yield* api.request({ operation, ...baseRequest });
  });
}

/**
 * A tool's successful result. A response that can carry external-user text is
 * flagged untrusted on both halves, the structured `provenance.untrusted`
 * field that a lead cannot spoof and a human-facing preamble on the text, so a
 * downstream agent treats embedded text as data, not instructions. What the
 * structured half attaches is `provenanceFields`, shared with the resource
 * reads in `server.ts`.
 */
function asSuccessResult(
  tool: Pick<ToolProfile, "untrustedContent">,
  result: JsonValue
) {
  const text = toJsonText(result);

  return {
    content: [
      {
        type: "text" as const,
        text: tool.untrustedContent
          ? `[UNTRUSTED CONTENT] ${UNTRUSTED_CONTENT_NOTE}\n[POSSIBLE REDACTION] ${POSSIBLE_REDACTION_NOTE}\n\n${text}`
          : text,
      },
    ],
    structuredContent: {
      result,
      ...provenanceFields(tool.untrustedContent),
    },
  };
}

/**
 * A failed call's tool result. `_meta` carries the re-authorization challenge
 * when there is one; see `oauth-challenge.ts`.
 */
type ToolErrorResult = {
  readonly isError: true;
  readonly content: { readonly type: "text"; readonly text: string }[];
  readonly _meta?: Record<string, readonly string[]>;
};

function asErrorResult(
  error: LucaError | Error | string,
  meta?: Record<string, readonly string[]>
): ToolErrorResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: formatError(error),
      },
    ],
    ...optionalField("_meta", meta),
  };
}

function confirmationError(toolName: string) {
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: `${toolName}: This tool requires confirm: true because it has a real-world side effect. Re-call the tool with confirm: true to proceed.`,
      },
    ],
    structuredContent: {
      error: {
        code: "confirmation_required",
        toolName,
        requiredArgument: "confirm",
      },
    },
  };
}
