import * as Schema from "effect/Schema";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { LUCA_OPERATIONS } from "../src/operations.ts";
import { resolveToolset } from "../src/remote.ts";
import { LUCA_SERVER_INFO } from "../src/server.ts";
import { LUCA_TASK_TOOLS } from "../src/task-tools.ts";
import worker, { parseAllowedOrigins } from "../src/worker.ts";
import { jsonText } from "./helpers.ts";

const ProtectedResourceMetadata = Schema.Struct({
  resource: Schema.String,
  authorization_servers: Schema.Array(Schema.String),
  bearer_methods_supported: Schema.Array(Schema.String),
  scopes_supported: Schema.Array(Schema.String),
});

const decodeMetadata = Schema.decodeUnknownSync(ProtectedResourceMetadata);

const decodeToolList = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      result: Schema.Struct({ tools: Schema.Array(Schema.Unknown) }),
    })
  )
);

const ENV = {
  LUCA_API_BASE_URL: "https://api.example.com",
  MCP_PUBLIC_ORIGIN: "https://mcp.example.com",
};

function request(path: string, init?: RequestInit) {
  return worker.fetch(new Request(`https://mcp.example.com${path}`, init), ENV);
}

describe("worker fetch handler", () => {
  it.each([
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-protected-resource",
  ])("serves RFC 9728 protected-resource metadata at %s", async (path) => {
    const response = await request(path);
    expect(response.status, path).toBe(200);

    const metadata = decodeMetadata(await response.json());

    expect(metadata.resource).toBe("https://mcp.example.com/mcp");
    expect(metadata.authorization_servers).toEqual([
      "https://api.example.com/api/auth",
    ]);
    expect(metadata.bearer_methods_supported).toEqual(["header"]);
    expect(metadata.scopes_supported).toContain("luca:read");
    // A refresh-token request, not something this resource checks.
    expect(metadata.scopes_supported).not.toContain("offline_access");
    expect(response.headers.get("cache-control")).toContain("max-age");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it.each([
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/mcp/server-card.json",
  ])("answers a browser preflight for %s", async (path) => {
    const response = await request(path, {
      method: "OPTIONS",
      headers: {
        origin: "https://inspector.example",
        "access-control-request-method": "GET",
        "access-control-request-headers": "mcp-protocol-version",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toContain(
      "GET"
    );
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "mcp-protocol-version"
    );
  });

  it("401s unauthenticated /mcp requests with a resource_metadata pointer", async () => {
    const response = await request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain("Bearer");
    expect(challenge).toContain(
      'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"'
    );
  });

  it("serves the OpenAI apps domain-verification token once configured", async () => {
    const path = "/.well-known/openai-apps-challenge";

    const unset = await request(path);
    expect(unset.status).toBe(404);

    const response = await worker.fetch(
      new Request(`https://mcp.example.com${path}`),
      { ...ENV, OPENAI_APPS_CHALLENGE_TOKEN: " challenge-token \n" }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("challenge-token");
  });

  it("lets an allowlisted browser origin reach auth and refuses others", async () => {
    const call = (origin: string) =>
      worker.fetch(
        new Request("https://mcp.example.com/mcp", {
          method: "POST",
          headers: { origin },
        }),
        { ...ENV, MCP_ALLOWED_ORIGINS: "inspector.example, ,other.example" }
      );

    expect((await call("https://inspector.example")).status).toBe(401);
    expect((await call("https://mcp.example.com")).status).toBe(401);
    expect((await call("https://evil.example")).status).toBe(403);
  });

  it("parses the allowed-origins list, dropping blanks", () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins(" a.example ,, b.example ")).toEqual([
      "a.example",
      "b.example",
    ]);
  });

  it("404s unknown paths", async () => {
    const response = await request("/nope");
    expect(response.status).toBe(404);
  });

  it("passes all three rate-limit bindings to the remote handler", async () => {
    const perToken = vi.fn(async () => ({ success: false }));
    const perTokenAddress = vi.fn(async () => ({ success: true }));
    const perAddress = vi.fn(async () => ({ success: false }));

    const env = {
      ...ENV,
      MCP_AUTH_RATE_LIMIT: { limit: perToken },
      MCP_TOKEN_ADDRESS_RATE_LIMIT: { limit: perTokenAddress },
      MCP_ANONYMOUS_RATE_LIMIT: { limit: perAddress },
    };

    const withToken = await worker.fetch(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: { authorization: `Bearer luca_${"a".repeat(64)}` },
      }),
      env
    );

    const withoutToken = await worker.fetch(
      new Request("https://mcp.example.com/mcp", { method: "POST" }),
      env
    );

    expect(withToken.status).toBe(429);
    expect(withoutToken.status).toBe(429);
    expect(perTokenAddress).toHaveBeenCalledOnce();
    expect(perToken).toHaveBeenCalledOnce();
    expect(perAddress).toHaveBeenCalledOnce();
  });

  it("keeps the in-memory limit across requests outside production", async () => {
    const send = () =>
      worker.fetch(
        new Request("https://mcp.example.com/mcp", {
          method: "POST",
          headers: { "cf-connecting-ip": "198.51.100.99" },
        }),
        { ...ENV, NODE_ENV: "development" }
      );

    const statuses: number[] = [];

    // oxlint-disable-next-line effect/imperative-loops -- the requests run one at a time so the limiter counts them in order
    for (let attempt = 0; attempt < 601; attempt += 1) {
      statuses.push((await send()).status);
    }

    expect(statuses.slice(0, 600).every((status) => status === 401)).toBe(true);
    expect(statuses[600]).toBe(429);
  }, 30_000);

  it("answers 500 in production when a rate-limit binding is missing", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    onTestFinished(() => consoleError.mockRestore());

    const limit = vi.fn(async () => ({ success: true }));

    const response = await worker.fetch(
      new Request("https://mcp.example.com/mcp", { method: "POST" }),
      { ...ENV, NODE_ENV: "production", MCP_AUTH_RATE_LIMIT: { limit } }
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "server_misconfigured" });
    expect(limit).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("MCP_ANONYMOUS_RATE_LIMIT")
    );
  });

  it("keeps working outside production without rate-limit bindings", async () => {
    const response = await worker.fetch(
      new Request("https://mcp.example.com/mcp", { method: "POST" }),
      { ...ENV, NODE_ENV: "development" }
    );

    expect(response.status).toBe(401);
  });

  it("answers 500 in production when only the token-address binding is missing", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    onTestFinished(() => consoleError.mockRestore());

    const limit = vi.fn(async () => ({ success: true }));

    const response = await worker.fetch(
      new Request("https://mcp.example.com/mcp", { method: "POST" }),
      {
        ...ENV,
        NODE_ENV: "production",
        MCP_AUTH_RATE_LIMIT: { limit },
        MCP_ANONYMOUS_RATE_LIMIT: { limit },
      }
    );

    expect(response.status).toBe(500);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("MCP_TOKEN_ADDRESS_RATE_LIMIT")
    );
  });

  it("requires the direct Luca API binding in production", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    onTestFinished(() => consoleError.mockRestore());

    const limit = vi.fn(async () => ({ success: true }));

    const response = await worker.fetch(
      new Request("https://mcp.example.com/mcp", { method: "POST" }),
      {
        ...ENV,
        NODE_ENV: "production",
        MCP_AUTH_RATE_LIMIT: { limit },
        MCP_TOKEN_ADDRESS_RATE_LIMIT: { limit },
        MCP_ANONYMOUS_RATE_LIMIT: { limit },
      }
    );

    expect(response.status).toBe(500);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("LUCA_API service binding")
    );
  });

  it("resolves bearer tokens through the direct Luca API binding", async () => {
    const serviceFetch = vi.fn<typeof fetch>(async () =>
      Response.json({ error: "unauthorized" }, { status: 401 })
    );

    const globalFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", globalFetch);

    onTestFinished(() => {
      vi.unstubAllGlobals();
    });

    const limit = vi.fn(async () => ({ success: true }));

    const response = await worker.fetch(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: { authorization: "Bearer eyJhbGciOiJFZERTQSJ9.e30.sig" },
      }),
      {
        ...ENV,
        NODE_ENV: "production",
        LUCA_API: { fetch: serviceFetch },
        MCP_AUTH_RATE_LIMIT: { limit },
        MCP_TOKEN_ADDRESS_RATE_LIMIT: { limit },
        MCP_ANONYMOUS_RATE_LIMIT: { limit },
      }
    );

    expect(response.status).toBe(401);
    expect(serviceFetch).toHaveBeenCalledWith(
      "https://api.example.com/oauth/resolve",
      expect.objectContaining({ redirect: "manual" })
    );
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("serves the tasks toolset when /mcp asks for it with ?toolset=tasks", async () => {
    // The developer key is verified against the API before a server is built.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ capabilities: [] }))
    );
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });

    const listTools = (path: string) =>
      worker.fetch(
        new Request(`https://mcp.example.com${path}`, {
          method: "POST",
          headers: {
            authorization: `Bearer luca_${"a".repeat(64)}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-06-18",
          },
          body: jsonText({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: {},
          }),
        }),
        ENV
      );

    const toolCount = async (path: string) => {
      const response = await listTools(path);
      const body = await response.text();

      const data = body
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice("data:".length);

      return decodeToolList(data ?? body).result.tools.length;
    };

    expect(await toolCount("/mcp?toolset=tasks")).toBe(
      1 + LUCA_TASK_TOOLS.length
    );
    expect(await toolCount("/mcp")).toBe(
      LUCA_OPERATIONS.length + LUCA_TASK_TOOLS.length
    );
  }, 15_000);

  it("answers every request with 500 when LUCA_AUTH_HEADER is unknown", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    onTestFinished(() => consoleError.mockRestore());

    const env = { ...ENV, LUCA_AUTH_HEADER: "cookie" };

    const card = await worker.fetch(
      new Request("https://mcp.example.com/.well-known/mcp/server-card.json"),
      env
    );

    const mcp = await worker.fetch(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: { authorization: `Bearer luca_${"a".repeat(64)}` },
      }),
      env
    );

    expect(card.status).toBe(500);
    expect(mcp.status).toBe(500);
    expect(await mcp.json()).toEqual({ error: "server_misconfigured" });
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("mcp.config_error")
    );
  });

  it("accepts the bearer alias for LUCA_AUTH_HEADER", async () => {
    const response = await worker.fetch(
      new Request("https://mcp.example.com/.well-known/mcp/server-card.json"),
      { ...ENV, LUCA_AUTH_HEADER: "Bearer" }
    );

    expect(response.status).toBe(200);
  });

  it("refuses a malformed luca_ token without calling the API", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });

    const response = await worker.fetch(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: { authorization: "Bearer luca_not-a-real-key" },
      }),
      ENV
    );

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends a non-developer token to the resolve endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ error: "unauthorized" }, { status: 401 })
    );

    vi.stubGlobal("fetch", fetchMock);
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });

    const response = await worker.fetch(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: { authorization: "Bearer eyJhbGciOiJFZERTQSJ9.e30.sig" },
      }),
      ENV
    );

    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/oauth/resolve",
      expect.anything()
    );
  });
});

describe("GET /.well-known/mcp/server-card.json", () => {
  it("reports the actual full-toolset tool count, not a stale literal", async () => {
    const response = await request("/.well-known/mcp/server-card.json");
    expect(response.status).toBe(200);

    const card = (await response.json()) as {
      capabilities: { tools: { enabled: boolean; count: number } };
    };

    // The card doesn't vary by ?toolset= today, so it advertises the default
    // full surface: every operation tool plus every task tool (registerTaskTool
    // runs unconditionally in createLucaServer regardless of toolset).
    expect(card.capabilities.tools.count).toBe(
      LUCA_OPERATIONS.length + LUCA_TASK_TOOLS.length
    );
  });

  it("returns the full server card body and headers exactly", async () => {
    const response = await request("/.well-known/mcp/server-card.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");

    const card = await response.json();
    expect(card).toEqual({
      serverInfo: LUCA_SERVER_INFO,
      endpoint: "https://mcp.example.com/mcp",
      transport: "streamable-http",
      capabilities: {
        tools: {
          enabled: true,
          count: LUCA_OPERATIONS.length + LUCA_TASK_TOOLS.length,
        },
        resources: { enabled: true },
        prompts: { enabled: true },
        logging: { enabled: true },
      },
      authentication: {
        type: "oauth2",
        issuer: "https://api.example.com/api/auth",
        metadataUrl:
          "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
      },
      description: LUCA_SERVER_INFO.description,
    });
  });

  it("normalizes multiple trailing slashes on both origins with no doubled slashes", async () => {
    const response = await worker.fetch(
      new Request("https://mcp.example.com/.well-known/mcp/server-card.json"),
      {
        LUCA_API_BASE_URL: "https://api.example.com///",
        MCP_PUBLIC_ORIGIN: "https://mcp.example.com//",
      }
    );

    const card = (await response.json()) as {
      endpoint: string;
      authentication: { issuer: string; metadataUrl: string };
    };

    expect(card.endpoint).toBe("https://mcp.example.com/mcp");
    expect(card.authentication.issuer).toBe("https://api.example.com/api/auth");
    expect(card.authentication.metadataUrl).toBe(
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp"
    );
  });

  it.each([
    "mcp.example.com",
    "https://mcp.example.com/mcp",
    "https://mcp.example.com?x=1",
    "ftp://mcp.example.com",
  ])(
    "answers 500 when MCP_PUBLIC_ORIGIN is %s, which is not an origin",
    async (publicOrigin) => {
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      onTestFinished(() => consoleError.mockRestore());

      const response = await worker.fetch(
        new Request("https://mcp.example.com/.well-known/mcp/server-card.json"),
        { ...ENV, MCP_PUBLIC_ORIGIN: publicOrigin }
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "server_misconfigured" });
    }
  );

  it("falls back to the request's own origin when no public origin is configured", async () => {
    const response = await worker.fetch(
      new Request(
        "https://preview.workers.dev/.well-known/mcp/server-card.json"
      ),
      { LUCA_API_BASE_URL: "https://api.example.com" }
    );

    const card = (await response.json()) as {
      endpoint: string;
      authentication: { metadataUrl: string };
    };

    expect(card.endpoint).toBe("https://preview.workers.dev/mcp");
    expect(card.authentication.metadataUrl).toBe(
      "https://preview.workers.dev/.well-known/oauth-protected-resource/mcp"
    );
  });

  it("defaults the api origin to api.setluca.com when unconfigured", async () => {
    const response = await worker.fetch(
      new Request("https://mcp.example.com/.well-known/mcp/server-card.json"),
      { MCP_PUBLIC_ORIGIN: "https://mcp.example.com" }
    );

    const card = (await response.json()) as {
      authentication: { issuer: string };
    };

    expect(card.authentication.issuer).toBe("https://api.setluca.com/api/auth");
  });
});

describe("resolveToolset", () => {
  it("prefers the query param, falls back to env, defaults to full", () => {
    expect(
      resolveToolset(new URL("https://mcp.setluca.com/mcp?toolset=tasks"), {})
    ).toBe("tasks");
    expect(
      resolveToolset(new URL("https://mcp.setluca.com/mcp"), {
        LUCA_TOOLSET: "tasks",
      })
    ).toBe("tasks");
    expect(
      resolveToolset(new URL("https://mcp.setluca.com/mcp?toolset=bogus"), {})
    ).toBe("full");
    expect(resolveToolset(new URL("https://mcp.setluca.com/mcp"), {})).toBe(
      "full"
    );
  });
});
