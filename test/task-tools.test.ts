import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import { afterEach, assert, describe, expect, it, vi } from "vitest";

import {
  LucaHttpError,
  LucaNetworkError,
  type LucaError,
} from "../src/errors.ts";
import { MESSAGING_CHANNELS, WORKSPACE_INPUT_FIELDS } from "../src/fields.ts";
import { OPENAPI_INPUT_SPECS } from "../src/generated/openapi-input-specs.ts";
import { LucaApi, type LucaRequest } from "../src/http.ts";
import type { ToolField } from "../src/openapi-schema.ts";
import { LUCA_OPERATIONS } from "../src/operations.ts";
import { needsConfirmation } from "../src/operations/registry.ts";
import { provenanceFields } from "../src/provenance.ts";
import type {
  JsonObject,
  JsonValue,
  JsonValueInput,
} from "../src/serialization.ts";
import { toolSchema } from "../src/standard-schema.ts";
import type { LucaTaskTool } from "../src/task-tools.ts";
import { LUCA_TASK_TOOLS } from "../src/task-tools.ts";
import { fromTaskTool } from "../src/tool.ts";
import { jsonText, parseJsonRecord, sorted } from "./helpers.ts";

/** A JSON object a test reads keys from. */
type JsonRecord = Readonly<Record<string, JsonValue>>;

function accepts(field: ToolField | undefined, value: JsonValueInput) {
  return (
    field !== undefined &&
    Option.isSome(Schema.decodeUnknownOption(field)(value))
  );
}

/** Each argument's description, read off the schema the tool registers. */
function fieldDescriptions(tool: LucaTaskTool) {
  return R.map(fromTaskTool(tool).inputSchema, (field) => ({
    description: SchemaAST.resolveDescription(field.ast),
  }));
}

const CRUD_VERBS = /^luca_(list|get|create|update|delete)_/;

const TOOL_NAME_PATTERN = /^luca_[a-z_]+$/;

function getTool(name: string): LucaTaskTool {
  const tool = LUCA_TASK_TOOLS.find((candidate) => candidate.name === name);

  assert(tool, `unknown task tool: ${name}`);

  return tool;
}

function nth<T>(items: readonly T[], index: number): T {
  const value = items[index];

  assert(value !== undefined, `expected an entry at index ${index}`);

  return value;
}

type Handler = (
  input: LucaRequest
) => Effect.Effect<JsonValue, LucaError, never>;

type HandlerCatalog = Record<string, Handler>;

type StubApi = {
  api: LucaApi;
  calls: LucaRequest[];
};

function stubApi(handlers: HandlerCatalog): StubApi {
  const calls: LucaRequest[] = [];

  const request = (input: LucaRequest) => {
    calls.push(input);
    const handler = handlers[input.operation.id];

    assert(handler, `no stub registered for operation: ${input.operation.id}`);

    return handler(input);
  };

  return {
    calls,
    api: { request },
  };
}

function ok(value: JsonValue): Handler {
  return () => Effect.succeed(value);
}

function bad(message: string): Handler {
  return () => Effect.fail(new LucaNetworkError({ message }));
}

const notFound: Handler = () =>
  Effect.fail(
    new LucaHttpError({
      status: 404,
      statusText: "Not Found",
      body: { code: "not_found" },
    })
  );

type ConcurrencyTrackingApi = {
  api: LucaApi;
  calls: LucaRequest[];
  peak: () => number;
};

/**
 * A stub that holds every call open until `sideBySide` of them are in flight
 * at once, so `peak()` reports an exact number rather than a timing artifact.
 *
 * A fan-out that lost its `concurrency` option runs one call at a time, never
 * reaches `sideBySide`, and so never trips the latch. The timeout it races is
 * what makes that show up as a failed `peak()` assertion instead of a hung
 * test; on the passing path the latch resolves at once and nothing sleeps.
 */
function concurrencyTrackingApi(
  resultFor: (operationId: string) => JsonValue,
  sideBySide: number
): ConcurrencyTrackingApi {
  const calls: LucaRequest[] = [];
  let inFlight = 0;
  let peak = 0;

  let release: () => void = () => {
    // Replaced synchronously by the Promise executor on the next line.
  };

  const allInFlight = new Promise<void>((resolve) => {
    release = resolve;
  });

  const request = (input: LucaRequest) => {
    calls.push(input);

    return Effect.gen(function* () {
      inFlight++;
      peak = Math.max(peak, inFlight);

      if (inFlight >= sideBySide) {
        release();
      }

      yield* Effect.race(
        Effect.tryPromise(() => allInFlight).pipe(Effect.orDie),
        Effect.sleep("50 millis")
      );
      inFlight--;

      return resultFor(input.operation.id);
    });
  };

  return { calls, peak: () => peak, api: { request } };
}

const outputValidator = new AjvJsonSchemaValidator();

/**
 * Checks the structured content the server sends against the JSON Schema it
 * registered for the tool. That schema is closed (`additionalProperties:
 * false`), and a client validates against it, so a key the declared output does
 * not name fails there. Decoding with the Effect schema alone ignores excess
 * keys and cannot see that.
 */
function expectMatchesOutputJsonSchema(
  registered: ReturnType<typeof fromTaskTool>,
  result: JsonValue
) {
  const { $schema: _schema, ...jsonSchema } = toolSchema(
    registered.outputSchema
  )["~standard"].jsonSchema.output({ target: "draft-2020-12" });

  const check = outputValidator.getValidator(jsonSchema);

  const verdict = check({
    result,
    ...provenanceFields(registered.untrustedContent),
  });

  assert(
    verdict.valid,
    `${registered.name} output breaks its JSON Schema: ${verdict.errorMessage}`
  );
}

/**
 * Runs a task tool the way the server does and checks what it returns against
 * the output schema the tool registers, so every scenario below also proves
 * the declared shape matches the real one. A scenario that feeds the tool a
 * deliberately malformed response turns the check off.
 */
async function runTool(
  tool: LucaTaskTool,
  api: LucaApi,
  input: JsonObject,
  { validateOutput = true }: { readonly validateOutput?: boolean } = {}
): Promise<JsonValue> {
  const registered = fromTaskTool(tool);

  const result = await Effect.runPromise(
    registered.run(input).pipe(Effect.provideService(LucaApi, api))
  );

  if (validateOutput) {
    // Throws with the decode issue when the result breaks the declared shape.
    Schema.decodeUnknownSync(Schema.Struct(registered.outputSchema))({
      result,
    });

    expectMatchesOutputJsonSchema(registered, result);
  }

  return result;
}

/**
 * A task tool's arguments as the JSON Schema a client is sent, minus the two
 * workspace fields every tool carries. Reading the schema off the wire shape is
 * the point: the descriptions and bounds below are the contract an agent works
 * from, not internal schema detail.
 */
function inputJsonSchema(tool: LucaTaskTool) {
  // oxlint-disable-next-line anti-slop/no-known-value-widening -- The copy has to stay writable so the shared workspace fields can be deleted.
  const fields: Record<string, ToolField> = { ...tool.inputSchema };

  Arr.forEach(R.keys(WORKSPACE_INPUT_FIELDS), (shared) => {
    delete fields[shared];
  });

  const { $schema: _schema, ...rest } = toolSchema(fields)[
    "~standard"
  ].jsonSchema.input({ target: "draft-2020-12" });

  return rest;
}

describe("task tool registry", () => {
  it("exposes exactly the registered task tools, in order", () => {
    expect(sorted(LUCA_TASK_TOOLS.map((tool) => tool.name))).toEqual([
      "luca_analytics_deep_dive",
      "luca_analytics_magic_monday",
      "luca_analytics_rollup",
      "luca_approve_and_send",
      "luca_book_call",
      "luca_close_call_loop",
      "luca_draft_reply",
      "luca_find_leads",
      "luca_flag_for_human",
      "luca_morning_report",
      "luca_pause_cadence",
      "luca_post_call_queue",
      "luca_reschedule_call",
      "luca_rescue_silent_leads",
      "luca_triage_inbox",
    ]);
  });

  it("confirm-gates exactly the tools that compose a gated operation or declare a condition", () => {
    const gated = LUCA_TASK_TOOLS.filter(
      (tool) => fromTaskTool(tool).confirm !== undefined
    ).map((tool) => tool.name);

    expect(sorted(gated)).toEqual(
      sorted([
        "luca_approve_and_send",
        "luca_book_call",
        "luca_close_call_loop",
        "luca_reschedule_call",
        "luca_rescue_silent_leads",
      ])
    );

    Arr.forEach(LUCA_TASK_TOOLS, (tool) => {
      const registered = fromTaskTool(tool);

      expect("confirm" in registered.inputSchema).toBe(
        registered.confirm !== undefined
      );
    });
  });

  it("uses task-intent names, never CRUD verbs over nouns", () => {
    Arr.forEach(LUCA_TASK_TOOLS, (tool) => {
      expect(tool.name).toMatch(TOOL_NAME_PATTERN);
      expect(tool.name).not.toMatch(CRUD_VERBS);
    });
  });

  it("does not collide with operation tool names", () => {
    const operationNames = LUCA_OPERATIONS.map((op) => op.toolName);

    Arr.forEach(LUCA_TASK_TOOLS, (tool) => {
      expect(Arr.contains(operationNames, tool.name)).toBe(false);
    });
  });

  it("only composes operation ids that exist", () => {
    const ids = LUCA_OPERATIONS.map((op) => op.id);

    Arr.forEach(LUCA_TASK_TOOLS, (tool) => {
      expect(tool.composes.length).toBeGreaterThan(0);

      Arr.forEach(tool.composes, (id) => {
        expect(Arr.contains(ids, id)).toBe(true);
      });
    });
  });

  it("gives every tool a description with a usage example", () => {
    Arr.forEach(LUCA_TASK_TOOLS, (tool) => {
      expect(tool.description).toContain("Example:");
    });
  });
});

