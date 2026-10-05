import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { assert, describe, expect, it, onTestFinished, vi } from "vitest";

import { LucaNetworkError } from "../src/errors.ts";
import type { LucaRequest } from "../src/http.ts";
import type { LucaPrompt } from "../src/prompts.ts";
import { provenanceFields } from "../src/provenance.ts";
import type { JsonValueInput } from "../src/serialization.ts";
import { LUCA_SERVER_INFO, registerPrompts } from "../src/server.ts";
import { LUCA_MCP_VERSION } from "../src/version.ts";
import { connect, parseJsonRecord } from "./helpers.ts";

type BookingPageFixture = {
  bookings?: number[];
  nextCursor: string | null;
  total?: number;
};

type BookingPageFixtures = Record<string, BookingPageFixture>;

type JsonPageFixtures = Record<string, JsonValueInput>;

function bookingPage(
  pages: BookingPageFixtures,
  cursor: string
): BookingPageFixture | undefined {
  return pages[cursor];
}

function jsonPage(pages: JsonPageFixtures, cursor: string): JsonValueInput {
  return pages[cursor];
}

function loggedEvents(logSpy: ReturnType<typeof vi.spyOn>, event: string) {
  return logSpy.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((line: string) => line.includes(event))
    .map((line: string) => parseJsonRecord(line));
}

const decodeManifestLinks = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ apiDocs: Schema.String, openApi: Schema.String })
  )
);

describe("operationDescription", () => {
  it("composes every optional line when idempotency and confirmation are both required", async () => {
    const { client, close } = await connect(() => Effect.succeed({}));

    onTestFinished(close);

    const tools = await client.listTools();

    const approve = tools.tools.find(
      (tool) => tool.name === "luca_review_queue_approve"
    );

    expect(approve?.description).toBe(
      [
        "Approve a pending draft for sending; dispatches through the lead's channel. Sends a real message.",
        "",
        "Luca operation: POST /api/review-queue/{id}/approve",
        "Required scopes: review_queue:write",
        "Required OAuth scope: luca:queue_ops; data sensitivity: redacted",
        "Requires Idempotency-Key. Provide idempotencyKey for safe retries, or the server will generate one.",
        "Destructive: has a real-world side effect. You must pass confirm: true; the call is rejected without it.",
        "Use workspaceId or workspaceSlug to override the default workspace configured by environment.",
      ].join("\n")
    );
  }, 15_000);

  it("drops the confirmation line and joins multiple scopes with a comma when neither is required", async () => {
    const { client, close } = await connect(() => Effect.succeed({}));

    onTestFinished(close);

    const tools = await client.listTools();

    const capabilities = tools.tools.find(
      (tool) => tool.name === "luca_capabilities_get"
    );

    expect(capabilities?.description).toBe(
      [
        "Describe Luca's public API capabilities, scopes, and boundaries.",
        "",
        "Luca operation: GET /api/capabilities",
        "Required scopes: leads:read, conversations:read, bookings:read, campaigns:read, broadcasts:read, webhooks:read, integrations:read",
        "Required OAuth scope: luca:read; data sensitivity: redacted",
        "Does not require idempotency.",
        "Use workspaceId or workspaceSlug to override the default workspace configured by environment.",
      ].join("\n")
    );
    // No stray "undefined" from the dropped confirmation line, and no
    // trailing blank line where it would have sat.
    expect(capabilities?.description).not.toContain("undefined");
  }, 15_000);
});

describe("confirmation gate message", () => {
  it("returns the exact toolName-prefixed confirmation-required text", async () => {
    const { client, close } = await connect(() =>
      Effect.succeed({ launched: true })
    );

    onTestFinished(close);

    const result = await client.callTool({
      name: "luca_broadcasts_launch",
      arguments: { id: "00000000-0000-0000-0000-000000000000" },
    });

    expect(result.content).toEqual([
      {
        type: "text",
        text: "luca_broadcasts_launch: This tool requires confirm: true because it has a real-world side effect. Re-call the tool with confirm: true to proceed.",
      },
    ]);
  });
});

