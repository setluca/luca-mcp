import { describe, expect, it, vi } from "vitest";

import { checkDeployment } from "../scripts/check-deployed-worker.ts";

const origin = "https://mcp.setluca.com";

function response(
  body: unknown,
  status = 200,
  headers?: Record<string, string>
): Response {
  if (headers) {
    return Response.json(body, { status, headers });
  }

  return Response.json(body, { status });
}

const challenge = () =>
  response({}, 401, {
    "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
  });

/** Responses keyed by URL, or by `<url> from <origin>` for a browser origin. */
function fetcher(
  overrides: Partial<Record<string, Response>> = {}
): typeof fetch {
  const responses = new Map<string, Response>([
    [
      `${origin}/.well-known/mcp/server-card.json`,
      response({
        serverInfo: { version: "1.2.3" },
        endpoint: `${origin}/mcp`,
      }),
    ],
    [
      `${origin}/.well-known/oauth-protected-resource/mcp`,
      response({
        resource: `${origin}/mcp`,
        authorization_servers: ["https://api.setluca.com/api/auth"],
      }),
    ],
    [`${origin}/mcp`, challenge()],
    [`${origin}/mcp from https://claude.ai`, challenge()],
    ...Object.entries(overrides).filter(
      (entry): entry is [string, Response] => entry[1] !== undefined
    ),
  ]);

  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const caller = new Headers(init?.headers).get("origin");
    const key = caller === null ? String(url) : `${String(url)} from ${caller}`;
    const result = responses.get(key);

    if (!result) {
      throw new Error(`Unexpected request: ${key}`);
    }

    return result;
  }) as typeof fetch;
}

describe("deployed Worker check", () => {
  it("accepts a matching server card, OAuth metadata, and 401 challenge", async () => {
    const request = fetcher();
    await expect(checkDeployment("1.2.3", request)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("names the origin when production refuses Claude's connector", async () => {
    const refused = Response.json(
      { error: { message: "Invalid Origin: claude.ai" } },
      { status: 403 }
    );

    await expect(
      checkDeployment(
        "1.2.3",
        fetcher({ [`${origin}/mcp from https://claude.ai`]: refused })
      )
    ).rejects.toThrow(
      "Unauthenticated MCP request from https://claude.ai returned 403"
    );
  });

  it.each([
    [
      "server card error",
      `${origin}/.well-known/mcp/server-card.json`,
      response({}, 503),
    ],
    [
      "wrong version",
      `${origin}/.well-known/mcp/server-card.json`,
      response({ serverInfo: { version: "0.0.0" }, endpoint: `${origin}/mcp` }),
    ],
    [
      "OAuth metadata error",
      `${origin}/.well-known/oauth-protected-resource/mcp`,
      response({}, 503),
    ],
    [
      "wrong OAuth issuer",
      `${origin}/.well-known/oauth-protected-resource/mcp`,
      response({
        resource: `${origin}/mcp`,
        authorization_servers: ["https://example.com"],
      }),
    ],
    ["missing challenge", `${origin}/mcp`, response({}, 401)],
    [
      "missing challenge for claude.ai",
      `${origin}/mcp from https://claude.ai`,
      response({}, 401),
    ],
  ])("rejects %s", async (_name, url, badResponse) => {
    await expect(
      checkDeployment("1.2.3", fetcher({ [url]: badResponse }))
    ).rejects.toThrow();
  });
});