describe("luca_triage_inbox", () => {
  const tool = () => getTool("luca_triage_inbox");

  it("pins the exact metadata", () => {
    expect(tool().title).toBe("Triage the review queue");
    expect(fromTaskTool(tool()).readOnly).toBe(true);
    expect(fromTaskTool(tool()).untrustedContent).toBe(true);
    expect(fromTaskTool(tool()).confirm).toBeUndefined();
    expect(tool().composes).toEqual([
      "reviewQueue.list",
      "reviewQueue.explain",
    ]);
    expect(sorted(R.keys(fromTaskTool(tool()).inputSchema))).toEqual(
      sorted(["explainTop", "limit", "workspaceId", "workspaceSlug"])
    );
  });

  it("pins the exact field descriptions", () => {
    const schema = fieldDescriptions(tool());

    expect(schema.limit?.description).toBe(
      "Max queue items to return (default 20)."
    );
    expect(schema.explainTop?.description).toBe(
      "How many of the top items to attach a full explanation to (default 3)."
    );
  });

  it("rejects a limit below 1 and above 50, accepts the boundaries", () => {
    const limit = tool().inputSchema.limit;

    expect(accepts(limit, 0)).toBe(false);
    expect(accepts(limit, 1)).toBe(true);
    expect(accepts(limit, 50)).toBe(true);
    expect(accepts(limit, 51)).toBe(false);
  });

  it("defaults limit to 20 and explains up to explainTop items, skipping items without an id", async () => {
    const { api, calls } = stubApi({
      "reviewQueue.list": ok({
        items: [{}, { id: "a" }, { id: "b" }, { id: "c" }],
      }),
      "reviewQueue.explain": ok({ explanation: "why" }),
    });

    const result = (await runTool(tool(), api, {})) as {
      queue: JsonValue;
      explanations: JsonRecord;
    };

    const listCall = nth(calls, 0);
    expect(listCall.query).toEqual({ limit: 20 });

    // Default explainTop is 3; the id-less first item is skipped, so only
    // "a" and "b" (the next two items within the slice(0, 3) window) get
    // explained.
    expect(calls).toHaveLength(3);
    expect(nth(calls, 1).pathParams).toEqual({ id: "a" });
    expect(nth(calls, 2).pathParams).toEqual({ id: "b" });
    expect(result.explanations).toEqual({
      a: { explanation: "why" },
      b: { explanation: "why" },
    });
  });

  it("caps explainTop at the number of returned items", async () => {
    const { api, calls } = stubApi({
      "reviewQueue.list": ok({ items: [{ id: "x" }, { id: "y" }] }),
      "reviewQueue.explain": ok({ explanation: "why" }),
    });

    const result = (await runTool(tool(), api, { explainTop: 5 })) as {
      explanations: JsonRecord;
    };

    expect(calls).toHaveLength(3);
    expect(result.explanations).toEqual({
      x: { explanation: "why" },
      y: { explanation: "why" },
    });
  });

  it("skips explaining entirely when explainTop is 0", async () => {
    const { api, calls } = stubApi({
      "reviewQueue.list": ok({ items: [{ id: "x" }, { id: "y" }] }),
      "reviewQueue.explain": ok({ explanation: "why" }),
    });

    const result = (await runTool(tool(), api, {
      limit: 5,
      explainTop: 0,
    })) as { explanations: JsonRecord };

    expect(calls).toHaveLength(1);
    expect(nth(calls, 0).query).toEqual({ limit: 5 });
    expect(result.explanations).toEqual({});
  });

  it("returns the page untouched and explains nothing when the queue page is undecodable", async () => {
    // A page whose fields the tool cannot read must not fail the whole call: the
    // caller still gets the raw page back, minus the fan-out.
    const { api, calls } = stubApi({
      "reviewQueue.list": ok("not-a-page"),
      "reviewQueue.explain": ok({ explanation: "why" }),
    });

    const result = (await runTool(
      tool(),
      api,
      {},
      { validateOutput: false }
    )) as {
      queue: JsonValue;
      explanations: JsonRecord;
    };

    expect(calls).toHaveLength(1);
    expect(result.queue).toBe("not-a-page");
    expect(result.explanations).toEqual({});
  });

  it("explains nothing when the queue page carries no items field", async () => {
    const { api, calls } = stubApi({
      "reviewQueue.list": ok({ nextCursor: "c1" }),
      "reviewQueue.explain": ok({ explanation: "why" }),
    });

    const result = (await runTool(tool(), api, {})) as {
      explanations: JsonRecord;
    };

    expect(calls).toHaveLength(1);
    expect(result.explanations).toEqual({});
  });

  it("explains nothing when an item id is not a string", async () => {
    // The page fields is validated rather than trusted, so an id of the wrong
    // type has to stop the fan-out instead of reaching the explain call as a
    // path parameter the API would reject.
    const { api, calls } = stubApi({
      "reviewQueue.list": ok({ items: [{ id: 42 }] }),
      "reviewQueue.explain": ok({ explanation: "why" }),
    });

    const result = (await runTool(tool(), api, {})) as {
      explanations: JsonRecord;
    };

    expect(calls).toHaveLength(1);
    expect(result.explanations).toEqual({});
  });

  it("falls back to the default explainTop when it arrives as a non-number", async () => {
    // The MCP client is schema-checked, but the tool reads its numeric inputs
    // defensively. A non-numeric value has to fall back to the default rather
    // than reach `slice` as NaN, which would explain nothing at all.
    const { api, calls } = stubApi({
      "reviewQueue.list": ok({
        items: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
      }),
      "reviewQueue.explain": ok({ explanation: "why" }),
    });

    const result = (await runTool(tool(), api, {
      explainTop: "top three",
    })) as { explanations: JsonRecord };

    // Default of 3 applies, so "d" is left unexplained.
    expect(calls).toHaveLength(4);
    expect(R.keys(result.explanations)).toEqual(["a", "b", "c"]);
  });

  it("converts a failed explain call into a structured explainError instead of throwing", async () => {
    const { api, calls } = stubApi({
      "reviewQueue.list": ok({ items: [{ id: "x" }] }),
      "reviewQueue.explain": bad("explain blew up"),
    });

    const result = (await runTool(tool(), api, {})) as {
      explanations: JsonRecord;
    };

    expect(calls).toHaveLength(2);
    expect(result.explanations).toEqual({
      x: { explainError: "explain blew up" },
    });
  });

  it("runs the explain calls side by side instead of one at a time", async () => {
    const { api, calls, peak } = concurrencyTrackingApi(
      (operationId) =>
        operationId === "reviewQueue.list"
          ? {
              items: [
                { id: "a" },
                { id: "b" },
                { id: "c" },
                { id: "d" },
                { id: "e" },
              ],
            }
          : { explanation: "why" },
      5
    );

    await runTool(tool(), api, { explainTop: 5 });

    expect(calls).toHaveLength(6);
    // Sequential explain calls (Effect.forEach's default) would never see more
    // than one in flight; this fails if the concurrency option is dropped.
    expect(peak()).toBe(5);
  });
});

/**
 * `mcp.tool().called` reports this tool as a success even when every explanation
 * inside it failed, because a failed lookup comes back as an `explainError`
 * field rather than an error result. These pin the one line that makes a
 * systematically broken explain route visible.
 */
describe("luca_triage_inbox mcp.explain logging", () => {
  const tool = () => getTool("luca_triage_inbox");

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Every mcp.explain line logged while the tool ran, parsed.
   *
   * `vi.spyOn` hands back the existing mock when the method is already spied,
   * so the spy is cleared first: a second call inside one test would otherwise
   * read the first call's lines too. `afterEach` restores it.
   */
  async function explainLines(
    handlers: HandlerCatalog,
    input: JsonObject = {},
    options: { readonly validateOutput?: boolean } = {}
  ) {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    spy.mockClear();

    const { api } = stubApi(handlers);
    const result = await runTool(tool(), api, input, options);

    const lines = spy.mock.calls
      .map((call: unknown[]) => parseJsonRecord(String(call[0])))
      .filter((line) => line.event === "mcp.explain");

    return { lines, result };
  }

  const threeItems = ok({ items: [{ id: "a" }, { id: "b" }, { id: "c" }] });

  it("logs one line with the full count breakdown when every explain succeeds", async () => {
    const { lines } = await explainLines({
      "reviewQueue.list": threeItems,
      "reviewQueue.explain": ok({ explanation: "why" }),
    });

    expect(lines).toHaveLength(1);
    expect(nth(lines, 0)).toEqual({
      msg: "mcp.agent_surface",
      event: "mcp.explain",
      toolName: "luca_triage_inbox",
      requested: 3,
      explained: 3,
      failed: 0,
    });
  });

  it("counts a partial failure on both sides of the split", async () => {
    let attempt = 0;

    const { lines, result } = await explainLines({
      "reviewQueue.list": threeItems,
      "reviewQueue.explain": () => {
        attempt += 1;

        return attempt === 2
          ? Effect.fail(
              new LucaNetworkError({
                message: "explain blew up",
              })
            )
          : Effect.succeed({ explanation: "why" });
      },
    });

    expect(nth(lines, 0).requested).toBe(3);
    expect(nth(lines, 0).explained).toBe(2);
    expect(nth(lines, 0).failed).toBe(1);
    // The tool still returns a result, which is exactly why the line is needed.
    const explanations = (result as { explanations: JsonRecord }).explanations;
    expect(R.keys(explanations)).toHaveLength(3);
  });

  it("reports explained: 0 when every explain call fails", async () => {
    const { lines } = await explainLines({
      "reviewQueue.list": threeItems,
      "reviewQueue.explain": bad("explain blew up"),
    });

    expect(nth(lines, 0).requested).toBe(3);
    expect(nth(lines, 0).explained).toBe(0);
    expect(nth(lines, 0).failed).toBe(3);
  });

  it.each([0, 1, 2, 3])(
    "keeps explained + failed equal to requested when %i explains fail",
    async (failAt) => {
      let attempt = 0;

      const { lines } = await explainLines({
        "reviewQueue.list": threeItems,
        "reviewQueue.explain": () => {
          attempt += 1;

          return attempt <= failAt
            ? Effect.fail(
                new LucaNetworkError({
                  message: "down",
                })
              )
            : Effect.succeed({ explanation: "why" });
        },
      });

      const line = nth(lines, 0);
      expect(Number(line.explained) + Number(line.failed)).toBe(
        Number(line.requested)
      );
      expect(line.failed).toBe(failAt);
    }
  );

  it("logs nothing when explainTop is 0", async () => {
    const { lines } = await explainLines(
      {
        "reviewQueue.list": threeItems,
        "reviewQueue.explain": ok({ explanation: "why" }),
      },
      { explainTop: 0 }
    );

    expect(lines).toEqual([]);
  });

  it("logs nothing when the queue page carries no explainable items", async () => {
    const { lines } = await explainLines({
      "reviewQueue.list": ok({ items: [] }),
      "reviewQueue.explain": ok({ explanation: "why" }),
    });

    expect(lines).toEqual([]);
  });

  it("logs nothing when the queue page is undecodable", async () => {
    const { lines } = await explainLines(
      {
        "reviewQueue.list": ok("not-a-page"),
        "reviewQueue.explain": ok({ explanation: "why" }),
      },
      {},
      { validateOutput: false }
    );

    expect(lines).toEqual([]);
  });

  it("logs one line per call, not one per explained item", async () => {
    const { lines } = await explainLines(
      {
        "reviewQueue.list": ok({
          items: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
        }),
        "reviewQueue.explain": ok({ explanation: "why" }),
      },
      { explainTop: 4 }
    );

    expect(lines).toHaveLength(1);
    expect(nth(lines, 0).requested).toBe(4);
  });

  it("carries no queue item id and no explanation text", async () => {
    // The payload contract is counts only: an explanation is lead-derived and
    // a queue id names a real conversation.
    const { lines } = await explainLines({
      "reviewQueue.list": ok({ items: [{ id: "lead-uuid-1234" }] }),
      "reviewQueue.explain": ok({ explanation: "she asked about price" }),
    });

    const serialized = jsonText(nth(lines, 0));
    expect(serialized).not.toContain("lead-uuid-1234");
    expect(serialized).not.toContain("she asked about price");
    expect(sorted(R.keys(nth(lines, 0)))).toEqual([
      "event",
      "explained",
      "failed",
      "msg",
      "requested",
      "toolName",
    ]);
  });

  it("counts the requests it actually made, not the queue length", async () => {
    // explainTop caps the fan-out below the page size, so `requested` has to
    // follow the fan-out rather than the number of items returned.
    const { lines } = await explainLines(
      {
        "reviewQueue.list": ok({
          items: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
        }),
        "reviewQueue.explain": ok({ explanation: "why" }),
      },
      { explainTop: 2 }
    );

    expect(nth(lines, 0).requested).toBe(2);
  });
});

describe("luca_find_leads", () => {
  const tool = () => getTool("luca_find_leads");

  it("pins the exact metadata", () => {
    expect(tool().title).toBe("Find leads");
    expect(fromTaskTool(tool()).readOnly).toBe(true);
    expect(fromTaskTool(tool()).untrustedContent).toBe(true);
    expect(fromTaskTool(tool()).confirm).toBeUndefined();
    expect(tool().composes).toEqual(["leads.list"]);
    expect(sorted(R.keys(fromTaskTool(tool()).inputSchema))).toEqual(
      sorted(["channel", "limit", "query", "workspaceId", "workspaceSlug"])
    );
  });

  it("pins the exact field descriptions", () => {
    const schema = fieldDescriptions(tool());

    expect(schema.query?.description).toBe(
      "Free-text search: name, handle, or keyword."
    );
    expect(schema.channel?.description).toBe("Optional channel filter.");
    expect(schema.limit?.description).toBe("Max results (default 10).");
  });

  it("takes only the channels the leads route accepts", () => {
    const route = OPENAPI_INPUT_SPECS["GET /api/leads"].query;

    expect(route.properties.channel.enum).toEqual([...MESSAGING_CHANNELS]);
    expect(
      Schema.is(Schema.Struct(fromTaskTool(tool()).inputSchema))({
        query: "maria",
        channel: "email",
      })
    ).toBe(false);
  });

  it("defaults limit to 10 and passes through query/channel as given", async () => {
    const { api, calls } = stubApi({
      "leads.list": ok({ items: [] }),
    });

    await runTool(tool(), api, { query: "maria" });

    expect(nth(calls, 0).query).toEqual({
      q: "maria",
      channel: undefined,
      limit: 10,
    });
  });

  it("uses an explicit channel and limit instead of the defaults", async () => {
    const { api, calls } = stubApi({
      "leads.list": ok({ items: [] }),
    });

    await runTool(tool(), api, {
      query: "maria",
      channel: "instagram",
      limit: 25,
    });

    expect(nth(calls, 0).query).toEqual({
      q: "maria",
      channel: "instagram",
      limit: 25,
    });
  });

  it("never sends a body for a read-only lookup", async () => {
    const { api, calls } = stubApi({ "leads.list": ok({ items: [] }) });
    await runTool(tool(), api, { query: "maria" });
    expect("body" in nth(calls, 0)).toBe(false);
  });
});

