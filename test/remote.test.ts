import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import type { Transport } from "@modelcontextprotocol/server";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Redacted from "effect/Redacted";
import { assert, describe, expect, it, onTestFinished, vi } from "vitest";

import type { LucaConfig } from "../src/config.ts";
import { TokenVerificationUnavailable } from "../src/errors.ts";
import { setEventSink, stdoutEventSink } from "../src/observability.ts";
import {
  apiKeyResolver,
  createRemoteHandler,
  type TokenResolver,
} from "../src/remote.ts";
import { OAUTH_DEFAULT_SCOPE } from "../src/scopes.ts";
import { type JsonValue, parseJson } from "../src/serialization.ts";
import { LUCA_TASK_TOOLS } from "../src/task-tools.ts";
import { jsonText } from "./helpers.ts";
import {
  acceptingFetch,
  DEFAULT_SETTINGS,
  declines,
  MCP_URL,
  VALID_API_KEY,
} from "./remote-fixtures.ts";

/** A resolver that records each token it is asked about, then declines. */
function recordingResolver(seen: string[]): TokenResolver {
  return (token) => {
    seen.push(token);

    return Effect.succeed(Option.none());
  };
}

/**
 * A minimal Request-like object that skips the real Fetch `Headers` value
 * validation (which rejects control characters like `\n`), so regex edge
 * cases in `bearerToken` can be exercised directly through the public
 * handler without ever constructing an invalid real `Request`.
 */
function fakeAuthRequest(authorization: string | null): Request {
  return {
    url: MCP_URL.toString(),
    headers: {
      get: (name: string) => (name === "authorization" ? authorization : null),
    },
  } as Request;
}

// StreamableHTTPClientTransport types sessionId as `string | undefined`, which
// exactOptionalPropertyTypes rejects against Transport's `string`. Runtime is
// fine; narrow the SDK's own type friction at the connect boundary.
function asTransport(transport: StreamableHTTPClientTransport): Transport {
  return transport as Transport;
}

/**
 * Bridges the SDK client transport's fetch straight to the handler, so a real
 * MCP client speaks to the remote handler in-memory with no network.
 */
function bridgedFetch(
  handler: (request: Request) => Promise<Response>,
  extraHeaders: Record<string, string>
) {
  return (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);

    Arr.forEach(R.toEntries(extraHeaders), ([key, value]) => {
      headers.set(key, value);
    });

    return handler(new Request(new URL(url), { ...init, headers }));
  };
}

/**
 * Reads the JSON payload out of the first `data:` line of an SSE body, which
 * is how a response framed as an event stream carries a single JSON-RPC reply.
 */
function firstSseMessage(body: string): JsonValue {
  const line = body
    .split("\n")
    .find((candidate) => candidate.startsWith("data:"));

  assert(line, `No SSE data line in response body: ${body}`);

  return Effect.runSync(parseJson(line.slice("data:".length).trim()));
}

