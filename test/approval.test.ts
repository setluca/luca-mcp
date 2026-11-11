import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { Transport } from "@modelcontextprotocol/server";
import * as Effect from "effect/Effect";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import {
  approvalKey,
  approvalMessage,
  approvalRequest,
} from "../src/approval.ts";
import { apiKeyResolver, createRemoteHandler } from "../src/remote.ts";
import { createLucaServer } from "../src/server.ts";
import { testLayer } from "./helpers.ts";
import { encodeUnknownJson } from "./json.ts";
import {
  acceptingFetch,
  DEFAULT_SETTINGS,
  MCP_URL,
  VALID_API_KEY,
} from "./remote-fixtures.ts";

const TOOL = "luca_campaigns_enrollments_resume";

const ARGS = {
  id: "00000000-0000-0000-0000-000000000001",
  enrollmentId: "00000000-0000-0000-0000-000000000002",
};

const RESUMED = { enrollmentId: ARGS.enrollmentId, resumed: true };

describe("approvalKey", () => {
  it("ignores key order and the model's confirm flag", () => {
    const key = approvalKey(TOOL, ARGS);

    expect(
      approvalKey(TOOL, {
        enrollmentId: ARGS.enrollmentId,
        id: ARGS.id,
        confirm: true,
      })
    ).toBe(key);
    expect(approvalKey(TOOL, { ...ARGS, id: "other" })).not.toBe(key);
    expect(approvalKey("luca_other_tool", ARGS)).not.toBe(key);
  });

  it("sorts nested objects too", () => {
    expect(approvalKey(TOOL, { body: { a: 1, b: [{ x: 1, y: 2 }] } })).toBe(
      approvalKey(TOOL, { body: { b: [{ y: 2, x: 1 }], a: 1 } })
    );
  });
});

describe("approvalMessage", () => {
  const tool = { name: TOOL, title: "Resume a campaign enrollment" };

  it("names the action and each argument, without confirm", () => {
    const message = approvalMessage(tool, { ...ARGS, confirm: true });

    expect(message).toContain(`SetLuca: ${tool.title} (${TOOL})`);
    expect(message).toContain(`• enrollmentId: ${ARGS.enrollmentId}`);
    expect(message).not.toContain("confirm");
  });

  it("cuts long values and caps how many arguments it lists", () => {
    const many = Object.fromEntries(
      Array.from({ length: 15 }, (_, index) => [`field${index}`, "x"])
    );

    const message = approvalMessage(tool, { ...many, text: "y".repeat(400) });

    expect(message).toContain("• and 4 more");
    expect(approvalMessage(tool, { text: "y".repeat(400) })).toContain(
      `${"y".repeat(280)}…`
    );
  });

  it("asks for one required yes-or-no field that defaults to no", () => {
    const request = encodeUnknownJson(approvalRequest(tool, ARGS));

    expect(request).toContain('"required":["approve"]');
    expect(request).toContain('"default":false');
  });
});

/** A client that shows the coach the form, answering it the given way. */
function formClient(
  answer: () => Record<string, unknown>,
  options: ConstructorParameters<typeof Client>[1] = {}
) {
  const shown = vi.fn<(message: string) => void>();

  const client = new Client(
    { name: "approval-test-client", version: "0.1.0" },
    { ...options, capabilities: { elicitation: { form: {} } } }
  );

  client.setRequestHandler("elicitation/create", (request) => {
    shown(String(request.params.message));

    return Promise.resolve(answer() as never);
  });

  return { client, shown };
}

// See test/remote.test.ts: the SDK types sessionId loosely.
function asTransport(transport: StreamableHTTPClientTransport): Transport {
  return transport;
}

/** The hosted handler, with an API that answers every call with RESUMED. */
function hosted() {
  const apiFetch = vi.fn<typeof fetch>(() =>
    Promise.resolve(Response.json(RESUMED))
  );

  const handler = createRemoteHandler({
    resolveToken: apiKeyResolver(DEFAULT_SETTINGS, acceptingFetch),
    apiFetch,
  });

  const fetchVia = (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);

    headers.set("authorization", `Bearer ${VALID_API_KEY}`);

    return handler(new Request(new URL(url), { ...init, headers }));
  };

  return { apiFetch, fetchVia };
}

async function connectHosted(client: Client) {
  const { apiFetch, fetchVia } = hosted();

  const transport = new StreamableHTTPClientTransport(MCP_URL, {
    fetch: fetchVia,
  });

  await client.connect(asTransport(transport));
  onTestFinished(() => transport.close());

  return apiFetch;
}

describe("approval over the hosted handler", () => {
  it("asks a 2026 client's coach and runs on approval", async () => {
    const { client, shown } = formClient(
      () => ({ action: "accept", content: { approve: true } }),
      { versionNegotiation: { mode: "auto" } }
    );

    const apiFetch = await connectHosted(client);

    expect(client.getProtocolEra()).toBe("modern");

    const result = await client.callTool({ name: TOOL, arguments: ARGS });

    expect(shown).toHaveBeenCalledTimes(1);
    expect(shown.mock.calls[0]?.[0]).toContain(ARGS.enrollmentId);
    expect(result).toMatchObject({ structuredContent: { result: RESUMED } });
    expect(apiFetch).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("sends nothing when a 2026 client's coach declines", async () => {
    const { client } = formClient(() => ({ action: "decline" }), {
      versionNegotiation: { mode: "auto" },
    });

    const apiFetch = await connectHosted(client);

    const result = await client.callTool({
      name: TOOL,
      arguments: { ...ARGS, confirm: true },
    });

    expect(result).toMatchObject({
      isError: true,
      _meta: { "setluca.com/error": { code: "approval_declined" } },
    });
    expect(apiFetch).not.toHaveBeenCalled();
  }, 15_000);

  it("keeps confirm: true for a 2025 client, which it cannot ask", async () => {
    const { client, shown } = formClient(
      () => ({ action: "accept", content: { approve: true } }),
      { versionNegotiation: { mode: "legacy" } }
    );

    const apiFetch = await connectHosted(client);

    expect(client.getProtocolEra()).toBe("legacy");

    expect(
      await client.callTool({ name: TOOL, arguments: ARGS })
    ).toMatchObject({
      isError: true,
      _meta: { "setluca.com/error": { code: "confirmation_required" } },
    });
    expect(apiFetch).not.toHaveBeenCalled();

    expect(
      await client.callTool({
        name: TOOL,
        arguments: { ...ARGS, confirm: true },
      })
    ).toMatchObject({ structuredContent: { result: RESUMED } });
    expect(shown).not.toHaveBeenCalled();
  }, 15_000);
});

describe("approval over a kept connection (stdio)", () => {
  it("asks a 2025 client's coach through the open connection", async () => {
    const request = vi.fn(() => Effect.succeed(RESUMED));
    const server = createLucaServer({ lucaLayer: testLayer(request) });

    const { client, shown } = formClient(() => ({
      action: "accept",
      content: { approve: true },
    }));

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    onTestFinished(() => clientTransport.close());

    const result = await client.callTool({
      name: TOOL,
      arguments: { ...ARGS, confirm: true },
    });

    expect(shown).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ structuredContent: { result: RESUMED } });
    expect(request).toHaveBeenCalledTimes(1);
  }, 15_000);
});