describe("luca_flag_for_human", () => {
  const tool = () => getTool("luca_flag_for_human");

  it("pins the exact metadata", () => {
    expect(tool().title).toBe("Flag a lead for human attention");
    expect(fromTaskTool(tool()).readOnly).toBe(false);
    expect(fromTaskTool(tool()).untrustedContent).toBe(false);
    expect(fromTaskTool(tool()).confirm).toBeUndefined();
    expect(tool().composes).toEqual(["leads.notes.add"]);
    expect(sorted(R.keys(fromTaskTool(tool()).inputSchema))).toEqual(
      sorted([
        "idempotencyKey",
        "leadId",
        "reason",
        "workspaceId",
        "workspaceSlug",
      ])
    );
  });

  it("pins the exact field descriptions", () => {
    const schema = fieldDescriptions(tool());

    expect(schema.leadId?.description).toBe("The lead to flag.");
    expect(schema.reason?.description).toBe(
      "Why a human should look — shown to the coach verbatim."
    );
    expect(schema.idempotencyKey?.description).toBe(
      "Reuse the same key when retrying this exact flag."
    );
  });

  it("prefixes the note body with a needs-human tag and targets the lead", async () => {
    const { api, calls } = stubApi({
      "leads.notes.add": ok({ id: "note-1" }),
    });

    await runTool(tool(), api, {
      leadId: "lead-1",
      reason: "lead mentioned a refund dispute",
    });

    expect(nth(calls, 0).pathParams).toEqual({ id: "lead-1" });
    expect(nth(calls, 0).body).toEqual({
      body: "[needs-human] lead mentioned a refund dispute",
    });
  });

  it("describes the note honestly instead of promising routing or alerting", () => {
    // The tool used to claim it attaches "a visible 'needs a human' note ...
    // so the coach reviews it personally", but nothing in the app, api, or
    // worker code reads the [needs-human] prefix — it's an ordinary note.
    expect(tool().description).toContain("[needs-human]");
    expect(tool().description).toContain("does not route, alert");
    expect(tool().description).not.toContain("reviews it personally");
  });
});

describe("luca_book_call", () => {
  const tool = () => getTool("luca_book_call");

  it("pins the exact metadata", () => {
    expect(tool().title).toBe("Book a call with a lead");
    expect(fromTaskTool(tool()).readOnly).toBe(false);
    // The created booking carries a cancellation reason field.
    expect(fromTaskTool(tool()).untrustedContent).toBe(true);
    expect(fromTaskTool(tool()).confirm).toBe("always");
    expect(tool().composes).toEqual([
      "bookings.availability",
      "bookings.managedAvailability",
      "bookings.create",
    ]);
    expect(sorted(R.keys(fromTaskTool(tool()).inputSchema))).toEqual(
      sorted([
        "bookingTypeId",
        "confirm",
        "idempotencyKey",
        "leadId",
        "provider",
        "slotAt",
        "workspaceId",
        "workspaceSlug",
      ])
    );
  });

  it("pins the exact field descriptions", () => {
    const schema = fieldDescriptions(tool());

    expect(schema.leadId?.description).toBe("The lead to book.");
    expect(schema.bookingTypeId?.description).toBe(
      "The booking type to book under, from luca_bookings_types_list. Required when provider is google_calendar, and it must be an active google_calendar type."
    );
    expect(schema.slotAt?.description).toBe(
      "ISO-8601 start time for the call, with an offset."
    );
    expect(schema.idempotencyKey?.description).toBe(
      "Reuse the same key when retrying this exact booking. A keyed call skips the availability check and lets the API replay the first result."
    );
    expect(schema.provider?.description).toBe(
      "The coach's booking provider. Sent with the booking and used for the availability check. Pass it when the coach is not on Calendly, or the availability check reads the wrong calendar. Left off, the check reads Calendly and the API records the booking as manual."
    );
  });

  it("rejects a slot on a day the calendar does not have", () => {
    const slotAt = tool().inputSchema.slotAt;

    expect(accepts(slotAt, "2026-07-14T15:00:00Z")).toBe(true);
    // `Date` would read this as 3 March and book the wrong day.
    expect(accepts(slotAt, "2026-02-31T15:00:00Z")).toBe(false);
  });

  it("accepts each API provider and rejects any other", () => {
    const provider = tool().inputSchema.provider;

    Arr.forEach(
      [
        "manual",
        "calendly",
        "cal_com",
        "google_calendar",
        "iclosed",
        "gohighlevel",
      ],
      (name) => {
        expect(accepts(provider, name)).toBe(true);
      }
    );

    expect(accepts(provider, "outlook")).toBe(false);
    expect(accepts(provider, "")).toBe(false);
  });

  it("sends the provider with the booking", async () => {
    const { api, calls } = stubApi({
      "bookings.availability": ok({
        source: "live_provider",
        slots: [{ startsAt: "2026-07-14T15:00:00Z" }],
      }),
      "bookings.create": ok({ id: "booking-1" }),
    });

    await runTool(tool(), api, {
      leadId: "lead-1",
      slotAt: "2026-07-14T15:00:00Z",
      provider: "cal_com",
    });

    expect(
      calls.find((call) => call.operation.id === "bookings.create")?.body
    ).toEqual({
      leadId: "lead-1",
      slotAt: "2026-07-14T15:00:00Z",
      provider: "cal_com",
    });
  });

  it("sends the booking type with the booking, and leaves it off when not given", async () => {
    const { api, calls } = stubApi({
      "bookings.availability": ok({
        source: "live_provider",
        slots: [{ startsAt: "2026-07-14T15:00:00Z" }],
      }),
      "bookings.managedAvailability": ok({
        slots: [{ startsAt: "2026-07-14T15:00:00Z" }],
      }),
      "bookings.create": ok({ id: "booking-1" }),
    });

    await runTool(tool(), api, {
      leadId: "lead-1",
      slotAt: "2026-07-14T15:00:00Z",
      provider: "google_calendar",
      bookingTypeId: "type-1",
    });
    await runTool(tool(), api, {
      leadId: "lead-1",
      slotAt: "2026-07-14T15:00:00Z",
    });

    expect(
      calls
        .filter((call) => call.operation.id === "bookings.create")
        .map((call) => call.body)
    ).toEqual([
      {
        leadId: "lead-1",
        slotAt: "2026-07-14T15:00:00Z",
        provider: "google_calendar",
        bookingTypeId: "type-1",
      },
      { leadId: "lead-1", slotAt: "2026-07-14T15:00:00Z" },
    ]);
  });

  it("checks a named booking type against its own schedule", async () => {
    const { api, calls } = stubApi({
      "bookings.availability": ok({ source: "live_provider", slots: [] }),
      "bookings.managedAvailability": ok({
        slots: [{ startsAt: "2026-07-14T15:00:00.000Z" }],
      }),
      "bookings.create": ok({ id: "booking-1" }),
    });

    const result = await runTool(tool(), api, {
      leadId: "lead-1",
      slotAt: "2026-07-14T15:00:00Z",
      provider: "google_calendar",
      bookingTypeId: "type-1",
    });

    expect(result).toEqual({ id: "booking-1" });
    expect(calls.map((call) => call.operation.id)).toEqual([
      "bookings.managedAvailability",
      "bookings.create",
    ]);
    expect(nth(calls, 0).query).toEqual({
      bookingTypeId: "type-1",
      timezone: "UTC",
      start: "2026-07-14T15:00:00.000Z",
      end: "2026-07-15T15:00:00.000Z",
    });
  });

  it("refuses a slot the booking type does not offer and returns the open ones", async () => {
    const { api, calls } = stubApi({
      "bookings.managedAvailability": ok({
        slots: [{ startsAt: "2026-07-14T16:00:00Z" }],
      }),
      "bookings.create": ok({ id: "booking-1" }),
    });

    const result = await runTool(tool(), api, {
      leadId: "lead-1",
      slotAt: "2026-07-14T15:00:00Z",
      bookingTypeId: "type-1",
    });

    expect(result).toEqual({
      booked: false,
      reason: "slot_not_available",
      requestedSlotAt: "2026-07-14T15:00:00Z",
      openSlots: ["2026-07-14T16:00:00Z"],
    });
    expect(calls.map((call) => call.operation.id)).toEqual([
      "bookings.managedAvailability",
    ]);
  });

  it("books when the booking type's availability cannot be read", async () => {
    const { api } = stubApi({
      "bookings.managedAvailability": bad("not a managed booking type"),
      "bookings.create": ok({ id: "booking-1" }),
    });

    const result = await runTool(tool(), api, {
      leadId: "lead-1",
      slotAt: "2026-07-14T15:00:00Z",
      bookingTypeId: "type-1",
    });

    expect(result).toEqual({ id: "booking-1" });
  });

  it("fails instead of booking when the availability read is refused", async () => {
    const { api, calls } = stubApi({
      "bookings.managedAvailability": () =>
        Effect.fail(
          new LucaHttpError({
            status: 401,
            statusText: "Unauthorized",
            body: { error: { code: "unauthorized" } },
          })
        ),
      "bookings.create": ok({ id: "booking-1" }),
    });

    await expect(
      runTool(tool(), api, {
        leadId: "lead-1",
        slotAt: "2026-07-14T15:00:00Z",
        bookingTypeId: "type-1",
      })
    ).rejects.toBeInstanceOf(LucaHttpError);
    expect(calls.map((call) => call.operation.id)).toEqual([
      "bookings.managedAvailability",
    ]);
  });

  it("rejects an empty bookingTypeId", () => {
    const bookingTypeId = tool().inputSchema.bookingTypeId;

    expect(accepts(bookingTypeId, "")).toBe(false);
    expect(accepts(bookingTypeId, "type-1")).toBe(true);
  });

  it("skips the availability check on a keyed retry and books", async () => {
    const { api, calls } = stubApi({
      // The first attempt took the slot, so a live check would now refuse it.
      "bookings.availability": ok({ source: "live_provider", slots: [] }),
      "bookings.create": ok({ id: "booking-1" }),
    });

    const result = await runTool(tool(), api, {
      leadId: "lead-1",
      slotAt: "2026-07-14T15:00:00Z",
      idempotencyKey: "retry-1",
    });

    expect(calls.map((call) => call.operation.id)).toEqual(["bookings.create"]);
    expect(result).toEqual({ id: "booking-1" });
  });

  it("rejects an empty leadId", () => {
    const leadId = tool().inputSchema.leadId;

    expect(accepts(leadId, "")).toBe(false);
    expect(accepts(leadId, "lead-1")).toBe(true);
  });

  it("books when the requested slot is one of several open ones", async () => {
    const { api, calls } = stubApi({
      "bookings.availability": ok({
        source: "live_provider",
        slots: [
          { startsAt: "2026-07-14T14:00:00Z" },
          { startsAt: "2026-07-14T15:00:00Z" },
        ],
      }),
      "bookings.create": ok({ id: "booking-1" }),
    });

    await runTool(tool(), api, {
      leadId: "lead-1",
      slotAt: "2026-07-14T15:00:00Z",
    });

    expect(calls.some((call) => call.operation.id === "bookings.create")).toBe(
      true
    );
  });

  it("books without asking the provider when the slot is not a date", async () => {
    const { api, calls } = stubApi({
      "bookings.create": ok({ id: "booking-1" }),
    });

    // The availability window is built from the slot, so an unparseable one has
    // no window to ask about. The API is left to reject the value.
    await runTool(tool(), api, { leadId: "lead-1", slotAt: "next tuesday" });

    expect(calls.map((call) => call.operation.id)).toEqual(["bookings.create"]);
  });

  it("books anyway when the availability read fails outright", async () => {
    const { api, calls } = stubApi({
      "bookings.availability": bad("availability service down"),
      "bookings.create": ok({ id: "booking-1" }),
    });

    await runTool(tool(), api, {
      leadId: "lead-1",
      slotAt: "2026-07-14T15:00:00Z",
    });

    expect(calls.some((call) => call.operation.id === "bookings.create")).toBe(
      true
    );
  });

  it("sends leadId and slotAt as the booking body with no path params", async () => {
    const { api, calls } = stubApi({
      "bookings.availability": ok({
        source: "live_provider",
        slots: [{ startsAt: "2026-07-14T15:00:00Z" }],
      }),
      "bookings.create": ok({ id: "booking-1" }),
    });

    await runTool(tool(), api, {
      leadId: "lead-1",
      slotAt: "2026-07-14T15:00:00Z",
    });

    const create = calls.find(
      (call) => call.operation.id === "bookings.create"
    );

    expect(create?.body).toEqual({
      leadId: "lead-1",
      slotAt: "2026-07-14T15:00:00Z",
    });
    expect(create?.pathParams).toBeUndefined();
  });

  it("asks the provider about a window starting at the requested slot", async () => {
    const { api, calls } = stubApi({
      "bookings.availability": ok({
        source: "live_provider",
        slots: [{ startsAt: "2026-07-14T15:00:00Z" }],
      }),
      "bookings.create": ok({ id: "booking-1" }),
    });

    await runTool(tool(), api, {
      leadId: "lead-1",
      slotAt: "2026-07-14T15:00:00Z",
      provider: "cal_com",
    });

    expect(nth(calls, 0).query).toEqual({
      start: "2026-07-14T15:00:00.000Z",
      end: "2026-07-15T15:00:00.000Z",
      provider: "cal_com",
    });
  });

  it("refuses to book a slot the provider says is taken, and returns the open ones", async () => {
    const { api, calls } = stubApi({
      "bookings.availability": ok({
        source: "live_provider",
        slots: [{ startsAt: "2026-07-14T16:00:00Z" }],
      }),
      "bookings.create": ok({ id: "booking-1" }),
    });

    const result = await runTool(tool(), api, {
      leadId: "lead-1",
      slotAt: "2026-07-14T15:00:00Z",
    });

    expect(result).toEqual({
      booked: false,
      reason: "slot_not_available",
      requestedSlotAt: "2026-07-14T15:00:00Z",
      openSlots: ["2026-07-14T16:00:00Z"],
    });
    expect(calls.some((call) => call.operation.id === "bookings.create")).toBe(
      false
    );
  });

  it("treats a slot in another offset as the same moment", async () => {
    const { api, calls } = stubApi({
      "bookings.availability": ok({
        source: "live_provider",
        slots: [{ startsAt: "2026-07-14T17:00:00+02:00" }],
      }),
      "bookings.create": ok({ id: "booking-1" }),
    });

    await runTool(tool(), api, {
      leadId: "lead-1",
      slotAt: "2026-07-14T15:00:00Z",
    });

    expect(calls.some((call) => call.operation.id === "bookings.create")).toBe(
      true
    );
  });

  it.each(["fallback", "provider_error"])(
    "books anyway when availability came back as %s rather than a live read",
    async (source) => {
      const { api, calls } = stubApi({
        "bookings.availability": ok({ source, slots: [] }),
        "bookings.create": ok({ id: "booking-1" }),
      });

      await runTool(tool(), api, {
        leadId: "lead-1",
        slotAt: "2026-07-14T15:00:00Z",
      });

      // An unreachable provider is not evidence the slot is taken. Blocking
      // here would make every coach without a live connection unbookable.
      expect(
        calls.some((call) => call.operation.id === "bookings.create")
      ).toBe(true);
    }
  );
});