describe("server identity", () => {
  // The other suites assert `toEqual(LUCA_SERVER_INFO)` to prove the wire
  // identity and the Worker's server card cannot drift apart. That comparison
  // stays true no matter what the constant says, so the literal values are
  // pinned here once.
  it("announces every identity field a client renders, with exact values", () => {
    expect(LUCA_SERVER_INFO).toEqual({
      name: "luca-mcp",
      title: "Luca",
      // Compared against the constant, not a literal: the point is that the
      // server card reads the shared version rather than re-hardcoding one,
      // which is how server.ts and http.ts drifted apart before.
      version: LUCA_MCP_VERSION,
      description:
        "Luca is the DM sales platform for coaches, creators, and experts who sell through DMs. Manage leads, conversations, drafts, campaigns, broadcasts, and bookings across Instagram, Messenger, WhatsApp, and Telegram.",
      websiteUrl: "https://setluca.com",
      icons: [
        {
          src: "https://setluca.com/favicon.svg?v=wordmark-1",
          mimeType: "image/svg+xml",
        },
        {
          src: "https://setluca.com/android-chrome-512x512.png?v=wordmark-1",
          mimeType: "image/png",
          sizes: ["512x512"],
        },
      ],
    });
  });
});

/** The frame `luca_bookings_list` carries: a booking can hold lead-written text. */
const BOOKINGS_PROVENANCE = provenanceFields(true);

