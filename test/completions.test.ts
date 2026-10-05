import * as Effect from "effect/Effect";
import * as R from "effect/Record";
import { assert, describe, expect, it, onTestFinished } from "vitest";

import {
  completionCallbacks,
  templateCompletions,
} from "../src/completions.ts";
import { LucaHttpError } from "../src/errors.ts";
import type { LucaRequest } from "../src/http.ts";
import { LUCA_OPERATIONS } from "../src/operations.ts";
import { connect, type TestHandler, testLayer } from "./helpers.ts";

// The two ids differ in their first character and share their last, so a
// completion that matched the end of an id instead of its start would offer
// both where the tests below expect one.
const LEAD_IDS = [
  "1eadbeef-1111-1111-1111-000000000000",
  "2eadbeef-2222-2222-2222-000000000000",
];

function getOperation(id: string) {
  const operation = LUCA_OPERATIONS.find((item) => item.id === id);

  assert(operation, `Missing operation: ${id}`);

  return operation;
}

const CONVERSATION_IDS = ["33333333-3333-3333-3333-333333333333"];

/** Answers the two list routes completion reads from, and nothing else. */
function listHandler(seen: LucaRequest[]): TestHandler {
  return (request) => {
    seen.push(request);

    if (request.operation.id === "leads.list") {
      return Effect.succeed({
        leads: LEAD_IDS.map((id) => ({ id, displayName: "Alex" })),
      });
    }

    if (request.operation.id === "conversations.list") {
      return Effect.succeed({
        conversations: CONVERSATION_IDS.map((id) => ({ id })),
      });
    }

    return Effect.succeed(null);
  };
}

describe("completion/complete", () => {
  it("completes a prompt's leadId from the live lead list", async () => {
    const seen: LucaRequest[] = [];
    const { client, close } = await connect(listHandler(seen));

    onTestFinished(close);

    const result = await client.complete({
      ref: { type: "ref/prompt", name: "luca-draft-reply" },
      argument: { name: "leadId", value: "1" },
    });

    expect(result.completion.values).toEqual([LEAD_IDS[0]]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.operation.id).toBe("leads.list");
    // One page, capped at the route's own maximum. A completion never walks.
    expect(seen[0]?.query).toMatchObject({ limit: 100 });
  });

  it("completes a resource template's variable from its own list route", async () => {
    const seen: LucaRequest[] = [];
    const { client, close } = await connect(listHandler(seen));

    onTestFinished(close);

    const result = await client.complete({
      ref: {
        type: "ref/resource",
        uri: "luca://thread/{conversationId}",
      },
      argument: { name: "conversationId", value: "" },
    });

    expect(result.completion.values).toEqual(CONVERSATION_IDS);
    expect(seen[0]?.operation.id).toBe("conversations.list");
  });

  it("offers nothing rather than an error when the read fails", async () => {
    const { client, close } = await connect(() =>
      Effect.fail(
        new LucaHttpError({
          status: 503,
          statusText: "Service Unavailable",
          body: "down",
        })
      )
    );

    onTestFinished(close);

    const result = await client.complete({
      ref: { type: "ref/prompt", name: "luca-draft-reply" },
      argument: { name: "leadId", value: "1" },
    });

    expect(result.completion.values).toEqual([]);
  });

  it("offers nothing when the page carries no id list", async () => {
    const { client, close } = await connect(() =>
      Effect.succeed({ leads: "not-a-list" })
    );

    onTestFinished(close);

    const result = await client.complete({
      ref: { type: "ref/prompt", name: "luca-draft-reply" },
      argument: { name: "leadId", value: "" },
    });

    expect(result.completion.values).toEqual([]);
  });

  it("offers nothing when the records carry no string id", async () => {
    // The page is shaped right and the records are not, so there is no id to
    // offer. Handing back whatever sat under `id` would put a number where the
    // client expects a string it can type.
    const { client, close } = await connect(() =>
      Effect.succeed({ leads: [{ id: 7 }] })
    );

    onTestFinished(close);

    const result = await client.complete({
      ref: { type: "ref/prompt", name: "luca-draft-reply" },
      argument: { name: "leadId", value: "" },
    });

    expect(result.completion.values).toEqual([]);
  });

  it("leaves an argument with no live source uncompleted", async () => {
    const seen: LucaRequest[] = [];
    const { client, close } = await connect(listHandler(seen));

    onTestFinished(close);

    const result = await client.complete({
      ref: { type: "ref/prompt", name: "luca-draft-reply" },
      argument: { name: "guidance", value: "be" },
    });

    expect(result.completion.values).toEqual([]);
    expect(seen).toHaveLength(0);
  });
});

describe("completionCallbacks", () => {
  const layer = testLayer((request) =>
    request.operation.id === "leads.list"
      ? Effect.succeed({ leads: LEAD_IDS.map((id) => ({ id })) })
      : Effect.succeed(null)
  );

  it("offers every id when the client has typed nothing yet", async () => {
    // MCP sends no value at all until the first keystroke, and that has to read
    // as an empty prefix rather than as a filter nothing can match.
    const callbacks = completionCallbacks(getOperation, layer);
    expect(await callbacks.leadId(undefined)).toEqual(LEAD_IDS);
    expect(await callbacks.leadId("")).toEqual(LEAD_IDS);
    expect(await callbacks.leadId("2")).toEqual([LEAD_IDS[1]]);
  });

  it("matches the typed prefix without regard to case", async () => {
    const callbacks = completionCallbacks(getOperation, layer);
    expect(await callbacks.leadId("1EADBE")).toEqual([LEAD_IDS[0]]);
  });

  it("refuses a completion source that serves no list of records", () => {
    // A source has to be a list route, since the ids come out of the page's own
    // array field. Naming one that has none is a wiring mistake, and it is
    // caught while the server is built rather than on a coach's keystroke.
    expect(() =>
      completionCallbacks(() => getOperation("capabilities.get"), layer)
    ).toThrow(/carries no list of records/);
  });
});

describe("templateCompletions", () => {
  const callbacks = {
    leadId: () => Promise.resolve([]),
    conversationId: () => Promise.resolve([]),
  };

  it("keeps only the variables a completion exists for", () => {
    const complete = templateCompletions(
      "luca://lead/{leadId}/note/{noteId}",
      callbacks
    );

    expect(R.keys(complete ?? {})).toEqual(["leadId"]);
  });

  it("returns undefined when a template has nothing to complete", () => {
    // The key has to be absent rather than empty. An empty `complete` map still
    // registers a handler, and the client would then see the template offering
    // completion for arguments no source can answer.
    expect(
      templateCompletions("luca://queue/today", callbacks)
    ).toBeUndefined();
    expect(
      templateCompletions("luca://note/{noteId}", callbacks)
    ).toBeUndefined();
  });
});