describe("luca_reschedule_call", () => {
  const tool = () => getTool("luca_reschedule_call");

  it("pins the exact metadata", () => {
    expect(tool().title).toBe("Move a call to a new time");
    expect(fromTaskTool(tool()).readOnly).toBe(false);
    expect(fromTaskTool(tool()).untrustedContent).toBe(true);
    expect(fromTaskTool(tool()).confirm).toBe("always");
    expect(tool().composes).toEqual([
      "bookings.get",
      "bookings.availability",
      "bookings.managedAvailability",
      "bookings.update",
      "bookings.guestLinks.create",
    ]);
    expect(sorted(R.keys(fromTaskTool(tool()).inputSchema))).toEqual(
      sorted([
        "bookingId",
        "confirm",
        "expiresInHours",
        "idempotencyKey",
        "provider",
        "slotAt",
        "workspaceId",
        "workspaceSlug",
      ])
    );
  });

  it("pins the exact field descriptions", () => {
    const schema = fieldDescriptions(tool());

    expect(schema.bookingId?.description).toBe("The booking to move.");
    expect(schema.slotAt?.description).toBe(
      "ISO-8601 start time to move the call to, with an offset."
    );
    expect(schema.provider?.description).toBe(
      "The coach's booking provider. Used only for the availability check, and only when the booking has no booking type. The booking keeps the provider it already has. Pass it when the coach is not on Calendly, or the availability check reads the wrong calendar."
    );
    expect(schema.expiresInHours?.description).toBe(
      "How long the new reschedule link stays usable. Defaults to 168 hours."
    );
    expect(schema.idempotencyKey?.description).toBe(
      "Reuse the same key when retrying this exact reschedule. A keyed call skips the availability check and lets the API replay the first result."
    );
  });

  it("rejects an empty bookingId", () => {
    const bookingId = tool().inputSchema.bookingId;

    expect(accepts(bookingId, "")).toBe(false);
    expect(accepts(bookingId, "booking-1")).toBe(true);
  });

  it("holds the link window to whole hours between 1 and 720", () => {
    const expiresInHours = tool().inputSchema.expiresInHours;

    expect(accepts(expiresInHours, 0)).toBe(false);
    expect(accepts(expiresInHours, 1)).toBe(true);
    expect(accepts(expiresInHours, 1.5)).toBe(false);
    expect(accepts(expiresInHours, 720)).toBe(true);
    expect(accepts(expiresInHours, 721)).toBe(false);
  });

  it("moves the call when the new slot is one of several open ones", async () => {
    const { api, calls } = stubApi({
      "bookings.get": ok({ booking: { id: "booking-1", bookingTypeId: null } }),
      "bookings.availability": ok({
        source: "live_provider",
        slots: [
          { startsAt: "2026-07-16T14:00:00Z" },
          { startsAt: "2026-07-16T15:00:00Z" },
        ],
      }),
      "bookings.update": ok({ booking: { id: "booking-1" } }),
      "bookings.guestLinks.create": ok({ rescheduleUrl: "https://x/y" }),
    });

    await runTool(tool(), api, {
      bookingId: "booking-1",
      slotAt: "2026-07-16T15:00:00Z",
    });

    expect(calls.some((call) => call.operation.id === "bookings.update")).toBe(
      true
    );
  });

  it("moves the booking and mints a link the lead can use", async () => {
    const { api, calls } = stubApi({
      "bookings.get": ok({ booking: { id: "booking-1", bookingTypeId: null } }),
      "bookings.availability": ok({
        source: "live_provider",
        slots: [{ startsAt: "2026-07-16T15:00:00Z" }],
      }),
      "bookings.update": ok({ booking: { id: "booking-1" } }),
      "bookings.guestLinks.create": ok({ rescheduleUrl: "https://x/y" }),
    });

    const result = await runTool(tool(), api, {
      bookingId: "booking-1",
      slotAt: "2026-07-16T15:00:00Z",
    });

    const update = calls.find(
      (call) => call.operation.id === "bookings.update"
    );

    expect(update?.pathParams).toEqual({ id: "booking-1" });
    expect(update?.body).toEqual({ slotAt: "2026-07-16T15:00:00Z" });

    const links = calls.find(
      (call) => call.operation.id === "bookings.guestLinks.create"
    );

    expect(links?.pathParams).toEqual({ id: "booking-1" });
    expect(links?.body).toEqual({ expiresInHours: 168 });

    expect(result).toEqual({
      rescheduled: true,
      booking: { booking: { id: "booking-1" } },
      guestLinks: { rescheduleUrl: "https://x/y" },
    });
  });

  it("sends the caller's link window when they name one", async () => {
    const { api, calls } = stubApi({
      "bookings.get": ok({ booking: { id: "booking-1", bookingTypeId: null } }),
      "bookings.availability": ok({ source: "fallback", slots: [] }),
      "bookings.update": ok({ booking: { id: "booking-1" } }),
      "bookings.guestLinks.create": ok({ rescheduleUrl: "https://x/y" }),
    });

    await runTool(tool(), api, {
      bookingId: "booking-1",
      slotAt: "2026-07-16T15:00:00Z",
      expiresInHours: 24,
    });

    const links = calls.find(
      (call) => call.operation.id === "bookings.guestLinks.create"
    );

    expect(links?.body).toEqual({ expiresInHours: 24 });
  });

  it("accepts each API provider and rejects any other", () => {
    const provider = tool().inputSchema.provider;

    expect(accepts(provider, "google_calendar")).toBe(true);
    expect(accepts(provider, "outlook")).toBe(false);
  });

  it("asks about availability with the provider but leaves it off the move", async () => {
    const { api, calls } = stubApi({
      "bookings.get": ok({ booking: { id: "booking-1", bookingTypeId: null } }),
      "bookings.availability": ok({
        source: "live_provider",
        slots: [{ startsAt: "2026-07-16T15:00:00Z" }],
      }),
      "bookings.update": ok({ booking: { id: "booking-1" } }),
      "bookings.guestLinks.create": ok({ rescheduleUrl: "https://x/y" }),
    });

    await runTool(tool(), api, {
      bookingId: "booking-1",
      slotAt: "2026-07-16T15:00:00Z",
      provider: "cal_com",
    });

    expect(
      calls.find((call) => call.operation.id === "bookings.availability")?.query
    ).toMatchObject({ provider: "cal_com" });
    expect(
      calls.find((call) => call.operation.id === "bookings.update")?.body
    ).toEqual({ slotAt: "2026-07-16T15:00:00Z" });
  });

  it("skips the availability check on a keyed retry and moves the call", async () => {
    const { api, calls } = stubApi({
      "bookings.get": ok({ booking: { id: "booking-1", bookingTypeId: null } }),
      "bookings.availability": ok({ source: "live_provider", slots: [] }),
      "bookings.update": ok({ booking: { id: "booking-1" } }),
      "bookings.guestLinks.create": ok({ rescheduleUrl: "https://x/y" }),
    });

    const result = await runTool(tool(), api, {
      bookingId: "booking-1",
      slotAt: "2026-07-16T15:00:00Z",
      idempotencyKey: "retry-1",
    });

    expect(
      calls.some((call) => call.operation.id === "bookings.availability")
    ).toBe(false);
    expect(result).toMatchObject({ rescheduled: true });
  });

  it("refuses to move a call into a slot the provider says is taken", async () => {
    const { api, calls } = stubApi({
      "bookings.get": ok({ booking: { id: "booking-1", bookingTypeId: null } }),
      "bookings.availability": ok({
        source: "live_provider",
        slots: [{ startsAt: "2026-07-16T16:00:00Z" }],
      }),
      "bookings.update": ok({ booking: { id: "booking-1" } }),
      "bookings.guestLinks.create": ok({ rescheduleUrl: "https://x/y" }),
    });

    const result = await runTool(tool(), api, {
      bookingId: "booking-1",
      slotAt: "2026-07-16T15:00:00Z",
    });

    expect(result).toEqual({
      rescheduled: false,
      reason: "slot_not_available",
      requestedSlotAt: "2026-07-16T15:00:00Z",
      openSlots: ["2026-07-16T16:00:00Z"],
    });
    expect(calls.some((call) => call.operation.id === "bookings.update")).toBe(
      false
    );
  });

  it("still reports the move when the link mint fails", async () => {
    const { api } = stubApi({
      "bookings.get": ok({ booking: { id: "booking-1", bookingTypeId: null } }),
      "bookings.availability": ok({
        source: "live_provider",
        slots: [{ startsAt: "2026-07-16T15:00:00Z" }],
      }),
      "bookings.update": ok({ booking: { id: "booking-1" } }),
      "bookings.guestLinks.create": bad("link service down"),
    });

    const result = await runTool(tool(), api, {
      bookingId: "booking-1",
      slotAt: "2026-07-16T15:00:00Z",
    });

    // The call has already moved. Failing here would tell the agent it had not.
    expect(result).toMatchObject({ rescheduled: true });
    const guestLinks = (result as JsonRecord).guestLinks as JsonRecord;
    expect(String(guestLinks.guestLinksError)).toContain("link service down");
  });

  describe("on a booking with a booking type", () => {
    const BOOKING = ok({
      booking: { id: "booking-1", bookingTypeId: "type-1" },
    });

    const move = {
      bookingId: "booking-1",
      slotAt: "2026-07-16T15:00:00Z",
    };

    it("checks the new slot against the booking type's schedule", async () => {
      const { api, calls } = stubApi({
        "bookings.get": BOOKING,
        "bookings.managedAvailability": ok({
          slots: [{ startsAt: "2026-07-16T15:00:00.000Z" }],
        }),
        "bookings.update": ok({ booking: { id: "booking-1" } }),
        "bookings.guestLinks.create": ok({ rescheduleUrl: "https://x/y" }),
      });

      const result = await runTool(tool(), api, move);

      expect(result).toMatchObject({ rescheduled: true });
      expect(calls.map((call) => call.operation.id)).toEqual([
        "bookings.get",
        "bookings.managedAvailability",
        "bookings.update",
        "bookings.guestLinks.create",
      ]);
      expect(nth(calls, 0).pathParams).toEqual({ id: "booking-1" });
      expect(nth(calls, 1).query).toEqual({
        bookingTypeId: "type-1",
        timezone: "UTC",
        start: "2026-07-16T15:00:00.000Z",
        end: "2026-07-17T15:00:00.000Z",
      });
    });

    it("refuses a slot the booking type does not offer and returns the open ones", async () => {
      const { api, calls } = stubApi({
        "bookings.get": BOOKING,
        "bookings.managedAvailability": ok({
          slots: [{ startsAt: "2026-07-16T16:00:00Z" }],
        }),
        "bookings.update": ok({ booking: { id: "booking-1" } }),
      });

      const result = await runTool(tool(), api, move);

      expect(result).toEqual({
        rescheduled: false,
        reason: "slot_not_available",
        requestedSlotAt: "2026-07-16T15:00:00Z",
        openSlots: ["2026-07-16T16:00:00Z"],
      });
      expect(
        calls.some((call) => call.operation.id === "bookings.update")
      ).toBe(false);
    });

    it("moves the call when the booking type's availability cannot be read", async () => {
      const { api } = stubApi({
        "bookings.get": BOOKING,
        "bookings.managedAvailability": bad("scheduler down"),
        "bookings.update": ok({ booking: { id: "booking-1" } }),
        "bookings.guestLinks.create": ok({ rescheduleUrl: "https://x/y" }),
      });

      expect(await runTool(tool(), api, move)).toMatchObject({
        rescheduled: true,
      });
    });

    it("skips the booking read and the check on a keyed retry", async () => {
      const { api, calls } = stubApi({
        "bookings.update": ok({ booking: { id: "booking-1" } }),
        "bookings.guestLinks.create": ok({ rescheduleUrl: "https://x/y" }),
      });

      await runTool(tool(), api, { ...move, idempotencyKey: "retry-1" });

      expect(calls.map((call) => call.operation.id)).toEqual([
        "bookings.update",
        "bookings.guestLinks.create",
      ]);
    });
  });

  it("checks the provider calendar when the booking has no booking type", async () => {
    const { api, calls } = stubApi({
      "bookings.get": ok({ booking: { id: "booking-1", bookingTypeId: null } }),
      "bookings.availability": ok({
        source: "live_provider",
        slots: [{ startsAt: "2026-07-16T15:00:00Z" }],
      }),
      "bookings.update": ok({ booking: { id: "booking-1" } }),
      "bookings.guestLinks.create": ok({ rescheduleUrl: "https://x/y" }),
    });

    await runTool(tool(), api, {
      bookingId: "booking-1",
      slotAt: "2026-07-16T15:00:00Z",
    });

    expect(calls.map((call) => call.operation.id)).toEqual([
      "bookings.get",
      "bookings.availability",
      "bookings.update",
      "bookings.guestLinks.create",
    ]);
  });

  it("checks the provider calendar when the booking cannot be read", async () => {
    const { api, calls } = stubApi({
      "bookings.get": bad("bookings down"),
      "bookings.availability": ok({
        source: "live_provider",
        slots: [{ startsAt: "2026-07-16T16:00:00Z" }],
      }),
      "bookings.update": ok({ booking: { id: "booking-1" } }),
    });

    const result = await runTool(tool(), api, {
      bookingId: "booking-1",
      slotAt: "2026-07-16T15:00:00Z",
    });

    expect(result).toMatchObject({
      rescheduled: false,
      reason: "slot_not_available",
    });
    expect(calls.map((call) => call.operation.id)).toEqual([
      "bookings.get",
      "bookings.availability",
    ]);
  });

  it("fails instead of moving the call when the booking read is refused", async () => {
    const { api, calls } = stubApi({
      "bookings.get": () =>
        Effect.fail(
          new LucaHttpError({
            status: 401,
            statusText: "Unauthorized",
            body: { error: { code: "unauthorized" } },
          })
        ),
      "bookings.update": ok({ booking: { id: "booking-1" } }),
    });

    await expect(
      runTool(tool(), api, {
        bookingId: "booking-1",
        slotAt: "2026-07-16T15:00:00Z",
      })
    ).rejects.toBeInstanceOf(LucaHttpError);
    expect(calls.map((call) => call.operation.id)).toEqual(["bookings.get"]);
  });
});

