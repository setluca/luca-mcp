import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { unstable_readConfig } from "wrangler";

import worker from "../src/worker.ts";

const config = unstable_readConfig({
  config: join(import.meta.dirname, "..", "wrangler.toml"),
  env: "production",
});

const metadataUrl =
  "https://mcp.setluca.com/.well-known/oauth-protected-resource/mcp";

/**
 * The production Worker's environment as `wrangler.toml` declares it, with
 * stand-ins for the bindings. No request here carries a token, so none should
 * reach the API.
 */
function productionEnv() {
  const limit = async () => ({ success: true });
  const api = { fetch: vi.fn<typeof fetch>() };

  const env = {
    ...config.vars,
    ...Object.fromEntries(
      config.ratelimits.map((binding: { name: string }) => [
        binding.name,
        { limit },
      ])
    ),
    ...Object.fromEntries(
      (config.services ?? []).map((service: { binding: string }) => [
        service.binding,
        api,
      ])
    ),
  };

  return { env, api };
}

async function send(method: string, origin?: string) {
  const { env, api } = productionEnv();
  const headers = new Headers();

  if (origin !== undefined) {
    headers.set("origin", origin);
  }

  const response = await worker.fetch(
    new Request("https://mcp.setluca.com/mcp", {
      method,
      headers,
    }),
    env
  );

  expect(api.fetch).not.toHaveBeenCalled();

  return response;
}

describe("production static assets", () => {
  // Wrangler reads the directory relative to wrangler.toml.
  const directory = join(
    import.meta.dirname,
    "..",
    config.assets?.directory ?? "missing"
  );

  it("serves public/ ahead of the Worker", () => {
    expect(directory).toBe(join(import.meta.dirname, "..", "public"));
  });

  // Claude falls back to the favicon Google indexed for the connector's
  // domain, and the landing pages link the rest.
  it.each([
    ["favicon.ico", [0x00, 0x00, 0x01, 0x00]],
    ["favicon-32x32.png", [0x89, 0x50, 0x4e, 0x47]],
    ["apple-touch-icon.png", [0x89, 0x50, 0x4e, 0x47]],
    ["android-chrome-512x512.png", [0x89, 0x50, 0x4e, 0x47]],
  ])("ships %s as a real image", (file, magic) => {
    const bytes = readFileSync(join(directory, file));

    expect([...bytes.subarray(0, magic.length)]).toEqual(magic);
  });

  it("ships favicon.svg as an SVG", () => {
    expect(readFileSync(join(directory, "favicon.svg"), "utf-8")).toMatch(
      /^<svg /
    );
  });
});

describe("production Worker origin check", () => {
  it.each([
    ["no Origin", undefined],
    ["the Worker's own origin", "https://mcp.setluca.com"],
    ["Claude's connector on claude.ai", "https://claude.ai"],
    ["Claude's connector on claude.com", "https://claude.com"],
  ])(
    "answers %s with the 401 OAuth challenge before sign-in",
    async (_name, origin) => {
      const response = await send("POST", origin);

      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain(
        `resource_metadata="${metadataUrl}"`
      );
    }
  );

  it.each(["GET", "DELETE"])(
    "challenges a %s from claude.ai instead of refusing it",
    async (method) => {
      const response = await send(method, "https://claude.ai");

      expect(response.status).toBe(401);
    }
  );

  it.each([
    "https://evil.example",
    "https://evil.claude.ai",
    "https://claude.ai.evil.example",
    "https://notclaude.ai",
    "null",
  ])("still refuses the browser origin %s", async (origin) => {
    const response = await send("POST", origin);

    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toBeNull();
  });
});
