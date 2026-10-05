import type { McpServer } from "@modelcontextprotocol/server";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as R from "effect/Record";
import { assert, describe, expect, it, onTestFinished, vi } from "vitest";

import { LucaHttpError } from "../src/errors.ts";
import { LucaApi } from "../src/http.ts";
import type { LucaOperation } from "../src/operations.ts";
import { LUCA_OPERATIONS, operationById } from "../src/operations.ts";
import { LUCA_TASK_TOOLS } from "../src/task-tools.ts";
import { clearToolBuildCache } from "../src/tool-cache.ts";
import {
  fromOperation,
  fromTaskTool,
  registerTool,
  type ToolSurface,
} from "../src/tool.ts";
import { parseJsonRecord } from "./helpers.ts";

const stubLayer = Layer.succeed(LucaApi, {
  request: () => Effect.succeed({ ok: true }),
});

const failingLayer = Layer.succeed(LucaApi, {
  request: () =>
    Effect.fail(
      new LucaHttpError({
        status: 404,
        statusText: "Not Found",
        body: "not found",
      })
    ),
});

const throwingLayer = Layer.succeed(LucaApi, {
  request: () => {
    // oxlint-disable-next-line effect/avoid-untagged-errors -- a synchronous plain throw is the defect under test
    throw new Error("the request builder threw");
  },
});

function operationByToolName(toolName: string): LucaOperation {
  const operation = LUCA_OPERATIONS.find((item) => item.toolName === toolName);

  assert(operation, `Missing operation: ${toolName}`);

  return operation;
}

function taskToolByName(name: string) {
  const tool = LUCA_TASK_TOOLS.find((item) => item.name === name);

  assert(tool, `Missing task tool: ${name}`);

  return tool;
}

/**
 * Registers one tool against a server that keeps what it was handed instead of
 * serving it, so a test can read the config a client would receive and can call
 * the handler with arguments the MCP SDK would have rejected on its way in.
 */
function capture(
  tool: Parameters<typeof registerTool>[1],
  layer: Layer.Layer<LucaApi, never, never> = stubLayer,
  surface: ToolSurface = { toolset: "full" },
  signal: AbortSignal = new AbortController().signal
) {
  const registrations: {
    config: Record<string, unknown>;
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- The captured handler is the tool's own, so its types belong to the tool.
    handler: (input: unknown) => Promise<unknown>;
  }[] = [];

  // SAFETY: this fixture supplies only the one member registerTool calls.
  // oxlint-disable-next-line effect/avoid-any -- a partial McpServer fake; registerTool reads only registerTool
  const server = {
    registerTool: (
      _name: string,
      config: Record<string, unknown>,
      // oxlint-disable-next-line anti-slop/no-unknown-returns -- The captured handler is the tool's own, so its types belong to the tool.
      handler: (input: unknown, ctx: unknown) => Promise<unknown>
    ) => {
      // The SDK passes a request context with an abort signal on every call.
      registrations.push({
        config,
        handler: (input) =>
          handler(input, {
            mcpReq: { signal },
          }),
      });
    },
  } as unknown as McpServer;

  registerTool(server, tool, layer, surface);
  const registration = registrations[0];

  assert(registration, "Expected registerTool to install a handler");

  return registration;
}

function captureHandler(
  toolName: string,
  layer: Layer.Layer<LucaApi, never, never> = stubLayer,
  surface: ToolSurface = { toolset: "full" }
) {
  return capture(fromOperation(operationByToolName(toolName)), layer, surface)
    .handler;
}