describe("luca_analytics_rollup", () => {
  const tool = () => getTool("luca_analytics_rollup");

  it("pins the exact metadata", () => {
    expect(tool().title).toBe("Get campaign and broadcast analytics");
    expect(fromTaskTool(tool()).readOnly).toBe(true);
    expect(fromTaskTool(tool()).untrustedContent).toBe(false);
    expect(fromTaskTool(tool()).confirm).toBeUndefined();
    expect(tool().composes).toEqual([
      "campaigns.list",
      "campaigns.analytics",
      "broadcasts.list",
    ]);
    expect(sorted(R.keys(fromTaskTool(tool()).inputSchema))).toEqual(
      sorted(["campaignLimit", "workspaceId", "workspaceSlug"])
    );
  });

  it("pins the exact field description", () => {
    expect(inputJsonSchema(tool()).properties).toMatchObject({
      campaignLimit: {
        description: "How many recent campaigns to include (default 5).",
      },
    });
  });

  it("rejects a campaignLimit below 1 and above 5, accepts the boundaries", () => {
    const campaignLimit = tool().inputSchema.campaignLimit;

    expect(accepts(campaignLimit, 0)).toBe(false);
    expect(accepts(campaignLimit, 1)).toBe(true);
    expect(accepts(campaignLimit, 5)).toBe(true);
    expect(accepts(campaignLimit, 6)).toBe(false);
  });

  it("defaults campaignLimit to 5, fetches analytics per campaign id, skips id-less campaigns, and always lists 10 broadcasts", async () => {
    const { api, calls } = stubApi({
      "campaigns.list": ok({
        items: [
          { id: "c1" },
          {},
          { id: "c2" },
          { id: "c3" },
          { id: "c4" },
          { id: "c5" },
          { id: "c6" },
        ],
      }),
      "campaigns.analytics": ok({ sent: 10 }),
      "broadcasts.list": ok({ items: [] }),
    });

    const result = (await runTool(tool(), api, {})) as {
      campaigns: JsonRecord;
      broadcasts: JsonValue;
    };

    const listCall = calls.find((c) => c.operation.id === "campaigns.list");
    expect(listCall?.query).toEqual({ limit: 5 });

    const broadcastsCall = calls.find(
      (c) => c.operation.id === "broadcasts.list"
    );

    expect(broadcastsCall?.query).toEqual({ limit: 10 });

    // 5 campaigns fall within slice(0, 5): c1, {}, c2, c3, c4 — the id-less
    // one is skipped, so exactly 4 analytics calls are made (c5 and c6 are
    // outside the default 5-campaign window entirely).
    const analyticsCalls = calls.filter(
      (c) => c.operation.id === "campaigns.analytics"
    );

    expect(analyticsCalls).toHaveLength(4);
    expect(analyticsCalls.map((c) => c.pathParams)).toEqual([
      { id: "c1" },
      { id: "c2" },
      { id: "c3" },
      { id: "c4" },
    ]);
    expect(result.campaigns).toEqual({
      c1: { sent: 10 },
      c2: { sent: 10 },
      c3: { sent: 10 },
      c4: { sent: 10 },
    });
  });

  it("honors an explicit campaignLimit for both the list query and the analytics window", async () => {
    const { api, calls } = stubApi({
      "campaigns.list": ok({
        items: [{ id: "c1" }, { id: "c2" }, { id: "c3" }, { id: "c4" }],
      }),
      "campaigns.analytics": ok({ sent: 1 }),
      "broadcasts.list": ok({ items: [] }),
    });

    const result = (await runTool(tool(), api, { campaignLimit: 2 })) as {
      campaigns: JsonRecord;
    };

    const listCall = calls.find((c) => c.operation.id === "campaigns.list");
    expect(listCall?.query).toEqual({ limit: 2 });
    expect(sorted(R.keys(result.campaigns))).toEqual(["c1", "c2"]);
  });

  it("tolerates a campaigns.list response with no items field", async () => {
    const { api, calls } = stubApi({
      "campaigns.list": ok({}),
      "broadcasts.list": ok({ items: [] }),
    });

    const result = (await runTool(tool(), api, {})) as {
      campaigns: JsonRecord;
    };

    expect(result.campaigns).toEqual({});
    expect(
      calls.filter((c) => c.operation.id === "campaigns.analytics")
    ).toHaveLength(0);
    expect(calls.some((c) => c.operation.id === "broadcasts.list")).toBe(true);
  });

  it("converts a failed analytics call into a structured analyticsError", async () => {
    const { api } = stubApi({
      "campaigns.list": ok({ items: [{ id: "c1" }] }),
      "campaigns.analytics": bad("analytics down"),
      "broadcasts.list": ok({ items: [] }),
    });

    const result = (await runTool(tool(), api, {})) as {
      campaigns: JsonRecord;
    };

    expect(result.campaigns).toEqual({
      c1: { analyticsError: "analytics down" },
    });
  });

  it("returns the broadcasts and names campaigns when the campaign list fails", async () => {
    const { api } = stubApi({
      "campaigns.list": bad("campaigns down"),
      "broadcasts.list": ok({ items: [{ id: "b1" }] }),
    });

    const result = await runTool(tool(), api, {});

    expect(result).toEqual({
      broadcasts: { items: [{ id: "b1" }] },
      failedSections: [{ section: "campaigns", error: "campaigns down" }],
    });
  });

  it("returns the campaigns and names broadcasts when the broadcast list fails", async () => {
    const { api } = stubApi({
      "campaigns.list": ok({ items: [{ id: "c1" }] }),
      "campaigns.analytics": ok({ sent: 3 }),
      "broadcasts.list": bad("broadcasts down"),
    });

    const result = await runTool(tool(), api, {});

    expect(result).toEqual({
      campaigns: { c1: { sent: 3 } },
      failedSections: [{ section: "broadcasts", error: "broadcasts down" }],
    });
  });

  it("fails when both halves fail", async () => {
    const { api } = stubApi({
      "campaigns.list": bad("campaigns down"),
      "broadcasts.list": bad("broadcasts down"),
    });

    await expect(runTool(tool(), api, {})).rejects.toThrow();
  });

  it("leaves failedSections off when everything loads", async () => {
    const { api } = stubApi({
      "campaigns.list": ok({ items: [] }),
      "broadcasts.list": ok({ items: [] }),
    });

    expect(await runTool(tool(), api, {})).not.toHaveProperty("failedSections");
  });

  it("runs the per-campaign analytics calls and broadcasts.list side by side", async () => {
    const { api, calls, peak } = concurrencyTrackingApi((operationId) => {
      if (operationId === "campaigns.list") {
        return {
          items: [
            { id: "c1" },
            { id: "c2" },
            { id: "c3" },
            { id: "c4" },
            { id: "c5" },
          ],
        };
      }

      if (operationId === "campaigns.analytics") {
        return { sent: 1 };
      }

      return { items: [] };
    }, 6);

    await runTool(tool(), api, {});

    expect(
      calls.filter((c) => c.operation.id === "campaigns.analytics")
    ).toHaveLength(5);
    expect(calls.some((c) => c.operation.id === "broadcasts.list")).toBe(true);
    // campaigns.list has to resolve first (the fan-out needs its ids), but
    // the 5 analytics calls and broadcasts.list are independent of each
    // other and should overlap. Sequential execution (Effect.all's default,
    // or broadcasts.list run after the loop instead of alongside it) would
    // never see more than one call in flight at a time.
    expect(peak()).toBe(6);
  });
});

describe("luca_draft_reply", () => {
  const tool = () => getTool("luca_draft_reply");

  it("pins the exact metadata", () => {
    expect(tool().title).toBe("Draft a reply for a lead");
    expect(fromTaskTool(tool()).readOnly).toBe(false);
    expect(fromTaskTool(tool()).untrustedContent).toBe(true);
    expect(fromTaskTool(tool()).confirm).toBeUndefined();
    expect(tool().composes).toEqual(["leads.draft"]);
    expect(sorted(R.keys(fromTaskTool(tool()).inputSchema))).toEqual(
      sorted([
        "guidance",
        "idempotencyKey",
        "leadId",
        "workspaceId",
        "workspaceSlug",
      ])
    );
  });

  it("pins the exact field descriptions", () => {
    const schema = fieldDescriptions(tool());

    expect(schema.leadId?.description).toBe("The lead to draft a reply for.");
    expect(schema.guidance?.description).toBe(
      "Optional steer for tone or content of the draft."
    );
    expect(schema.idempotencyKey?.description).toBe(
      "Reuse the same key when retrying this exact draft."
    );
  });

  it("sends guidance in the body when given", async () => {
    const { api, calls } = stubApi({ "leads.draft": ok({ id: "draft-1" }) });

    await runTool(tool(), api, { leadId: "lead-1", guidance: "keep it short" });

    expect(nth(calls, 0).pathParams).toEqual({ id: "lead-1" });
    expect(nth(calls, 0).body).toEqual({ guidance: "keep it short" });
  });

  it("omits the body entirely when guidance is not given", async () => {
    const { api, calls } = stubApi({ "leads.draft": ok({ id: "draft-1" }) });

    await runTool(tool(), api, { leadId: "lead-1" });

    expect("body" in nth(calls, 0)).toBe(false);
  });

  it("omits the body when guidance is an empty string", async () => {
    // An empty guidance field means the caller gave no steer, which is not the
    // same request as one that steers the drafter with an empty instruction.
    const { api, calls } = stubApi({ "leads.draft": ok({ id: "draft-1" }) });

    await runTool(tool(), api, { leadId: "lead-1", guidance: "" });

    expect("body" in nth(calls, 0)).toBe(false);
  });
});