describe("pagination helpers via the public tool surface", () => {
  it("returns the raw page untouched when it has no nextCursor field at all", async () => {
    const { client, close } = await connect(() =>
      Effect.succeed({ bookings: [1, 2, 3] })
    );

    onTestFinished(close);

    const result = await client.callTool({
      name: "luca_bookings_list",
      arguments: {},
    });

    expect(result.structuredContent).toEqual({
      ...BOOKINGS_PROVENANCE,
      result: { bookings: [1, 2, 3] },
    });
  });

  it("excludes nextCursor from item-key candidates even when nextCursor is itself array-shaped", async () => {
    const { client, close } = await connect(() =>
      Effect.succeed({
        nextCursor: ["not-a-cursor-string"],
        bookings: [1, 2, 3],
      })
    );

    onTestFinished(close);

    const result = await client.callTool({
      name: "luca_bookings_list",
      arguments: {},
    });

    // A single real array field ("bookings") is unambiguous, so the tool
    // still recognizes the page as paginatable and aggregates it — the
    // array-shaped nextCursor never gets confused for the items key.
    expect(result.structuredContent).toEqual({
      ...BOOKINGS_PROVENANCE,
      result: {
        bookings: [1, 2, 3],
        pagination: { pagesFetched: 1, truncated: false, nextCursor: null },
      },
    });
  });

  it("returns a page with no array to merge without looping", async () => {
    const requests: LucaRequest[] = [];
    const page = { nextCursor: "c1", total: 7 };

    const { client, close } = await connect((request) => {
      requests.push(request);

      return Effect.succeed(page);
    });

    onTestFinished(close);

    const result = await client.callTool({
      name: "luca_bookings_list",
      arguments: {},
    });

    expect(result.structuredContent).toEqual({
      result: page,
      ...BOOKINGS_PROVENANCE,
    });
    // Nothing to aggregate means the tool stops rather than following the
    // (real) cursor into a shape it cannot merge.
    expect(requests).toHaveLength(1);
  });

  it("stops pagination when nextCursor is an empty string, not a real cursor", async () => {
    const requests: LucaRequest[] = [];

    const { client, close } = await connect((request) => {
      requests.push(request);

      return Effect.succeed({ bookings: [1], nextCursor: "" });
    });

    onTestFinished(close);

    const result = await client.callTool({
      name: "luca_bookings_list",
      arguments: {},
    });

    expect(result.structuredContent).toEqual({
      ...BOOKINGS_PROVENANCE,
      result: {
        bookings: [1],
        pagination: { pagesFetched: 1, truncated: false, nextCursor: null },
      },
    });
    expect(requests).toHaveLength(1);
  });

  it("merges the caller's original query params with cursor on subsequent pages", async () => {
    const requests: LucaRequest[] = [];

    const pages = {
      start: { bookings: [1], nextCursor: "c1" },
      c1: { bookings: [2], nextCursor: null },
    } satisfies BookingPageFixtures;

    const { client, close } = await connect((request) => {
      requests.push(request);
      const cursor = (request.query?.cursor as string | undefined) ?? "start";

      return Effect.succeed(bookingPage(pages, cursor));
    });

    onTestFinished(close);

    const result = await client.callTool({
      name: "luca_bookings_list",
      arguments: { query: { limit: 1 } },
    });

    expect(result.structuredContent).toEqual({
      ...BOOKINGS_PROVENANCE,
      result: {
        bookings: [1, 2],
        pagination: { pagesFetched: 2, truncated: false, nextCursor: null },
      },
    });
    expect(requests[0]?.query).toEqual({ limit: 1 });
    // The original query field survives onto the follow-up request
    // alongside cursor — it is merged in, not replaced by it.
    expect(requests[1]?.query).toEqual({ limit: 1, cursor: "c1" });
  });

  it("ends the walk at a later page that leaves nextCursor out", async () => {
    // A missing cursor reads the same as a null one: there is no next page.
    const pages = {
      start: { bookings: [1], nextCursor: "c1" },
      c1: { bookings: [3] },
    } satisfies JsonPageFixtures;

    const { client, close } = await connect((request) => {
      const cursor = (request.query?.cursor as string | undefined) ?? "start";

      return Effect.succeed(jsonPage(pages, cursor));
    });

    onTestFinished(close);

    const result = await client.callTool({
      name: "luca_bookings_list",
      arguments: {},
    });

    expect(result.structuredContent).toEqual({
      ...BOOKINGS_PROVENANCE,
      result: {
        bookings: [1, 3],
        pagination: { pagesFetched: 2, truncated: false, nextCursor: null },
      },
    });
  });

  it("keeps every non-item, non-cursor first-page field and drops none of them under mutation", async () => {
    const pages = {
      start: { bookings: [1, 2], nextCursor: "c1", total: 7 },
      c1: { bookings: [3], nextCursor: null },
    } satisfies BookingPageFixtures;

    const { client, close } = await connect((request) => {
      const cursor = (request.query?.cursor as string | undefined) ?? "start";

      return Effect.succeed(bookingPage(pages, cursor));
    });

    onTestFinished(close);

    const result = await client.callTool({
      name: "luca_bookings_list",
      arguments: {},
    });

    // Exactly total + merged bookings + pagination — no leaked nextCursor,
    // no duplicated/overwritten bookings key.
    expect(result.structuredContent).toEqual({
      ...BOOKINGS_PROVENANCE,
      result: {
        total: 7,
        bookings: [1, 2, 3],
        pagination: { pagesFetched: 2, truncated: false, nextCursor: null },
      },
    });
  });

  // A later page can come back in a shape the walk cannot read at all. Each of
  // these stops the walk where it stands and reports the result as truncated,
  // handing the client back the cursor that led to the unreadable page.
  const unreadablePages: [string, JsonValueInput][] = [
    ["a bare string instead of an object", "not-a-page"],
    ["a null body", null],
    ["an object carrying no items array", { nextCursor: "c2" }],
  ];

  it.each(unreadablePages)(
    "halts the walk and reports truncation when a later page is %s",
    async (_label, secondPage) => {
      const requests: LucaRequest[] = [];

      const { client, close } = await connect((request) => {
        requests.push(request);

        return Effect.succeed(
          request.query?.cursor === undefined
            ? { bookings: [1], nextCursor: "c1" }
            : secondPage
        );
      });

      onTestFinished(close);

      const result = await client.callTool({
        name: "luca_bookings_list",
        arguments: {},
      });

      expect(result.structuredContent).toEqual({
        ...BOOKINGS_PROVENANCE,
        result: {
          bookings: [1],
          pagination: {
            pagesFetched: 1,
            truncated: true,
            nextCursor: "c1",
            error: "unreadable_page",
          },
          warning: expect.stringContaining("INCOMPLETE LIST: page 2"),
        },
      });
      expect(requests).toHaveLength(2);
    }
  );

  it("keeps using the first page's items key when a later page's own shape is ambiguous", async () => {
    const pages = {
      start: { bookings: [1], nextCursor: "c1" },
      // Two array fields make this page's own items key unidentifiable, so the
      // walk falls back to the key the first page established.
      c1: { bookings: [2], tags: ["a"], nextCursor: null },
    } satisfies JsonPageFixtures;

    const { client, close } = await connect((request) =>
      Effect.succeed(
        jsonPage(pages, (request.query?.cursor as string) ?? "start")
      )
    );

    onTestFinished(close);

    const result = await client.callTool({
      name: "luca_bookings_list",
      arguments: {},
    });

    expect(result.structuredContent).toEqual({
      ...BOOKINGS_PROVENANCE,
      result: {
        bookings: [1, 2],
        pagination: { pagesFetched: 2, truncated: false, nextCursor: null },
      },
    });
  });

  it("does not log a truncation event when pagination completes without truncation", async () => {
    const pages = {
      start: { bookings: [1], nextCursor: "c1" },
      c1: { bookings: [2], nextCursor: null },
    } satisfies BookingPageFixtures;

    const { client, close } = await connect((request) => {
      const cursor = (request.query?.cursor as string | undefined) ?? "start";

      return Effect.succeed(bookingPage(pages, cursor));
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    onTestFinished(async () => {
      logSpy.mockRestore();
      await close();
    });

    const result = await client.callTool({
      name: "luca_bookings_list",
      arguments: {},
    });

    expect(result.structuredContent).toEqual({
      ...BOOKINGS_PROVENANCE,
      result: {
        bookings: [1, 2],
        pagination: { pagesFetched: 2, truncated: false, nextCursor: null },
      },
    });
    expect(loggedEvents(logSpy, "mcp.pagination.truncated")).toHaveLength(0);
  });
});

/**
 * `mcp.explain` belongs to the triage fan-out alone. The single-route explain
 * tools already report their name and outcome through `mcp.tool.called`, so a
 * second line from them would double-count every explanation in a dashboard.
 */
describe("mcp.explain emission boundary", () => {
  it("logs mcp.tool.called and no mcp.explain for the single-route explain tool", async () => {
    const { client, close } = await connect(() =>
      Effect.succeed({ explanation: "why" })
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    onTestFinished(async () => {
      logSpy.mockRestore();
      await close();
    });

    await client.callTool({
      name: "luca_review_queue_explain",
      arguments: { id: "11111111-1111-4111-8111-111111111111" },
    });

    const called = loggedEvents(logSpy, "mcp.tool.called");
    expect(called).toHaveLength(1);
    expect(called[0]?.toolName).toBe("luca_review_queue_explain");
    expect(loggedEvents(logSpy, "mcp.explain")).toHaveLength(0);
  });

  it("logs both lines for the triage fan-out, one tool call and one explain summary", async () => {
    const { client, close } = await connect((request: LucaRequest) =>
      Effect.succeed(
        request.operation.id === "reviewQueue.list"
          ? { items: [{ id: "11111111-1111-4111-8111-111111111111" }] }
          : { explanation: "why" }
      )
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    onTestFinished(async () => {
      logSpy.mockRestore();
      await close();
    });

    await client.callTool({
      name: "luca_triage_inbox",
      arguments: { explainTop: 1 },
    });

    expect(loggedEvents(logSpy, "mcp.tool.called")).toHaveLength(1);
    const explain = loggedEvents(logSpy, "mcp.explain");
    expect(explain).toHaveLength(1);
    expect(explain[0]).toMatchObject({
      toolName: "luca_triage_inbox",
      requested: 1,
      explained: 1,
      failed: 0,
    });
  });

  it("still reports the tool call as a success when every explanation fails", async () => {
    // This is the whole reason the event exists: mcp.tool.called cannot tell
    // a healthy fan-out from one where nothing was explained.
    const { client, close } = await connect((request: LucaRequest) =>
      request.operation.id === "reviewQueue.list"
        ? Effect.succeed({
            items: [{ id: "11111111-1111-4111-8111-111111111111" }],
          })
        : Effect.fail(
            new LucaNetworkError({
              message: "explain is down",
            })
          )
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    onTestFinished(async () => {
      logSpy.mockRestore();
      await close();
    });

    const result = await client.callTool({
      name: "luca_triage_inbox",
      arguments: { explainTop: 1 },
    });

    expect(result.isError).toBeFalsy();
    expect(loggedEvents(logSpy, "mcp.tool.called")[0]?.outcome).toBe("success");
    expect(loggedEvents(logSpy, "mcp.explain")[0]).toMatchObject({
      requested: 1,
      explained: 0,
      failed: 1,
    });
  });
});

describe("task tool annotations", () => {
  it("annotates a read-only task tool with the exact hint set, including openWorldHint", async () => {
    const { client, close } = await connect(() => Effect.succeed({}));

    onTestFinished(close);

    const tools = await client.listTools();

    const triage = tools.tools.find(
      (tool) => tool.name === "luca_triage_inbox"
    );

    expect(triage?.annotations).toEqual({
      title: "Triage the review queue",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  }, 15_000);
});

describe("task tool defects", () => {
  it("answers with an error result when the underlying call throws instead of failing", async () => {
    const { client, close } = await connect(() => {
      // A synchronous throw is a defect, not a typed failure: it bypasses the
      // error channel entirely and would otherwise escape as a transport-level
      // crash rather than a tool result the client can read.
      // oxlint-disable-next-line effect/avoid-untagged-errors -- a synchronous plain throw is the defect under test
      throw new Error("api client blew up");
    });

    onTestFinished(close);

    const result = await client.callTool({
      name: "luca_triage_inbox",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "api client blew up" },
    ]);
  }, 15_000);
});

describe("resource registration metadata", () => {
  it("logs the resource read event with the resource's own name", async () => {
    const { client, close } = await connect((request) =>
      request.operation.id === "reviewQueue.list"
        ? Effect.succeed({ items: [], nextCursor: null })
        : Effect.succeed({ id: "x" })
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    onTestFinished(async () => {
      logSpy.mockRestore();
      await close();
    });

    await client.readResource({
      uri: "luca://lead/00000000-0000-0000-0000-000000000000",
    });
    const events = loggedEvents(logSpy, "mcp.resources.read");
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      msg: "mcp.agent_surface",
      event: "mcp.resources.read",
      resourceType: "luca-lead",
    });
  });

  it("registers a template-backed resource's title, description, and mimeType exactly", async () => {
    const { client, close } = await connect(() => Effect.succeed({ ok: true }));

    onTestFinished(close);

    const resources = await client.listResources();

    const queue = resources.resources.find(
      (resource) => resource.uri === "luca://queue/today"
    );

    expect(queue).toEqual(
      expect.objectContaining({
        name: "luca-queue-today",
        title: "Luca review queue (today)",
        description:
          "The current pending review queue: drafts awaiting the coach's approval. Reuses the pipeline's persisted triage; does not re-run it.",
        mimeType: "application/json",
      })
    );
  });

  it("registers the operations manifest resource's title, description, and mimeType exactly", async () => {
    const { client, close } = await connect(() => Effect.succeed({ ok: true }));

    onTestFinished(close);

    const resources = await client.listResources();

    const manifest = resources.resources.find(
      (resource) => resource.uri === "luca://operations"
    );

    expect(manifest).toEqual(
      expect.objectContaining({
        name: "luca-public-operations",
        title: "Luca Public API Operations",
        description:
          "MCP operation manifest derived from Luca's public API key policy.",
        mimeType: "application/json",
      })
    );
  });

  it("includes the exact apiDocs and openApi links in the operations manifest body", async () => {
    const { client, close } = await connect(() => Effect.succeed({ ok: true }));

    onTestFinished(close);

    const resource = await client.readResource({ uri: "luca://operations" });
    const content = resource.contents[0];

    assert(content && "text" in content, "expected text content");

    const manifest = decodeManifestLinks(content.text);

    expect(manifest.apiDocs).toBe("https://api.setluca.com/docs");
    expect(manifest.openApi).toBe("https://api.setluca.com/openapi.json");
  });
});

describe("prompt registration", () => {
  it("registers the planner prompt's exact title, description, and task-arg description", async () => {
    const { client, close } = await connect(() => Effect.succeed({ ok: true }));

    onTestFinished(close);

    const prompts = await client.listPrompts();

    const planner = prompts.prompts.find(
      (prompt) => prompt.name === "luca-api-planner"
    );

    expect(planner?.title).toBe("Luca API Planner");
    expect(planner?.description).toBe(
      "Plan a Luca API workflow using the MCP tools, scopes, and idempotency rules."
    );
    expect(planner?.arguments).toEqual([
      expect.objectContaining({
        name: "task",
        description: "The Luca API workflow the user wants to perform.",
      }),
    ]);
  });

  it("omits the trailing task line and never emits a stray 'undefined' when task is absent", async () => {
    const { client, close } = await connect(() => Effect.succeed({ ok: true }));

    onTestFinished(close);

    const prompt = await client.getPrompt({
      name: "luca-api-planner",
      arguments: {},
    });

    const text = (prompt.messages[0]?.content as { text: string }).text;
    expect(text).toBe(
      [
        "Use Luca MCP tools only for public API operations.",
        "Do not ask for database access, internal endpoints, webhook ingress secrets, or browser cookies.",
        "For writes, pass a stable idempotencyKey when retrying the same user intent.",
        "Check luca://operations when you need exact tool names, scopes, and paths.",
      ].join("\n")
    );
  });

  it("omits the trailing task line when task is present but empty", async () => {
    const { client, close } = await connect(() => Effect.succeed({ ok: true }));

    onTestFinished(close);

    const prompt = await client.getPrompt({
      name: "luca-api-planner",
      arguments: { task: "" },
    });

    const text = (prompt.messages[0]?.content as { text: string }).text;
    // An empty task is no task: it never becomes a "User task:" line with
    // nothing after it.
    expect(text).not.toContain("User task:");
    expect(text.endsWith("scopes, and paths.")).toBe(true);
  });

  it("logs the planner prompt.get event with hasGuidance always false", async () => {
    const { client, close } = await connect(() => Effect.succeed({ ok: true }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    onTestFinished(async () => {
      logSpy.mockRestore();
      await close();
    });

    await client.getPrompt({
      name: "luca-api-planner",
      arguments: { task: "book a call" },
    });
    const events = loggedEvents(logSpy, "mcp.prompts.get");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "mcp.prompts.get",
      prompt: "luca-api-planner",
      hasGuidance: false,
    });
  });

  it("lists each prompt argument as optional with its description", async () => {
    const { client, close } = await connect(() => Effect.succeed({ ok: true }));

    onTestFinished(close);

    const prompts = await client.listPrompts();

    const draft = prompts.prompts.find(
      (prompt) => prompt.name === "luca-draft-reply"
    );

    expect(draft?.arguments).toEqual([
      expect.objectContaining({
        name: "leadId",
        description: "The lead to draft a reply for (uuid).",
        required: false,
      }),
      expect.objectContaining({
        name: "conversationId",
        description: "The conversation to draft a reply for (uuid).",
        required: false,
      }),
      expect.objectContaining({
        name: "guidance",
        description: "Optional extra guidance on tone or content.",
        required: false,
      }),
    ]);
  });

  it("registers an argument-less prompt's title and description without an argsSchema", async () => {
    const { client, close } = await connect(() => Effect.succeed({ ok: true }));

    onTestFinished(close);

    const prompts = await client.listPrompts();

    const morning = prompts.prompts.find(
      (prompt) => prompt.name === "luca-morning-report"
    );

    expect(morning?.title).toBe("Luca: morning report");
    expect(morning?.description).toBe(
      "Summarize what needs attention: recent conversations, the review queue, upcoming bookings, and active-campaign performance."
    );
    expect(morning?.arguments ?? []).toHaveLength(0);
  });

  it("logs the prompts.get event with the real prompt name for a non-planner prompt", async () => {
    const { client, close } = await connect(() => Effect.succeed({ ok: true }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    onTestFinished(async () => {
      logSpy.mockRestore();
      await close();
    });

    await client.getPrompt({ name: "luca-morning-report" });
    const events = loggedEvents(logSpy, "mcp.prompts.get");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "mcp.prompts.get",
      prompt: "luca-morning-report",
      hasGuidance: false,
    });
  });

  it("parses with the prompt's own argsSchema, so an argument outside the old hardcoded leadId/conversationId/guidance triple still reaches build", async () => {
    // Regression for a boundary bug: registerPrompts used to parse every
    // prompt's incoming args with one hardcoded schema instead of the
    // prompt's own argsSchema, so a field the client was told to send (because
    // it is in the registered argsSchema) silently vanished before
    // prompt.build ever saw it. LUCA_PROMPTS carries no such field today, so
    // this drives registerPrompts with a prompt list of its own.
    const receivedArgs: Record<string, string | undefined>[] = [];

    const testPrompt: LucaPrompt = {
      name: "luca-test-campaign-summary",
      title: "Test: campaign summary",
      description: "Test-only prompt for the argsSchema boundary fix.",
      args: { campaignId: "The campaign to summarize." },
      build: (args) => {
        receivedArgs.push(args);

        return `campaign ${args.campaignId ?? "unknown"}`;
      },
    };

    const server = new McpServer(LUCA_SERVER_INFO);
    registerPrompts(server, [testPrompt], {
      leadId: () => Promise.resolve([]),
      conversationId: () => Promise.resolve([]),
    });

    const client = new Client({
      name: "luca-mcp-test-client",
      // Compared against the constant, not a literal: the point is that the
      // server card reads the shared version rather than re-hardcoding one,
      // which is how server.ts and http.ts drifted apart before.
      version: LUCA_MCP_VERSION,
    });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    onTestFinished(() => clientTransport.close());

    const prompt = await client.getPrompt({
      name: "luca-test-campaign-summary",
      arguments: { campaignId: "camp_1" },
    });

    const text = (prompt.messages[0]?.content as { text: string }).text;
    expect(text).toBe("campaign camp_1");
    expect(receivedArgs).toEqual([{ campaignId: "camp_1" }]);
  });
});
