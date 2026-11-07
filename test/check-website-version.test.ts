import { describe, expect, it, vi } from "vitest";

import { websiteVersionDrift } from "../scripts/check-website-version.ts";

const fetcher = (page: string, version = "1.2.3"): typeof fetch =>
  vi.fn(async (url: string | URL | Request) =>
    String(url).includes("registry.npmjs.org")
      ? Response.json({ version })
      : new Response(page)
  );

describe("website version check", () => {
  it("passes when the site names npm's latest", async () => {
    await expect(
      websiteVersionDrift(fetcher("npx -y @setluca/mcp@1.2.3"))
    ).resolves.toBeUndefined();
  });

  it("names both versions when the site is behind", async () => {
    await expect(
      websiteVersionDrift(fetcher("npx -y @setluca/mcp@1.2.2"))
    ).resolves.toContain("says 1.2.2, and npm's latest is 1.2.3");
  });

  it("says so when the page stops naming a version", async () => {
    await expect(
      websiteVersionDrift(fetcher("npx -y @setluca/mcp"))
    ).resolves.toContain("no longer names a version");
  });

  it("throws when a source can't be read, rather than passing", async () => {
    const down: typeof fetch = vi.fn(
      async () => new Response("down", { status: 503 })
    );

    await expect(websiteVersionDrift(down)).rejects.toThrow("503");
  });
});