describe("luca_approve_and_send", () => {
  const tool = () => getTool("luca_approve_and_send");

  it("pins the exact metadata", () => {
    expect(tool().title).toBe("Approve a drafted reply and send it");
    expect(fromTaskTool(tool()).readOnly).toBe(false);
    expect(fromTaskTool(tool()).untrustedContent).toBe(false);
    expect(fromTaskTool(tool()).confirm).toBe("always");
    expect(tool().composes).toEqual(["reviewQueue.approve"]);
    expect(sorted(R.keys(fromTaskTool(tool()).inputSchema))).toEqual(
      sorted([
        "confirm",
        "finalBody",
        "idempotencyKey",
        "reviewQueueId",
        "workspaceId",
        "workspaceSlug",
      ])
    );
  });

  it("pins the exact field descriptions", () => {
    const schema = fieldDescriptions(tool());

    expect(schema.reviewQueueId?.description).toBe(
      "The review-queue item to approve."
    );
    expect(schema.finalBody?.description).toBe(
      "Optional edited body to send instead of the drafted text."
    );
    expect(schema.confirm?.description).toBe(
      "This tool has a real-world side effect: it messages real leads, books, moves, or cancels a call, changes a lead's consent, imports leads, writes to a connected calendar or CRM, sends workspace events to an outside URL, or re-triggers downstream automations. Pass confirm: true to proceed; the call is rejected without it."
    );
    expect(schema.idempotencyKey?.description).toBe(
      "Reuse the same key when retrying this exact approval."
    );
  });

  it("rejects an empty finalBody, accepts a short one", () => {
    const finalBody = tool().inputSchema.finalBody;

    expect(accepts(finalBody, "")).toBe(false);
    expect(accepts(finalBody, "ab")).toBe(true);
  });

  it("sends finalBody in the body when given", async () => {
    const { api, calls } = stubApi({
      "reviewQueue.approve": ok({ status: "approved" }),
    });

    await runTool(tool(), api, {
      reviewQueueId: "rq-1",
      finalBody: "edited text",
      confirm: true,
    });

    expect(nth(calls, 0).pathParams).toEqual({ id: "rq-1" });
    expect(nth(calls, 0).body).toEqual({ finalBody: "edited text" });
  });

  it("omits the body entirely when finalBody is not given", async () => {
    const { api, calls } = stubApi({
      "reviewQueue.approve": ok({ status: "approved" }),
    });

    await runTool(tool(), api, { reviewQueueId: "rq-1", confirm: true });

    expect("body" in nth(calls, 0)).toBe(false);
  });
});

describe("luca_rescue_silent_leads", () => {
  const tool = () => getTool("luca_rescue_silent_leads");

  it("pins the exact metadata", () => {
    expect(tool().title).toBe("Enroll silent leads into the rescue cadence");
    expect(fromTaskTool(tool()).readOnly).toBe(false);
    expect(fromTaskTool(tool()).untrustedContent).toBe(false);
    expect(fromTaskTool(tool()).confirm).toBe("always");
    expect(tool().composes).toEqual(["cadences.rescueStart"]);
    expect(sorted(R.keys(fromTaskTool(tool()).inputSchema))).toEqual(
      sorted([
        "cadenceTemplate",
        "confirm",
        "idempotencyKey",
        "leadIds",
        "workspaceId",
        "workspaceSlug",
      ])
    );
  });

  it("pins the exact field descriptions", () => {
    const schema = fieldDescriptions(tool());

    expect(schema.leadIds?.description).toBe(
      "Lead ids to enroll (max 100). Non-tenant ids are skipped."
    );
    expect(schema.cadenceTemplate?.description).toBe(
      "Cadence intensity (default standard)."
    );
    expect(schema.idempotencyKey?.description).toBe(
      "Reuse the same key when retrying this exact enrollment."
    );
  });

  it("rejects an empty leadIds array and more than 100, accepts 1 and 100", () => {
    const leadIds = tool().inputSchema.leadIds;

    expect(accepts(leadIds, [])).toBe(false);
    expect(accepts(leadIds, ["a"])).toBe(true);
    expect(accepts(leadIds, ["a", "b"])).toBe(true);
    expect(
      accepts(
        leadIds,
        Array.from({ length: 100 }, (_, i) => `l${i}`)
      )
    ).toBe(true);
    expect(
      accepts(
        leadIds,
        Array.from({ length: 101 }, (_, i) => `l${i}`)
      )
    ).toBe(false);
  });

  it("only accepts light, standard, or aggressive as the cadence template", () => {
    const cadenceTemplate = tool().inputSchema.cadenceTemplate;

    expect(accepts(cadenceTemplate, "light")).toBe(true);
    expect(accepts(cadenceTemplate, "standard")).toBe(true);
    expect(accepts(cadenceTemplate, "aggressive")).toBe(true);
    expect(accepts(cadenceTemplate, "bogus")).toBe(false);
  });

  it("sends leadIds and an explicit cadenceTemplate", async () => {
    const { api, calls } = stubApi({
      "cadences.rescueStart": ok({ enrolled: [] }),
    });

    await runTool(tool(), api, {
      leadIds: ["lead-1", "lead-2"],
      cadenceTemplate: "aggressive",
      confirm: true,
    });

    expect(nth(calls, 0).body).toEqual({
      leadIds: ["lead-1", "lead-2"],
      cadenceTemplate: "aggressive",
    });
  });

  it("omits cadenceTemplate from the body when not given", async () => {
    const { api, calls } = stubApi({
      "cadences.rescueStart": ok({ enrolled: [] }),
    });

    await runTool(tool(), api, { leadIds: ["lead-1"], confirm: true });

    expect(nth(calls, 0).body).toEqual({ leadIds: ["lead-1"] });
  });
});

describe("luca_pause_cadence", () => {
  const tool = () => getTool("luca_pause_cadence");

  it("pins the exact metadata", () => {
    expect(tool().title).toBe("Pause a lead's rescue cadence");
    expect(fromTaskTool(tool()).readOnly).toBe(false);
    expect(fromTaskTool(tool()).untrustedContent).toBe(false);
    expect(fromTaskTool(tool()).confirm).toBeUndefined();
    expect(tool().composes).toEqual(["cadences.pause"]);
    expect(sorted(R.keys(fromTaskTool(tool()).inputSchema))).toEqual(
      sorted([
        "idempotencyKey",
        "leadId",
        "reason",
        "workspaceId",
        "workspaceSlug",
      ])
    );
  });

  it("pins the exact field descriptions", () => {
    const schema = fieldDescriptions(tool());

    expect(schema.leadId?.description).toBe("The lead whose cadence to pause.");
    expect(schema.reason?.description).toBe(
      "Optional operator reason, stored on the cadence."
    );
    expect(schema.idempotencyKey?.description).toBe(
      "Reuse the same key when retrying this exact pause."
    );
  });

  it("sends reason in the body when given", async () => {
    const { api, calls } = stubApi({
      "cadences.pause": ok({ status: "paused" }),
    });

    await runTool(tool(), api, {
      leadId: "lead-1",
      reason: "replied elsewhere",
    });

    expect(nth(calls, 0).pathParams).toEqual({ id: "lead-1" });
    expect(nth(calls, 0).body).toEqual({ reason: "replied elsewhere" });
  });

  it("omits the body entirely when reason is not given", async () => {
    const { api, calls } = stubApi({
      "cadences.pause": ok({ status: "paused" }),
    });

    await runTool(tool(), api, { leadId: "lead-1" });

    expect("body" in nth(calls, 0)).toBe(false);
  });
});

describe("luca_morning_report", () => {
  const tool = () => getTool("luca_morning_report");

  it("pins the exact metadata", () => {
    expect(tool().title).toBe("Get the morning digest");
    expect(fromTaskTool(tool()).readOnly).toBe(true);
    expect(fromTaskTool(tool()).untrustedContent).toBe(true);
    expect(fromTaskTool(tool()).confirm).toBeUndefined();
    expect(tool().composes).toEqual(["reports.morning"]);
    expect(sorted(R.keys(fromTaskTool(tool()).inputSchema))).toEqual(
      sorted(["workspaceId", "workspaceSlug"])
    );
  });

  it("passes through the raw report with no extra request parts when no overrides are given", async () => {
    const { api, calls } = stubApi({
      "reports.morning": ok({ queued: 3, byStatus: { pending: 3 } }),
    });

    const result = await runTool(tool(), api, {});

    expect(result).toEqual({ queued: 3, byStatus: { pending: 3 } });
    // oxlint-disable-next-line effect/avoid-native-object-helpers -- `R.keys` takes an index-signature record, and `LucaRequest` is a closed object type
    expect(sorted(Object.keys(nth(calls, 0)))).toEqual(["operation"]);
  });

  it("folds in an idempotencyKey override when given", async () => {
    const { api, calls } = stubApi({ "reports.morning": ok({}) });

    await runTool(tool(), api, { idempotencyKey: "idem-1" });

    expect(nth(calls, 0).idempotencyKey).toBe("idem-1");
  });

  it("folds in a workspaceId-only override, keeping workspaceSlug absent", async () => {
    const { api, calls } = stubApi({ "reports.morning": ok({}) });

    await runTool(tool(), api, { workspaceId: "ws-1" });

    expect(nth(calls, 0).workspace).toEqual({ workspaceId: "ws-1" });
  });

  it("folds in a workspaceSlug-only override, keeping workspaceId absent", async () => {
    const { api, calls } = stubApi({ "reports.morning": ok({}) });

    await runTool(tool(), api, { workspaceSlug: "ws-slug" });

    expect(nth(calls, 0).workspace).toEqual({ workspaceSlug: "ws-slug" });
  });

  it("folds in both workspaceId and workspaceSlug when both are given", async () => {
    const { api, calls } = stubApi({ "reports.morning": ok({}) });

    await runTool(tool(), api, {
      workspaceId: "ws-1",
      workspaceSlug: "ws-slug",
    });

    expect(nth(calls, 0).workspace).toEqual({
      workspaceId: "ws-1",
      workspaceSlug: "ws-slug",
    });
  });

  it("sends no workspace override at all when neither is given", async () => {
    const { api, calls } = stubApi({ "reports.morning": ok({}) });

    await runTool(tool(), api, {});

    expect("workspace" in nth(calls, 0)).toBe(false);
  });
});

describe("luca_analytics_magic_monday", () => {
  // Resolve the tool inside each test (not at describe-body level): a mutation
  // that blanks the tool's `name` makes `getTool` throw, and a throw here would
  // abort collection of the whole file — which Stryker cannot attribute to any
  // single test, letting the mutant survive. Resolving lazily keeps the throw
  // inside a test so it registers as a kill.
  it("pins the exact metadata", () => {
    const tool = getTool("luca_analytics_magic_monday");
    expect(tool.name).toBe("luca_analytics_magic_monday");
    expect(tool.title).toBe("Get the Magic Monday report");
    expect(fromTaskTool(tool).readOnly).toBe(true);
    expect(fromTaskTool(tool).untrustedContent).toBe(false);
    expect(fromTaskTool(tool).confirm).toBeUndefined();
    expect(tool.composes).toEqual([
      "analytics.funnel",
      "analytics.revenue",
      "analytics.speedImpact",
      "analytics.forecast",
      "analytics.callIntelligence",
    ]);
    expect(sorted(R.keys(fromTaskTool(tool).inputSchema))).toEqual(
      sorted(["workspaceId", "workspaceSlug"])
    );
  });

  it("composes five this-week analytics reads and returns them keyed by report", async () => {
    const tool = getTool("luca_analytics_magic_monday");

    const { api, calls } = stubApi({
      "analytics.funnel": ok({ report: "funnel" }),
      "analytics.revenue": ok({ report: "revenue" }),
      "analytics.speedImpact": ok({ report: "speed" }),
      "analytics.forecast": ok({ report: "forecast" }),
      "analytics.callIntelligence": ok({ report: "calls" }),
    });

    const result = await runTool(tool, api, {});

    expect(result).toEqual({
      funnel: { report: "funnel" },
      revenue: { report: "revenue" },
      speedImpact: { report: "speed" },
      forecast: { report: "forecast" },
      callIntelligence: { report: "calls" },
    });

    // The four period-scoped reads all carry period=this_week; forecast is
    // point-in-time and sends no query at all.
    const byId = (id: string) => calls.find((c) => c.operation.id === id);
    expect(byId("analytics.funnel")?.query).toEqual({ period: "this_week" });
    expect(byId("analytics.revenue")?.query).toEqual({ period: "this_week" });
    expect(byId("analytics.speedImpact")?.query).toEqual({
      period: "this_week",
    });
    expect(byId("analytics.callIntelligence")?.query).toEqual({
      period: "this_week",
    });
    expect("query" in (byId("analytics.forecast") as object)).toBe(false);
    expect(calls).toHaveLength(5);
  });

  it("runs the five reads side by side instead of one at a time", async () => {
    const tool = getTool("luca_analytics_magic_monday");

    const { calls, peak, api } = concurrencyTrackingApi(
      () => ({ report: "ok" }),
      5
    );

    await runTool(tool, api, {});

    expect(calls).toHaveLength(5);
    // Effect.all defaults to sequential; this fails if `concurrency:
    // "unbounded"` is dropped from analyticsFanOut.
    expect(peak()).toBe(5);
  });

  it("keeps the other sections and names the one whose read failed", async () => {
    const tool = getTool("luca_analytics_magic_monday");

    const { api } = stubApi({
      "analytics.funnel": ok({ report: "funnel" }),
      "analytics.revenue": ok({ report: "revenue" }),
      "analytics.speedImpact": bad("speed impact down"),
      "analytics.forecast": ok({ report: "forecast" }),
      "analytics.callIntelligence": ok({ report: "calls" }),
    });

    const result = await runTool(tool, api, {});

    expect(result).toEqual({
      funnel: { report: "funnel" },
      revenue: { report: "revenue" },
      forecast: { report: "forecast" },
      callIntelligence: { report: "calls" },
      failedSections: [
        {
          section: "speedImpact",
          error: expect.stringContaining("speed impact down"),
        },
      ],
    });
  });

  it("fails when every read fails, since an empty report answers nothing", async () => {
    const tool = getTool("luca_analytics_magic_monday");

    const { api } = stubApi({
      "analytics.funnel": bad("down"),
      "analytics.revenue": bad("down"),
      "analytics.speedImpact": bad("down"),
      "analytics.forecast": bad("down"),
      "analytics.callIntelligence": bad("down"),
    });

    await expect(runTool(tool, api, {})).rejects.toThrow();
  });
});

