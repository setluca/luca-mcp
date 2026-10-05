import { assert, describe, expect, it, vi } from "vitest";

import { apiKeyResolver, createRemoteHandler } from "../src/remote.ts";
import { jsonText } from "./helpers.ts";
import {
  acceptingFetch,
  DEFAULT_SETTINGS,
  MCP_URL,
  VALID_API_KEY,
} from "./remote-fixtures.ts";

/**
 * Every `close` the remote handler makes on the SDK handlers it builds, and
 * the event stream the next SDK reply carries. The test holds the stream's
 * controller, so the source stays open until the test ends it. The SDK's own
 * initialize reply ends at once, which would let the handler close before a
 * test could look.
 */
const sdkState = vi.hoisted(() => ({
  closes: 0,
  source: undefined as ReadableStreamDefaultController<Uint8Array> | undefined,
}));

vi.mock("@modelcontextprotocol/server", async (importOriginal) => {
  const sdk =
    await importOriginal<typeof import("@modelcontextprotocol/server")>();

  return {
    ...sdk,
    createMcpHandler: (...args: Parameters<typeof sdk.createMcpHandler>) => {
      const handler = sdk.createMcpHandler(...args);

      return {
        ...handler,
        fetch: () =>
          Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                start: (controller) => {
                  sdkState.source = controller;
                },
              }),
              { headers: { "content-type": "text/event-stream" } }
            )
          ),
        close: () => {
          sdkState.closes += 1;

          return handler.close();
        },
      };
    },
  };
});

function sseRequest() {
  return new Request(MCP_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${VALID_API_KEY}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: jsonText({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
}

function openSource() {
  const source = sdkState.source;

  assert(source, "expected the SDK reply to open its event stream");

  return source;
}

describe("an event-stream reply", () => {
  const handler = createRemoteHandler({
    resolveToken: apiKeyResolver(DEFAULT_SETTINGS, acceptingFetch),
  });

  it("keeps the MCP handler open while the stream is still sending", async () => {
    sdkState.closes = 0;

    const response = await handler(sseRequest());
    const source = openSource();

    source.enqueue(new TextEncoder().encode("data: first\n\n"));

    // The source has not ended, so closing now would cut the stream off.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sdkState.closes).toBe(0);

    source.close();

    expect(await response.text()).toBe("data: first\n\n");
    await vi.waitFor(() => expect(sdkState.closes).toBe(1));
  });

  it("closes the MCP handler when the client cancels the body", async () => {
    sdkState.closes = 0;

    const response = await handler(sseRequest());

    openSource();
    assert(response.body, "expected an event-stream body");
    expect(sdkState.closes).toBe(0);

    await response.body.cancel();

    await vi.waitFor(() => expect(sdkState.closes).toBe(1));
  });
});