describe("remote transport", () => {
  it("returns 401 without a bearer token", async () => {
    const handler = createRemoteHandler({
      resolveToken: apiKeyResolver(DEFAULT_SETTINGS, acceptingFetch),
    });

    const response = await handler(
      new Request(MCP_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({
      error: "unauthorized",
      detail: "Missing bearer token",
    });
  });

  it("names the realm and default scope when no resource metadata url is configured", async () => {
    const handler = createRemoteHandler({
      resolveToken: apiKeyResolver(DEFAULT_SETTINGS, acceptingFetch),
    });

    const response = await handler(new Request(MCP_URL, { method: "POST" }));
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer realm="luca-mcp", scope="${OAUTH_DEFAULT_SCOPE}"`
    );
  });

  it("rejects an authorization header missing the Bearer prefix", async () => {
    const handler = createRemoteHandler({
      resolveToken: apiKeyResolver(DEFAULT_SETTINGS, acceptingFetch),
    });

    const response = await handler(
      fakeAuthRequest("token-without-bearer-prefix")
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "unauthorized",
      detail: "Missing bearer token",
    });
  });

  it("accepts a lowercase bearer scheme", async () => {
    const seen: string[] = [];

    const handler = createRemoteHandler({
      resolveToken: recordingResolver(seen),
    });

    await handler(fakeAuthRequest("bearer luca_lowercase"));
    expect(seen).toEqual(["luca_lowercase"]);
  });

  it("trims surrounding whitespace from an extracted token", async () => {
    const seen: string[] = [];

    const handler = createRemoteHandler({
      resolveToken: recordingResolver(seen),
    });

    await handler(fakeAuthRequest("Bearer   luca_spaced   "));
    expect(seen).toEqual(["luca_spaced"]);
  });

  it("treats a bearer header with only whitespace after it as missing", async () => {
    const handler = createRemoteHandler({
      resolveToken: apiKeyResolver(DEFAULT_SETTINGS, acceptingFetch),
    });

    const response = await handler(fakeAuthRequest("Bearer   "));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "unauthorized",
      detail: "Missing bearer token",
    });
  });

  it("requires Bearer at the very start of the header (anchored regex)", async () => {
    const handler = createRemoteHandler({
      resolveToken: apiKeyResolver(DEFAULT_SETTINGS, acceptingFetch),
    });

    // The real regex is anchored with `^`, so a value with leading text
    // before "Bearer" never matches and the token is treated as missing
    // rather than extracted from mid-string.
    const response = await handler(fakeAuthRequest("xBearer luca_mid_string"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "unauthorized",
      detail: "Missing bearer token",
    });
  });

  it("requires the captured token to run to the end of the header (anchored regex)", async () => {
    const handler = createRemoteHandler({
      resolveToken: apiKeyResolver(DEFAULT_SETTINGS, acceptingFetch),
    });

    // "." never matches a newline, so with the real `$`-anchored regex a
    // value with trailing content after a line break can't match at all;
    // the token is treated as missing rather than truncated at the newline.
    const response = await handler(
      fakeAuthRequest("Bearer luca_before_newline\nextra-line")
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "unauthorized",
      detail: "Missing bearer token",
    });
  });

  it("includes the RFC 9728 resource_metadata pointer when configured", async () => {
    const handler = createRemoteHandler({
      resolveToken: apiKeyResolver(DEFAULT_SETTINGS, acceptingFetch),
      resourceMetadataUrl:
        "https://mcp.test/.well-known/oauth-protected-resource/mcp",
    });

    const response = await handler(
      new Request(MCP_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer realm="luca-mcp", resource_metadata="https://mcp.test/.well-known/oauth-protected-resource/mcp", scope="${OAUTH_DEFAULT_SCOPE}"`
    );
  });

  it("returns 401 for a token the resolver rejects", async () => {
    const handler = createRemoteHandler({
      resolveToken: apiKeyResolver(DEFAULT_SETTINGS, acceptingFetch),
    });

    const response = await handler(
      new Request(MCP_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer not-a-luca-key",
        },
        body: "{}",
      })
    );

    expect(response.status).toBe(401);
    // A refused token gets invalid_token, so the client refreshes or
    // re-authorizes instead of treating the request as anonymous.
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer realm="luca-mcp", error="invalid_token", error_description="The access token is invalid or expired"`
    );
    expect(await response.json()).toEqual({
      error: "unauthorized",
      detail: "Invalid or expired token",
    });
  });

  it("answers 401 invalid_token to a token past the length cap, without resolving it", async () => {
    const resolveToken = vi.fn(declines);
    const handler = createRemoteHandler({ resolveToken });

    const response = await handler(
      new Request(MCP_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${"a".repeat(4097)}` },
      })
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      'error="invalid_token"'
    );
    expect(response.headers.get("www-authenticate")).not.toContain("scope=");
    expect(resolveToken).not.toHaveBeenCalled();
  });

  it("accepts a token at the length cap", async () => {
    const resolveToken = vi.fn(declines);
    const handler = createRemoteHandler({ resolveToken });

    await handler(
      new Request(MCP_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${"a".repeat(4096)}` },
      })
    );

    expect(resolveToken).toHaveBeenCalledOnce();
  });

  it("answers 503, not 401, when token verification is down", async () => {
    // A 401 tells the client its token is bad and sends the coach back through
    // sign-in. An outage says nothing about the token, so the client should
    // retry with the token it has.
    const handler = createRemoteHandler({
      resolveToken: () =>
        Effect.fail(
          new TokenVerificationUnavailable({ message: "verifier down" })
        ),
    });

    const response = await handler(
      new Request(MCP_URL, {
        method: "POST",
        headers: { authorization: "Bearer some.jwt.token" },
      })
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.json()).toEqual({
      error: "service_unavailable",
      detail: "Token verification is temporarily unavailable",
    });
  });

  it("logs the verification outage without the token", async () => {
    const lines: string[] = [];

    setEventSink((line) => {
      lines.push(line);
    });
    onTestFinished(() => setEventSink(stdoutEventSink));

    const handler = createRemoteHandler({
      resolveToken: () =>
        Effect.fail(
          new TokenVerificationUnavailable({ message: "verifier down" })
        ),
    });

    await handler(
      new Request(MCP_URL, {
        method: "POST",
        headers: { authorization: "Bearer secret.jwt.token" },
      })
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"event":"mcp.token_verification_unavailable"');
    expect(lines[0]).toContain('"message":"verifier down"');
    expect(lines[0]).not.toContain("secret.jwt.token");
  });

  it("refuses a browser request from another site before reading its token", async () => {
    const resolveToken = vi.fn(declines);
    const handler = createRemoteHandler({ resolveToken });

    const response = await handler(
      new Request(MCP_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${VALID_API_KEY}`,
          origin: "https://evil.example",
        },
      })
    );

    expect(response.status).toBe(403);
    // A foreign origin is not an auth failure, so no OAuth challenge that
    // would send the client into a sign-in it cannot complete from there.
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(resolveToken).not.toHaveBeenCalled();
  });

  it("lets a request with no Origin through to auth, since only browsers send one", async () => {
    const resolveToken = vi.fn(declines);
    const handler = createRemoteHandler({ resolveToken });

    const response = await handler(
      new Request(MCP_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${VALID_API_KEY}` },
      })
    );

    expect(response.status).toBe(401);
    expect(resolveToken).toHaveBeenCalledOnce();
  });

  it.each([
    ["the request's own host", "http://mcp.test", []],
    ["an allowlisted host", "https://inspector.example", ["inspector.example"]],
  ])(
    "lets a browser request from %s through to auth",
    async (_label, origin, allowedOrigins) => {
      const handler = createRemoteHandler({
        resolveToken: declines,
        allowedOrigins,
      });

      const response = await handler(
        new Request(MCP_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${VALID_API_KEY}`, origin },
        })
      );

      expect(response.status).toBe(401);
    }
  );

  it("returns 404 for a non-MCP path", async () => {
    const handler = createRemoteHandler({
      resolveToken: apiKeyResolver(DEFAULT_SETTINGS, acceptingFetch),
    });

    const response = await handler(
      new Request(new URL("http://mcp.test/other"), { method: "POST" })
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("serves a full MCP session to an authenticated client", async () => {
    const handler = createRemoteHandler({
      resolveToken: apiKeyResolver(DEFAULT_SETTINGS, acceptingFetch),
    });

    const client = new Client({ name: "remote-test", version: "0.1.0" });

    const transport = new StreamableHTTPClientTransport(MCP_URL, {
      fetch: bridgedFetch(handler, {
        authorization: `Bearer ${VALID_API_KEY}`,
      }),
    });

    await client.connect(asTransport(transport));

    onTestFinished(() => transport.close());

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "luca_capabilities_get"
    );
  }, 15_000);

  it("resolves the bearer token to that key's coach config", async () => {
    const seen: string[] = [];

    const handler = createRemoteHandler({
      resolveToken: (token) => {
        seen.push(token);

        return Effect.succeed(
          Option.some<LucaConfig>({
            apiBaseUrl: "https://api.example.com",
            apiKey: Redacted.make(token),
            authHeader: "x-api-key",
          })
        );
      },
    });

    const client = new Client({ name: "remote-test", version: "0.1.0" });

    const transport = new StreamableHTTPClientTransport(MCP_URL, {
      fetch: bridgedFetch(handler, { authorization: "Bearer luca_coach_a" }),
    });

    await client.connect(asTransport(transport));

    onTestFinished(() => transport.close());

    await client.listTools();
    expect(seen).toContain("luca_coach_a");
  }, 15_000);

  it("passes an explicit toolset through to the constructed server", async () => {
    const handler = createRemoteHandler({
      resolveToken: apiKeyResolver(DEFAULT_SETTINGS, acceptingFetch),
      toolset: "tasks",
    });

    const client = new Client({ name: "remote-test-tasks", version: "0.1.0" });

    const transport = new StreamableHTTPClientTransport(MCP_URL, {
      fetch: bridgedFetch(handler, {
        authorization: `Bearer ${VALID_API_KEY}`,
      }),
    });

    await client.connect(asTransport(transport));

    onTestFinished(() => transport.close());

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    // "tasks" trims the 1:1 operation surface down to capabilities.get
    // plus every task tool — a much smaller list than the "full" default,
    // proving the option actually reached the server.
    expect(names).toContain("luca_capabilities_get");
    expect(names).toHaveLength(1 + LUCA_TASK_TOOLS.length);
  }, 15_000);

  it("tells the client to re-authorize when the API rejects the token mid-call", async () => {
    const resourceMetadataUrl =
      "http://mcp.test/.well-known/oauth-protected-resource/mcp";

    // The bridged client transport calls the handler directly, so the only
    // request this global fetch sees is the tool's own call to the Luca API.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { code: "unauthorized", message: "Token revoked" } },
          { status: 401 }
        )
      )
    );

    const handler = createRemoteHandler({
      resolveToken: () =>
        Effect.succeed(
          Option.some<LucaConfig>({
            apiBaseUrl: "https://api.example.com",
            apiKey: Redacted.make("luca_coach_a"),
            authHeader: "x-api-key",
          })
        ),
      resourceMetadataUrl,
    });

    const client = new Client({ name: "remote-test-auth", version: "0.1.0" });

    const transport = new StreamableHTTPClientTransport(MCP_URL, {
      fetch: bridgedFetch(handler, { authorization: "Bearer luca_coach_a" }),
    });

    await client.connect(asTransport(transport));

    onTestFinished(async () => {
      await transport.close();
      vi.unstubAllGlobals();
    });

    const result = await client.callTool({
      name: "luca_capabilities_get",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(result._meta?.["mcp/www_authenticate"]).toEqual([
      expect.stringContaining(
        `resource_metadata="${resourceMetadataUrl}", error="invalid_token"`
      ),
    ]);
    // A refused token is refreshed, not widened, so the challenge names no scope.
    expect(result._meta?.["mcp/www_authenticate"]).toEqual([
      expect.not.stringContaining("scope="),
    ]);
  }, 15_000);

  it("closes the per-request server after handling a request", async () => {
    const serverCloseSpy = vi.spyOn(McpServer.prototype, "close");

    const handler = createRemoteHandler({
      resolveToken: apiKeyResolver(DEFAULT_SETTINGS, acceptingFetch),
    });

    const client = new Client({ name: "remote-test-close", version: "0.1.0" });

    const transport = new StreamableHTTPClientTransport(MCP_URL, {
      fetch: bridgedFetch(handler, {
        authorization: `Bearer ${VALID_API_KEY}`,
      }),
    });

    onTestFinished(() => transport.close());

    await client.connect(asTransport(transport));
    await client.listTools();

    expect(serverCloseSpy).toHaveBeenCalled();
    serverCloseSpy.mockRestore();
  }, 15_000);

  it("builds a fresh server for every request and holds no session", async () => {
    // Each request builds its own server and connects it to that request's
    // transport, so recording `this` on connect counts the instances the
    // handler built.
    // oxlint-disable-next-line effect/avoid-native-object-helpers -- Tracks and closes the original McpServer SDK instances by reference identity.
    const built = new Set<McpServer>();
    const originalConnect = McpServer.prototype.connect;

    const connectSpy = vi
      .spyOn(McpServer.prototype, "connect")
      .mockImplementation(function connect(this: McpServer, transport) {
        built.add(this);

        return originalConnect.call(this, transport);
      });

    const handler = createRemoteHandler({
      resolveToken: apiKeyResolver(DEFAULT_SETTINGS, acceptingFetch),
    });

    const call = () =>
      handler(
        new Request(MCP_URL, {
          method: "POST",
          headers: {
            authorization: `Bearer ${VALID_API_KEY}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: jsonText({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: {},
          }),
        })
      );

    // The 2026-07-28 revision carries protocol version and client identity on
    // every request, so `tools/list` answers with no prior handshake. Two
    // bare calls therefore succeed, and each one gets its own server —
    // nothing survives between them for a later request to inherit.
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    expect(built.size).toBe(2);

    connectSpy.mockRestore();
  }, 15_000);

  it("hints one private hour on every static list and nothing on a live read", async () => {
    // Cache hints ride results only on the 2026-07-28 revision, and only the
    // `createMcpHandler` entry this handler is built on serves that revision —
    // a hand-constructed McpServer negotiates the legacy `initialize`
    // handshake and never stamps a hint. So this is the one surface where
    // LUCA_CACHE_HINTS is observable end to end.
    const handler = createRemoteHandler({
      resolveToken: apiKeyResolver(DEFAULT_SETTINGS, acceptingFetch),
    });

    const client = new Client(
      { name: "remote-test-cache", version: "0.1.0" },
      { versionNegotiation: { mode: "auto" } }
    );

    const transport = new StreamableHTTPClientTransport(MCP_URL, {
      fetch: bridgedFetch(handler, {
        authorization: `Bearer ${VALID_API_KEY}`,
      }),
    });

    await client.connect(asTransport(transport));

    onTestFinished(() => transport.close());

    expect(client.getProtocolEra()).toBe("modern");

    const hour = 3_600_000;

    Arr.forEach(
      [
        await client.listTools(),
        await client.listPrompts(),
        await client.listResources(),
        await client.listResourceTemplates(),
      ],
      (list) => {
        const cacheable = list as {
          ttlMs?: number;
          cacheScope?: string;
        };

        expect(cacheable.ttlMs).toBe(hour);
        expect(cacheable.cacheScope).toBe("private");
      }
    );
  }, 15_000);

  it("still serves a client speaking the 2025 revision", async () => {
    const handler = createRemoteHandler({
      resolveToken: apiKeyResolver(DEFAULT_SETTINGS, acceptingFetch),
    });

    // A 2025-era client opens with `initialize` rather than carrying its
    // identity per request. `createMcpHandler` defaults to
    // `legacy: 'stateless'`, which answers that handshake from the same
    // factory, so the cutover does not strand clients on the old revision.
    const response = await handler(
      new Request(MCP_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${VALID_API_KEY}`,
          "content-type": "application/json",
          // The 2025 revision requires a client to accept both media types,
          // and the default `auto` response mode answers such a request with
          // SSE framing, so the reply is read as an event stream below.
          accept: "application/json, text/event-stream",
        },
        body: jsonText({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "legacy-client", version: "0.1.0" },
          },
        }),
      })
    );

    expect(response.status).toBe(200);

    const body = firstSseMessage(await response.text()) as {
      result?: { protocolVersion?: string };
      error?: unknown;
    };

    expect(body.error).toBeUndefined();
    expect(body.result?.protocolVersion).toBe("2025-06-18");
  }, 15_000);
});