describe("luca_analytics_deep_dive", () => {
  // Lazy tool resolution inside each test — see the note on
  // luca_analytics_magic_monday for why a describe-body `getTool` would let a
  // blanked-`name` mutant survive.
  it("pins the exact metadata", () => {
    const tool = getTool("luca_analytics_deep_dive");
    expect(tool.name).toBe("luca_analytics_deep_dive");
    expect(tool.title).toBe("Run a deep-dive analytics investigation");
    expect(fromTaskTool(tool).readOnly).toBe(true);
    expect(fromTaskTool(tool).untrustedContent).toBe(true);
    expect(fromTaskTool(tool).confirm).toBeUndefined();
    expect(tool.composes).toEqual([
      "analytics.funnel",
      "analytics.revenue",
      "analytics.speedImpact",
      "analytics.forecast",
      "analytics.callIntelligence",
      "analytics.ghostedLeads",
      "analytics.trustScore",
    ]);
    expect(sorted(R.keys(fromTaskTool(tool).inputSchema))).toEqual(
      sorted(["period", "question", "workspaceId", "workspaceSlug"])
    );
  });

  it("only accepts the five documented period values", () => {
    const tool = getTool("luca_analytics_deep_dive");

    const period = tool.inputSchema.period;

    Arr.forEach(
      ["this_week", "this_month", "last_week", "last_month", "last_30_days"],
      (value) => {
        expect(accepts(period, value)).toBe(true);
      }
    );

    expect(accepts(period, "yesterday")).toBe(false);
  });

  it("leaves the question optional", async () => {
    const tool = getTool("luca_analytics_deep_dive");
    const { api, calls } = deepDiveStub();

    await runTool(tool, api, {});

    expect(calls).toHaveLength(7);
  });

  it("bounds the question to a non-empty string of at most 500 chars", () => {
    const tool = getTool("luca_analytics_deep_dive");

    const question = tool.inputSchema.question;

    // Empty rejected by the min(1); a normal-length question accepted (this one
    // string kills both the dropped-`min` and the `max`→`min` mutants: it is
    // longer than 1 char and far shorter than 500); a 501-char string rejected
    // by the max(500).
    expect(accepts(question, "")).toBe(false);
    expect(accepts(question, "why did close rate drop?")).toBe(true);
    expect(accepts(question, "x".repeat(501))).toBe(false);
    expect(accepts(question, "x".repeat(500))).toBe(true);
  });

  it("documents the question and period fields for the caller", () => {
    const tool = getTool("luca_analytics_deep_dive");

    const { question, period } = fieldDescriptions(tool);

    expect(question?.description).toContain("question");
    expect(period?.description).toContain("Period");
  });

  function deepDiveStub() {
    return stubApi({
      "analytics.funnel": ok({ report: "funnel" }),
      "analytics.revenue": ok({ report: "revenue" }),
      "analytics.speedImpact": ok({ report: "speed" }),
      "analytics.forecast": ok({ report: "forecast" }),
      "analytics.callIntelligence": ok({ report: "calls" }),
      "analytics.ghostedLeads": ok({ report: "ghosted" }),
      "analytics.trustScore": ok({ report: "trust" }),
    });
  }

  it("composes all seven reads and returns them keyed by report", async () => {
    const tool = getTool("luca_analytics_deep_dive");
    const { api, calls } = deepDiveStub();

    const result = await runTool(tool, api, {
      question: "why did close rate drop?",
    });

    expect(result).toEqual({
      funnel: { report: "funnel" },
      revenue: { report: "revenue" },
      speedImpact: { report: "speed" },
      forecast: { report: "forecast" },
      callIntelligence: { report: "calls" },
      ghostedLeads: { report: "ghosted" },
      trustScore: { report: "trust" },
    });
    expect(calls).toHaveLength(7);
  });

  it("defaults the period to this_month across the period-scoped reads, leaving forecast point-in-time", async () => {
    const tool = getTool("luca_analytics_deep_dive");
    const { api, calls } = deepDiveStub();

    await runTool(tool, api, { question: "q" });

    const byId = (id: string) => calls.find((c) => c.operation.id === id);

    Arr.forEach(
      [
        "analytics.funnel",
        "analytics.revenue",
        "analytics.speedImpact",
        "analytics.callIntelligence",
        "analytics.ghostedLeads",
        "analytics.trustScore",
      ],
      (id) => {
        expect(byId(id)?.query).toEqual({ period: "this_month" });
      }
    );

    expect("query" in (byId("analytics.forecast") as object)).toBe(false);
  });

  it("threads an explicit period through every period-scoped read", async () => {
    const tool = getTool("luca_analytics_deep_dive");
    const { api, calls } = deepDiveStub();

    await runTool(tool, api, { question: "q", period: "last_week" });

    const byId = (id: string) => calls.find((c) => c.operation.id === id);

    Arr.forEach(
      [
        "analytics.funnel",
        "analytics.revenue",
        "analytics.speedImpact",
        "analytics.callIntelligence",
        "analytics.ghostedLeads",
        "analytics.trustScore",
      ],
      (id) => {
        expect(byId(id)?.query).toEqual({ period: "last_week" });
      }
    );

    expect("query" in (byId("analytics.forecast") as object)).toBe(false);
  });

  it("falls back to this_month when period arrives invalid, bypassing the input schema", async () => {
    // inputSchema.period already rejects an out-of-enum value at the MCP
    // boundary, but run() re-validates defensively (the same pattern as
    // numberInput elsewhere in this file) — this calls run() directly with a
    // value the schema would never let through, to pin that fallback.
    const tool = getTool("luca_analytics_deep_dive");
    const { api, calls } = deepDiveStub();

    await runTool(tool, api, { question: "q", period: "yesterday" });

    const byId = (id: string) => calls.find((c) => c.operation.id === id);
    expect(byId("analytics.funnel")?.query).toEqual({ period: "this_month" });
  });

  it("runs all seven reads side by side instead of one at a time", async () => {
    const tool = getTool("luca_analytics_deep_dive");

    const { calls, peak, api } = concurrencyTrackingApi(
      () => ({ report: "ok" }),
      7
    );

    await runTool(tool, api, { question: "q" });

    expect(calls).toHaveLength(7);
    // Effect.all defaults to sequential; this fails if `concurrency:
    // "unbounded"` is dropped from analyticsFanOut.
    expect(peak()).toBe(7);
  });

  it("lists a failed deep-dive read in failedSections", async () => {
    const tool = getTool("luca_analytics_deep_dive");

    const { api } = stubApi({
      "analytics.funnel": ok({ report: "funnel" }),
      "analytics.revenue": ok({ report: "revenue" }),
      "analytics.speedImpact": ok({ report: "speed" }),
      "analytics.forecast": ok({ report: "forecast" }),
      "analytics.callIntelligence": ok({ report: "calls" }),
      "analytics.ghostedLeads": bad("ghosted leads down"),
      "analytics.trustScore": ok({ report: "trust" }),
    });

    const result = await runTool(tool, api, { question: "q" });

    expect(result).not.toHaveProperty("ghostedLeads");
    expect(result).toMatchObject({
      trustScore: { report: "trust" },
      failedSections: [
        {
          section: "ghostedLeads",
          error: expect.stringContaining("ghosted leads down"),
        },
      ],
    });
  });
});

describe("luca_post_call_queue", () => {
  const tool = () => getTool("luca_post_call_queue");

  it("pins the exact metadata", () => {
    expect(tool().name).toBe("luca_post_call_queue");
    expect(tool().description).toBe(
      "Return everything waiting on the coach after a call: calls that still need a report on how they went, and attended calls with no revenue outcome recorded. The two halves are tracked separately by the API, so a call can sit on one list and not the other. Close an item with luca_close_call_loop. Example: call with {} after a day of calls."
    );
    expect(tool().title).toBe("List the post-call work");
    expect(fromTaskTool(tool()).readOnly).toBe(true);
    expect(fromTaskTool(tool()).untrustedContent).toBe(true);
    expect(fromTaskTool(tool()).confirm).toBeUndefined();
    expect(tool().composes).toEqual([
      "callEvents.needingFeedback",
      "bookings.needsOutcome",
    ]);
    expect(sorted(R.keys(fromTaskTool(tool()).inputSchema))).toEqual([
      "workspaceId",
      "workspaceSlug",
    ]);
  });

  it("returns both halves of the post-call work under their own keys", async () => {
    const { api } = stubApi({
      "callEvents.needingFeedback": ok({ callEvents: [{ id: "call-1" }] }),
      "bookings.needsOutcome": ok({ bookings: [{ id: "booking-1" }] }),
    });

    expect(await runTool(tool(), api, {})).toEqual({
      needingFeedback: { callEvents: [{ id: "call-1" }] },
      needingOutcome: { bookings: [{ id: "booking-1" }] },
    });
  });

  it("reads both lists side by side", async () => {
    const { api, peak } = concurrencyTrackingApi(() => ({}), 2);
    await runTool(tool(), api, {});
    expect(peak()).toBe(2);
  });
});