describe("registerTool", () => {
  it("answers arguments that are not an object with a tool error", async () => {
    const handler = captureHandler("luca_leads_get");

    const result = await handler(42);

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Tool arguments must be a JSON object" }],
    });
  });

  it("still serves a well-formed call", async () => {
    const handler = captureHandler("luca_leads_get");

    const result = await handler({
      id: "00000000-0000-0000-0000-000000000000",
    });

    expect(result).toMatchObject({
      structuredContent: { result: { ok: true } },
    });
  });

  it("logs one mcp.tool.called line per call, carrying how it ended", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    onTestFinished(() => {
      spy.mockRestore();
    });

    await captureHandler("luca_leads_get")({
      id: "00000000-0000-0000-0000-000000000000",
    });
    await captureHandler("luca_leads_get", failingLayer, {
      toolset: "tasks",
    })({
      id: "00000000-0000-0000-0000-000000000000",
    });
    await captureHandler("luca_leads_get")(42);

    const lines = spy.mock.calls
      .map((call) => parseJsonRecord(String(call[0])))
      .filter((line) => line.event === "mcp.tool.called");

    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({
      toolName: "luca_leads_get",
      toolset: "full",
      outcome: "success",
    });
    expect(lines[1]).toMatchObject({ toolset: "tasks", outcome: "error" });
    expect(lines[2]).toMatchObject({ outcome: "error" });

    Arr.forEach(lines, (line) => {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Guards untrusted input at this module's I/O boundary.
      expect(typeof line.durationMs).toBe("number");
    });
  });

  it("builds a tool once per catalog entry, and again after the cache is cleared", () => {
    const operation = operationByToolName("luca_leads_list");

    const first = fromOperation(operation);
    expect(fromOperation(operation)).toBe(first);

    clearToolBuildCache();
    expect(fromOperation(operation)).not.toBe(first);

    const task = taskToolByName("luca_triage_inbox");
    const builtTask = fromTaskTool(task);
    expect(fromTaskTool(task)).toBe(builtTask);
  });

  it("calls a DELETE and an existing-resource POST destructive", () => {
    // Destructive describes the effect rather than the verb: an upsert can
    // overwrite an existing lead, and a client must see that before calling.
    expect(
      capture(fromOperation(operationByToolName("luca_leads_notes_delete")))
        .config.annotations
    ).toEqual({
      title: "Delete a lead note",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(
      capture(fromOperation(operationByToolName("luca_leads_create"))).config
        .annotations
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
    expect(
      capture(fromOperation(operationByToolName("luca_review_queue_reject")))
        .config.annotations
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
  });

  it("marks a task tool open-world when any operation it composes is", () => {
    const annotations = (name: string) =>
      capture(fromTaskTool(taskToolByName(name))).config.annotations;

    expect(annotations("luca_approve_and_send")).toMatchObject({
      openWorldHint: true,
    });
    expect(annotations("luca_find_leads")).toMatchObject({
      openWorldHint: false,
    });
  });

  it("claims no idempotency contract for a task tool", () => {
    // A task tool sends several requests, so no single key describes the call.
    // Booking composes a gated write, so the tool is destructive too.
    expect(
      capture(fromTaskTool(taskToolByName("luca_book_call"))).config.annotations
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
  });

  it("marks a task tool destructive when an ungated write it composes changes existing state", () => {
    // Pausing a cadence needs no confirm, but it stops one already running,
    // so the hint has to say so.
    expect(
      capture(fromTaskTool(taskToolByName("luca_pause_cadence"))).config
        .annotations
    ).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it("marks a task tool untrusted when its composed operation returns lead-derived text", async () => {
    const registration = capture(
      fromTaskTool(taskToolByName("luca_draft_reply"))
    );

    const result = await registration.handler({
      leadId: "00000000-0000-0000-0000-000000000000",
    });

    const content = result as {
      content: { type: string; text: string }[];
      structuredContent: { provenance?: { untrusted?: boolean } };
    };

    expect(content.structuredContent.provenance).toMatchObject({
      untrusted: true,
    });
    expect(content.content[0]?.text).toContain("[UNTRUSTED CONTENT]");
  });

  it("sends an outputSchema for task tools and operations alike", () => {
    const task = capture(fromTaskTool(taskToolByName("luca_book_call")));

    expect(task.config.outputSchema).toBeDefined();

    const operation = capture(
      fromOperation(operationByToolName("luca_leads_list"))
    );

    expect(operation.config.outputSchema).toBeDefined();
  });

  it("gates campaigns.setStatus only when the call resumes sends", async () => {
    const handler = captureHandler("luca_campaigns_set_status");
    const id = "00000000-0000-0000-0000-000000000000";

    const pause = await handler({ id, body: { status: "paused" } });
    const resume = await handler({ id, body: { status: "published" } });

    const confirmedResume = await handler({
      id,
      body: { status: "published" },
      confirm: true,
    });

    expect(pause).toMatchObject({
      structuredContent: { result: { ok: true } },
    });
    expect(resume).toMatchObject({
      isError: true,
      content: [
        {
          type: "text",
          text: "luca_campaigns_set_status: This tool requires confirm: true because it has a real-world side effect. Re-call the tool with confirm: true to proceed.",
        },
      ],
    });
    expect(confirmedResume).toMatchObject({
      structuredContent: { result: { ok: true } },
    });
  });

  it("names the condition in a conditionally gated tool's description", () => {
    const { config } = capture(
      fromOperation(operationById("campaigns.setStatus"))
    );

    expect(String(config.description)).toContain(
      "Destructive when status is published (resuming sends):"
    );
  });

  it("logs a thrown defect as a defect and a refused confirmation as an error", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    onTestFinished(() => {
      spy.mockRestore();
    });

    const defect = await captureHandler(
      "luca_leads_get",
      throwingLayer
    )({ id: "00000000-0000-0000-0000-000000000000" });

    const refused = await captureHandler("luca_broadcasts_launch")({
      id: "00000000-0000-0000-0000-000000000000",
    });

    expect(defect).toMatchObject({ isError: true });
    expect(refused).toMatchObject({ isError: true });

    const outcomes = spy.mock.calls
      .map((call) => parseJsonRecord(String(call[0])))
      .filter((line) => line.event === "mcp.tool.called")
      .map((line) => line.outcome);

    expect(outcomes).toEqual(["defect", "error"]);

    const gateRejections = spy.mock.calls
      .map((call) => parseJsonRecord(String(call[0])))
      .filter((line) => line.event === "mcp.write_gate.rejected");

    expect(gateRejections).toEqual([
      expect.objectContaining({ toolName: "luca_broadcasts_launch" }),
    ]);
  });

  it("logs a call the client cancels as interrupted", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    onTestFinished(() => {
      spy.mockRestore();
    });

    const controller = new AbortController();

    const hangingLayer = Layer.succeed(LucaApi, {
      request: () => Effect.never,
    });

    const { handler } = capture(
      fromOperation(operationByToolName("luca_leads_get")),
      hangingLayer,
      { toolset: "full" },
      controller.signal
    );

    const call = handler({ id: "00000000-0000-0000-0000-000000000000" });
    controller.abort();
    await call.catch(() => undefined);

    const lines = spy.mock.calls
      .map((line) => parseJsonRecord(String(line[0])))
      .filter((line) => line.event === "mcp.tool.called");

    expect(lines).toEqual([
      expect.objectContaining({
        toolName: "luca_leads_get",
        outcome: "interrupted",
      }),
    ]);
  });
});

function failingWith(status: number, body: unknown) {
  return Layer.succeed(LucaApi, {
    request: () =>
      Effect.fail(
        new LucaHttpError({
          status,
          statusText: "Error",
          // SAFETY: test bodies are plain JSON literals.
          body: body as never,
        })
      ),
  });
}

const RESOURCE_METADATA_URL =
  "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";

const remoteSurface: ToolSurface = {
  toolset: "full",
  resourceMetadataUrl: RESOURCE_METADATA_URL,
};

describe("tool auth metadata", () => {
  it("pins the OAuth scope every tool asks for", () => {
    // A scope change alters what a coach must grant before a tool works, so
    // it has to show up in review as a deliberate snapshot update.
    const scopes = R.fromEntries(
      [
        ...LUCA_OPERATIONS.map(fromOperation),
        ...LUCA_TASK_TOOLS.map(fromTaskTool),
      ].map((tool) => [tool.name, tool.oauthScope])
    );

    expect(scopes).toMatchSnapshot();
  });

  it("declares the least-privilege OAuth scope in securitySchemes", () => {
    const scopesOf = (tool: Parameters<typeof registerTool>[1]) =>
      capture(tool).config._meta;

    expect(
      scopesOf(fromOperation(operationByToolName("luca_leads_get")))
    ).toEqual({ securitySchemes: [{ type: "oauth2", scopes: ["luca:read"] }] });
    expect(
      scopesOf(fromOperation(operationByToolName("luca_leads_notes_add")))
    ).toEqual({
      securitySchemes: [{ type: "oauth2", scopes: ["luca:draft"] }],
    });
    expect(
      scopesOf(fromOperation(operationByToolName("luca_conversations_send")))
    ).toEqual({
      securitySchemes: [{ type: "oauth2", scopes: ["luca:queue_ops"] }],
    });
    // Webhook writes need webhooks:write, which only luca:full grants, even
    // though the capability tier alone would allow queue_ops.
    expect(
      scopesOf(
        fromOperation(operationByToolName("luca_webhooks_subscriptions_create"))
      )
    ).toEqual({ securitySchemes: [{ type: "oauth2", scopes: ["luca:full"] }] });
  });

  it("gives a task tool the highest scope among the operations it composes", () => {
    const tool = fromTaskTool(taskToolByName("luca_approve_and_send"));

    expect(tool.oauthScope).toBe("luca:queue_ops");
    expect(fromTaskTool(taskToolByName("luca_find_leads")).oauthScope).toBe(
      "luca:read"
    );
  });

  it("asks the client to re-authorize when the API rejects the token", async () => {
    const result = await captureHandler(
      "luca_leads_get",
      failingWith(401, { error: { code: "unauthorized", message: "no" } }),
      remoteSurface
    )({ id: "00000000-0000-0000-0000-000000000000" });

    expect(result).toMatchObject({
      isError: true,
      _meta: {
        "mcp/www_authenticate": [
          `Bearer realm="luca-mcp", resource_metadata="${RESOURCE_METADATA_URL}", error="invalid_token", error_description="The access token is invalid or expired"`,
        ],
      },
    });
  });

  it("asks for a broader scope when the API says one is missing", async () => {
    const call = (code: string) =>
      captureHandler(
        "luca_conversations_send",
        failingWith(403, { error: { code, message: "no" } }),
        remoteSurface
      )({
        id: "00000000-0000-0000-0000-000000000000",
        text: "hi",
        confirm: true,
      });

    await Promise.all(
      ["scope_required", "needs_scope"].map(async (code) => {
        expect(await call(code)).toMatchObject({
          _meta: {
            "mcp/www_authenticate": [
              expect.stringContaining(
                'error="insufficient_scope", error_description="The connection\'s scopes do not cover this tool", scope="luca:queue_ops"'
              ),
            ],
          },
        });
      })
    );
  });

  it("adds no challenge for a 403 re-authorizing cannot fix, or without a metadata URL", async () => {
    const forbidden = await captureHandler(
      "luca_leads_get",
      failingWith(403, { error: { code: "plan_limit", message: "no" } }),
      remoteSurface
    )({ id: "00000000-0000-0000-0000-000000000000" });

    const overStdio = await captureHandler(
      "luca_leads_get",
      failingWith(401, { error: { code: "unauthorized", message: "no" } })
    )({ id: "00000000-0000-0000-0000-000000000000" });

    expect(forbidden).toMatchObject({ isError: true });
    expect(forbidden).not.toHaveProperty("_meta");
    expect(overStdio).toMatchObject({ isError: true });
    expect(overStdio).not.toHaveProperty("_meta");
  });
});