describe("luca_close_call_loop", () => {
  const tool = () => getTool("luca_close_call_loop");

  const CALL_EVENT = ok({ callEvent: { id: "call-1" } });

  it("requires confirm only when the attendance is no_show", () => {
    const { confirm } = fromTaskTool(tool());

    expect("confirm" in tool().inputSchema).toBe(false);
    expect("confirm" in fromTaskTool(tool()).inputSchema).toBe(true);
    expect(needsConfirmation(confirm, { attendance: "no_show" })).toBe(true);

    Arr.forEach(["completed", "rescheduled", "cancelled"], (attendance) => {
      expect(needsConfirmation(confirm, { attendance })).toBe(false);
    });
  });

  it("pins the exact metadata", () => {
    expect(tool().title).toBe("Close the loop on a call");
    expect(fromTaskTool(tool()).readOnly).toBe(false);
    expect(fromTaskTool(tool()).untrustedContent).toBe(true);
    // Only a no_show report can start recovery that messages the lead, so the
    // gate is conditional rather than "always".
    expect(fromTaskTool(tool()).confirm).toMatchObject({
      description: "attendance is no_show (can start recovery messaging)",
    });
    expect(tool().composes).toEqual([
      "callEvents.byBooking",
      "callEvents.feedback",
      "bookings.outcome.record",
    ]);
  });

  it("pins the exact name and description", () => {
    expect(tool().name).toBe("luca_close_call_loop");
    expect(tool().description).toBe(
      'File what happened on a call and what it was worth, in one call. Reports attendance on the call event (completed, no_show, rescheduled, or cancelled) and, when an outcome is given, records the booking outcome: won with an amount, lost with a reason id from luca_bookings_outcome_reasons_list, or open with the next follow-up. This tool sends no message to the lead itself, but the records it files start work in the API. Reporting a no_show can start no-show recovery, which schedules a message to the lead when the booking type has recovery on, so pass confirm: true only after the coach says to report the no-show. A completed call queues its summary, which can later sync to the connected CRM. A won or lost outcome queues a CRM deal-stage update, and lost also moves the lead to lost. Example: { bookingId, attendance: "completed", outcome: "won", amountMinor: 250000, currency: "USD" }.'
    );
  });

  it("pins the exact arguments a client is offered, bounds and all", () => {
    // The agent picks its arguments from this schema alone, so every bound and
    // every sentence in it is contract. Runtime decoding still requires three
    // UTF-16 code units for currency; JSON Schema's Unicode length is a safe,
    // looser approximation.
    expect(inputJsonSchema(tool())).toEqual({
      type: "object",
      properties: {
        bookingId: {
          type: "string",
          minLength: 1,
          description: "The booking whose call just happened.",
        },
        attendance: {
          type: "string",
          enum: ["completed", "no_show", "rescheduled", "cancelled"],
          description: "What happened to the call itself.",
        },
        rating: {
          description: "The coach's 1-5 rating of the call.",
          type: "integer",
          minimum: 1,
          maximum: 5,
        },
        notes: {
          description:
            "The coach's notes on the call, stored on the call event.",
          type: "string",
          minLength: 1,
          maxLength: 4000,
        },
        outcome: {
          description:
            "The revenue outcome. Leave it off to report attendance only and record the money later.",
          type: "string",
          enum: ["won", "lost", "open"],
        },
        amountMinor: {
          description: "Deal value in minor units (cents) when outcome is won.",
          type: "integer",
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
        },
        currency: {
          description: "ISO-4217 currency for amountMinor, uppercase.",
          type: "string",
          minLength: 2,
          maxLength: 3,
        },
        lossReasonDefinitionId: {
          description:
            "Required when outcome is lost: a reason id from luca_bookings_outcome_reasons_list.",
          type: "string",
        },
        nextFollowUpAt: {
          description:
            "Required when outcome is open: ISO-8601 follow-up time.",
          type: "string",
          format: "date-time",
        },
        followUpTimezone: {
          description:
            "Required when outcome is open: IANA timezone the follow-up is scheduled in.",
          type: "string",
          minLength: 1,
        },
        outcomeNote: {
          description:
            "Note stored on the revenue outcome, separate from notes.",
          type: "string",
          minLength: 1,
          maxLength: 5000,
        },
        expectedVersion: {
          description:
            "The outcome version you read, when correcting an earlier outcome. A stale version returns 409 with the current one.",
          type: "integer",
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
        },
        idempotencyKey: {
          description:
            "Reuse the same key when retrying this exact report. Both writes are scoped by route, so one key covers the pair.",
          type: "string",
          minLength: 1,
        },
      },
      required: ["bookingId", "attendance"],
      additionalProperties: false,
    });
  });

  // A 200 that carries no call event is the same story as the 404 below: the
  // attendance report has nowhere to go, and the revenue write still runs.
  // A call event with no id reads the same way: there is no event to file
  // attendance against, so the tool says so rather than posting to a route
  // with an undefined id in its path.
  it.each([{ bookings: [] }, { callEvent: {} }])(
    "reports attendance as unfiled when the booking's call lookup answers %j",
    async (page) => {
      const { api, calls } = stubApi({
        "callEvents.byBooking": ok(page),
        "bookings.outcome.record": ok({ episode: { status: "won" } }),
      });

      expect(
        await runTool(tool(), api, {
          bookingId: "booking-1",
          attendance: "completed",
          outcome: "won",
        })
      ).toEqual({
        feedback: { reported: false, reason: "no_call_event_for_booking" },
        outcome: { episode: { status: "won" } },
      });
      expect(
        calls.some((call) => call.operation.id === "callEvents.feedback")
      ).toBe(false);
    }
  );

  it("files attendance against the call event the booking resolves to", async () => {
    const { api, calls } = stubApi({
      "callEvents.byBooking": CALL_EVENT,
      "callEvents.feedback": ok({ callEvent: { id: "call-1" } }),
    });

    await runTool(tool(), api, {
      bookingId: "booking-1",
      attendance: "completed",
      rating: 5,
      notes: "strong fit",
    });

    const lookup = calls.find(
      (call) => call.operation.id === "callEvents.byBooking"
    );

    expect(lookup?.pathParams).toEqual({ bookingId: "booking-1" });

    const feedback = calls.find(
      (call) => call.operation.id === "callEvents.feedback"
    );

    expect(feedback?.pathParams).toEqual({ id: "call-1" });
    expect(feedback?.body).toEqual({
      outcome: "completed",
      rating: 5,
      notes: "strong fit",
    });
  });

  it("records nothing about revenue when no outcome is given", async () => {
    const { api, calls } = stubApi({
      "callEvents.byBooking": CALL_EVENT,
      "callEvents.feedback": ok({ filed: true }),
    });

    expect(
      await runTool(tool(), api, {
        bookingId: "booking-1",
        attendance: "no_show",
      })
    ).toEqual({ feedback: { filed: true } });
    expect(
      calls.some((call) => call.operation.id === "bookings.outcome.record")
    ).toBe(false);
  });

  it("sends a won outcome as amount and currency, never a loss reason", async () => {
    const { api, calls } = stubApi({
      "callEvents.byBooking": CALL_EVENT,
      "callEvents.feedback": ok({ filed: true }),
      "bookings.outcome.record": ok({ episode: { status: "won" } }),
    });

    await runTool(tool(), api, {
      bookingId: "booking-1",
      attendance: "completed",
      outcome: "won",
      amountMinor: 250_000,
      currency: "USD",
      // Passed alongside a win: the body variant is chosen by status, so this
      // must not travel with it.
      lossReasonDefinitionId: "reason-1",
      outcomeNote: "annual plan",
      expectedVersion: 2,
    });

    const outcome = calls.find(
      (call) => call.operation.id === "bookings.outcome.record"
    );

    expect(outcome?.pathParams).toEqual({ id: "booking-1" });
    expect(outcome?.body).toEqual({
      status: "won",
      note: "annual plan",
      expectedVersion: 2,
      amountMinor: 250_000,
      currency: "USD",
    });
  });

  it("sends a lost outcome as its reason id, never an amount", async () => {
    const { api, calls } = stubApi({
      "callEvents.byBooking": CALL_EVENT,
      "callEvents.feedback": ok({ filed: true }),
      "bookings.outcome.record": ok({ episode: { status: "lost" } }),
    });

    await runTool(tool(), api, {
      bookingId: "booking-1",
      attendance: "completed",
      outcome: "lost",
      lossReasonDefinitionId: "reason-1",
      amountMinor: 250_000,
    });

    const outcome = calls.find(
      (call) => call.operation.id === "bookings.outcome.record"
    );

    expect(outcome?.body).toEqual({
      status: "lost",
      lossReasonDefinitionId: "reason-1",
    });
  });

  it("sends an open outcome as its follow-up time and timezone", async () => {
    const { api, calls } = stubApi({
      "callEvents.byBooking": CALL_EVENT,
      "callEvents.feedback": ok({ filed: true }),
      "bookings.outcome.record": ok({ episode: { status: "open" } }),
    });

    await runTool(tool(), api, {
      bookingId: "booking-1",
      attendance: "completed",
      outcome: "open",
      nextFollowUpAt: "2026-08-01T15:00:00Z",
      followUpTimezone: "America/New_York",
    });

    const outcome = calls.find(
      (call) => call.operation.id === "bookings.outcome.record"
    );

    expect(outcome?.body).toEqual({
      status: "open",
      nextFollowUpAt: "2026-08-01T15:00:00Z",
      followUpTimezone: "America/New_York",
    });
  });

  it("still records the outcome when the booking has no call event", async () => {
    // A booking whose call event never materialized answers 404 here, which is
    // the normal case — the revenue write is the half the coach is after.
    const { api, calls } = stubApi({
      "callEvents.byBooking": notFound,
      "bookings.outcome.record": ok({ episode: { status: "won" } }),
    });

    expect(
      await runTool(tool(), api, {
        bookingId: "booking-1",
        attendance: "completed",
        outcome: "won",
      })
    ).toEqual({
      feedback: { reported: false, reason: "no_call_event_for_booking" },
      outcome: { episode: { status: "won" } },
    });
    expect(
      calls.some((call) => call.operation.id === "callEvents.feedback")
    ).toBe(false);
  });

  it("reports a failed call-event lookup as an error, not as a missing call event", async () => {
    // A timeout or 500 says nothing about whether the call event exists, so
    // reading it as "no call event" would drop an attendance report that had
    // somewhere to go.
    const { api } = stubApi({
      "callEvents.byBooking": bad("upstream timed out"),
      "bookings.outcome.record": ok({ episode: { status: "won" } }),
    });

    expect(
      await runTool(tool(), api, {
        bookingId: "booking-1",
        attendance: "completed",
        outcome: "won",
      })
    ).toEqual({
      feedback: {
        feedbackError: expect.stringContaining("upstream timed out"),
      },
      outcome: { episode: { status: "won" } },
    });
  });

  it("reports a failed outcome write instead of losing the filed attendance", async () => {
    const { api } = stubApi({
      "callEvents.byBooking": CALL_EVENT,
      "callEvents.feedback": ok({ filed: true }),
      "bookings.outcome.record": bad("outcome is stale"),
    });

    // SAFETY: The value comes from this module's own contract, so its shape matches the assertion.
    const result = (await runTool(tool(), api, {
      bookingId: "booking-1",
      attendance: "completed",
      outcome: "won",
    })) as JsonRecord;

    expect(result.feedback).toEqual({ filed: true });
    // The agent reads the failure off a named key, so the name is contract.
    // SAFETY: The value comes from this module's own contract, so its shape matches the assertion.
    expect(R.keys(result.outcome as JsonRecord)).toEqual(["outcomeError"]);
    expect(jsonText(result.outcome)).toContain("outcome is stale");
  });

  it("still records the outcome when the attendance write fails", async () => {
    // The mirror of the test above. A transient failure filing attendance used
    // to abort the whole tool, so the revenue write — the half the coach is
    // usually after — never went out at all.
    const { api, calls } = stubApi({
      "callEvents.byBooking": CALL_EVENT,
      "callEvents.feedback": bad("call event is locked"),
      "bookings.outcome.record": ok({ episode: { status: "won" } }),
    });

    // SAFETY: The value comes from this module's own contract, so its shape matches the assertion.
    const result = (await runTool(tool(), api, {
      bookingId: "booking-1",
      attendance: "completed",
      outcome: "won",
      amountMinor: 250_000,
      currency: "USD",
    })) as JsonRecord;

    // SAFETY: The value comes from this module's own contract, so its shape matches the assertion.
    expect(R.keys(result.feedback as JsonRecord)).toEqual(["feedbackError"]);
    expect(jsonText(result.feedback)).toContain("call event is locked");
    expect(result.outcome).toEqual({ episode: { status: "won" } });
    expect(
      calls.some((call) => call.operation.id === "bookings.outcome.record")
    ).toBe(true);
  });

  it.each([
    {
      name: "lost with no reason id",
      input: { outcome: "lost" },
      message: "lossReasonDefinitionId is required when outcome is lost.",
    },
    {
      name: "lost with a blank reason id",
      input: { outcome: "lost", lossReasonDefinitionId: "" },
      message: "lossReasonDefinitionId is required when outcome is lost.",
    },
    {
      name: "open with no follow-up time",
      input: { outcome: "open", followUpTimezone: "America/New_York" },
      message: "nextFollowUpAt is required when outcome is open.",
    },
    {
      name: "open with no timezone",
      input: { outcome: "open", nextFollowUpAt: "2026-08-01T15:00:00Z" },
      message: "followUpTimezone is required when outcome is open.",
    },
  ])(
    "refuses $name before either write, so a retry cannot double-file attendance",
    async ({ input, message }) => {
      // Which extra field an outcome needs depends on `outcome`, and the flat
      // tool schema cannot say that, so the tool checks it. It has to check
      // before the attendance write: this used to throw while building the
      // revenue body, which escaped the failureAsField around that request
      // and surfaced as a raw schema error with the attendance already filed. The
      // agent read that as "nothing was written" and retried.
      const { api, calls } = stubApi({
        "callEvents.byBooking": CALL_EVENT,
        "callEvents.feedback": ok({ filed: true }),
        "bookings.outcome.record": ok({ episode: {} }),
      });

      await expect(
        runTool(tool(), api, {
          bookingId: "booking-1",
          attendance: "completed",
          ...input,
        })
      ).rejects.toThrow(message);

      // Nothing was written at all — not the attendance report, not the
      // outcome. That is what makes the agent's retry safe.
      expect(calls.map((call) => call.operation.id)).toEqual([]);
    }
  );

  it("passes one idempotency key to both writes", async () => {
    const { api, calls } = stubApi({
      "callEvents.byBooking": CALL_EVENT,
      "callEvents.feedback": ok({ filed: true }),
      "bookings.outcome.record": ok({ episode: { status: "won" } }),
    });

    await runTool(tool(), api, {
      bookingId: "booking-1",
      attendance: "completed",
      outcome: "won",
      idempotencyKey: "key-1",
    });

    // The API scopes a key by method and path, so the same key on two routes
    // is two independent replays rather than a collision.
    const written = calls.filter((call) => call.operation.method === "POST");
    expect(written).toHaveLength(2);

    Arr.forEach(written, (call) => {
      expect(call.idempotencyKey).toBe("key-1");
    });
  });
});
