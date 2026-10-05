import * as Arr from "effect/Array";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { bindingRateLimits, createRemoteHandler } from "../src/remote.ts";
import { declines, MCP_URL, VALID_API_KEY } from "./remote-fixtures.ts";

describe("remote transport rate limits", () => {
  /** Limiters that record every key charged and grant or refuse all of them. */
  function recordingLimiters(success: boolean) {
    const charged: { limiter: string; key: string }[] = [];

    const limiter = (name: string) => ({
      limit: vi.fn(async ({ key }: { key: string }) => {
        charged.push({ limiter: name, key });

        return { success };
      }),
    });

    return {
      charged,
      rateLimits: bindingRateLimits({
        perToken: limiter("perToken"),
        perTokenAddress: limiter("perTokenAddress"),
        perAnonymousAddress: limiter("perAnonymousAddress"),
      }),
    };
  }

  it("throttles a bearer request before OAuth resolution or MCP setup", async () => {
    const resolveToken = vi.fn(declines);
    const { charged, rateLimits } = recordingLimiters(false);

    const handler = createRemoteHandler({ resolveToken, rateLimits });

    const response = await handler(
      new Request(MCP_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${VALID_API_KEY}`,
          "cf-connecting-ip": "198.51.100.7",
        },
      })
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(resolveToken).not.toHaveBeenCalled();
    expect(charged).toEqual([
      { limiter: "perTokenAddress", key: "ip:198.51.100.7" },
    ]);
  });

  it.each([
    ["with a token", { authorization: `Bearer ${VALID_API_KEY}` }],
    ["without a token", {}],
  ])(
    "charges no budget for a browser request from another site %s",
    async (_label, headers) => {
      const { charged, rateLimits } = recordingLimiters(true);

      const handler = createRemoteHandler({
        resolveToken: declines,
        rateLimits,
      });

      const response = await handler(
        new Request(MCP_URL, {
          method: "POST",
          headers: {
            ...headers,
            origin: "https://evil.example",
            "cf-connecting-ip": "198.51.100.7",
          },
        })
      );

      // A page on another site must not spend the budget of a coach who
      // shares its visitor's address.
      expect(response.status).toBe(403);
      expect(charged).toEqual([]);
    }
  );

  it("charges a bearer request to its token under a non-reversible fingerprint, after its address", async () => {
    const { charged, rateLimits } = recordingLimiters(true);

    const handler = createRemoteHandler({
      resolveToken: declines,
      rateLimits,
    });

    const response = await handler(
      new Request(MCP_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${VALID_API_KEY}`,
          "cf-connecting-ip": "198.51.100.7",
        },
      })
    );

    expect(response.status).toBe(401);
    expect(charged).toEqual([
      { limiter: "perTokenAddress", key: "ip:198.51.100.7" },
      {
        limiter: "perToken",
        key: expect.stringMatching(/^token:[a-f0-9]{64}$/),
      },
    ]);
    expect(charged[1]?.key).not.toContain(VALID_API_KEY);
  });

  it("answers 429 when a token-bearing request's address is over budget, whatever the token", async () => {
    const charged: string[] = [];

    const limiter = (name: string, success: boolean) => ({
      limit: async () => {
        charged.push(name);

        return { success };
      },
    });

    const handler = createRemoteHandler({
      resolveToken: declines,
      rateLimits: bindingRateLimits({
        perToken: limiter("perToken", true),
        perTokenAddress: limiter("perTokenAddress", false),
        perAnonymousAddress: limiter("perAnonymousAddress", true),
      }),
    });

    const response = await handler(
      new Request(MCP_URL, {
        method: "POST",
        headers: { authorization: "Bearer garbage" },
      })
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: "rate_limited",
      detail: "Too many requests",
    });
    expect(charged).toEqual(["perTokenAddress"]);
  });

  it("charges the token under its SHA-256 hash", async () => {
    const { charged, rateLimits } = recordingLimiters(true);
    const handler = createRemoteHandler({ resolveToken: declines, rateLimits });

    await handler(
      new Request(MCP_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${VALID_API_KEY}` },
      })
    );

    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(VALID_API_KEY)
    );

    const hex = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");

    expect(charged).toContainEqual({
      limiter: "perToken",
      key: `token:${hex}`,
    });
  });

  it("charges every address in one IPv6 /64 to the same budget", async () => {
    const { charged, rateLimits } = recordingLimiters(true);
    const handler = createRemoteHandler({ resolveToken: declines, rateLimits });

    const sendFrom = (ip: string) =>
      handler(
        new Request(MCP_URL, {
          method: "POST",
          headers: { "cf-connecting-ip": ip },
        })
      );

    await sendFrom("2001:db8:1:2::1");
    await sendFrom("2001:0DB8:0001:0002:ffff:0:0:9");

    expect(charged).toEqual([
      { limiter: "perAnonymousAddress", key: "ip:2001:db8:1:2::/64" },
      { limiter: "perAnonymousAddress", key: "ip:2001:db8:1:2::/64" },
    ]);
  });

  it("gives two tokens from one address separate per-token budgets", async () => {
    const { charged, rateLimits } = recordingLimiters(true);

    const handler = createRemoteHandler({
      resolveToken: declines,
      rateLimits,
    });

    const send = (token: string) =>
      handler(
        new Request(MCP_URL, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "cf-connecting-ip": "198.51.100.7",
          },
        })
      );

    await send(VALID_API_KEY);
    await send(`luca_${"b".repeat(64)}`);

    const tokenKeys = charged
      .filter(({ limiter }) => limiter === "perToken")
      .map(({ key }) => key);

    expect(Arr.dedupe(tokenKeys)).toHaveLength(2);
  });

  it("charges a request without a token to its Cloudflare address before the 401", async () => {
    const { charged, rateLimits } = recordingLimiters(true);

    const handler = createRemoteHandler({
      resolveToken: declines,
      rateLimits,
    });

    const response = await handler(
      new Request(MCP_URL, {
        method: "POST",
        headers: { "cf-connecting-ip": " 198.51.100.7 " },
      })
    );

    expect(response.status).toBe(401);
    expect(charged).toEqual([
      { limiter: "perAnonymousAddress", key: "ip:198.51.100.7" },
    ]);
  });

  it("answers 429 to a request without a token once its address is over budget", async () => {
    const { rateLimits } = recordingLimiters(false);

    const handler = createRemoteHandler({
      resolveToken: declines,
      rateLimits,
    });

    const response = await handler(new Request(MCP_URL, { method: "POST" }));

    expect(response.status).toBe(429);
  });

  it("ignores X-Forwarded-For, which any client can set", async () => {
    const { charged, rateLimits } = recordingLimiters(true);

    const handler = createRemoteHandler({
      resolveToken: declines,
      rateLimits,
    });

    await handler(
      new Request(MCP_URL, {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.4, 10.0.0.1" },
      })
    );

    expect(charged).toEqual([
      { limiter: "perAnonymousAddress", key: "ip:unknown" },
    ]);
  });

  it("fails closed when the distributed authentication limiter is unavailable", async () => {
    const resolveToken = vi.fn(declines);

    const unavailable = {
      limit: async (): Promise<{ success: boolean }> => {
        // oxlint-disable-next-line effect/avoid-untagged-errors -- a failing rate-limit binding throws a plain Error, the case under test
        throw new Error("binding unavailable");
      },
    };

    const handler = createRemoteHandler({
      resolveToken,
      rateLimits: bindingRateLimits({
        perToken: unavailable,
        perTokenAddress: unavailable,
        perAnonymousAddress: unavailable,
      }),
    });

    const withToken = await handler(
      new Request(MCP_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${VALID_API_KEY}` },
      })
    );

    const withoutToken = await handler(
      new Request(MCP_URL, { method: "POST" })
    );

    expect(withToken.status).toBe(503);
    expect(withoutToken.status).toBe(503);
    expect(resolveToken).not.toHaveBeenCalled();
  });

  describe("in-memory limiter", () => {
    const sendFrom =
      (handler: (request: Request) => Promise<Response>) => (ip: string) =>
        handler(
          new Request(MCP_URL, {
            method: "POST",
            headers: { "cf-connecting-ip": ip },
          })
        );

    it("answers 429 once an address spends its budget", async () => {
      const send = sendFrom(createRemoteHandler({ resolveToken: declines }));
      const statuses: number[] = [];

      // oxlint-disable-next-line effect/imperative-loops -- the requests run one at a time so the limiter counts them in order
      for (let attempt = 0; attempt < 601; attempt += 1) {
        statuses.push((await send("198.51.100.1")).status);
      }

      expect(statuses.slice(0, 600).every((status) => status === 401)).toBe(
        true
      );
      expect(statuses[600]).toBe(429);
      expect((await send("198.51.100.2")).status).toBe(401);
    });

    const sendToken =
      (handler: (request: Request) => Promise<Response>) =>
      (token: string, ip = "198.51.100.1") =>
        handler(
          new Request(MCP_URL, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "cf-connecting-ip": ip,
            },
          })
        );

    it("answers 429 once a token spends its 60 requests", async () => {
      const send = sendToken(createRemoteHandler({ resolveToken: declines }));
      const statuses: number[] = [];

      // oxlint-disable-next-line effect/imperative-loops -- the requests run one at a time so the limiter counts them in order
      for (let attempt = 0; attempt < 61; attempt += 1) {
        statuses.push((await send(VALID_API_KEY)).status);
      }

      expect(statuses.slice(0, 60).every((status) => status === 401)).toBe(
        true
      );
      expect(statuses[60]).toBe(429);
      // Another token from the same address has its own budget.
      expect((await send(`luca_${"b".repeat(64)}`)).status).toBe(401);
    });

    it("answers 429 once an address spends 600 token-bearing requests, whatever the tokens", async () => {
      const send = sendToken(createRemoteHandler({ resolveToken: declines }));
      const statuses: number[] = [];

      // oxlint-disable-next-line effect/imperative-loops -- the requests run one at a time so the limiter counts them in order
      for (let attempt = 0; attempt < 601; attempt += 1) {
        statuses.push((await send(`fresh-${attempt}`)).status);
      }

      expect(statuses.slice(0, 600).every((status) => status === 401)).toBe(
        true
      );
      expect(statuses[600]).toBe(429);
      expect((await send("fresh-other", "198.51.100.2")).status).toBe(401);
    }, 30_000);

    it("keeps its budgets per handler, not per process", async () => {
      const first = sendFrom(createRemoteHandler({ resolveToken: declines }));
      const second = sendFrom(createRemoteHandler({ resolveToken: declines }));

      // oxlint-disable-next-line effect/imperative-loops -- the requests run one at a time so the limiter counts them in order
      for (let attempt = 0; attempt < 601; attempt += 1) {
        await first("198.51.100.1");
      }

      expect((await first("198.51.100.1")).status).toBe(429);
      expect((await second("198.51.100.1")).status).toBe(401);
    });

    it("rejects a new key instead of evicting a live one when the table is full", async () => {
      const send = sendFrom(createRemoteHandler({ resolveToken: declines }));

      // oxlint-disable-next-line effect/imperative-loops -- the requests run one at a time so the limiter counts them in order
      for (let key = 0; key < 10_000; key += 1) {
        await send(`key-${key}`);
      }

      expect((await send("one-too-many")).status).toBe(429);
      // A key already in the table keeps its own budget.
      expect((await send("key-0")).status).toBe(401);
    });

    it("frees the table once its windows expire", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      onTestFinished(() => {
        vi.useRealTimers();
      });

      const send = sendFrom(createRemoteHandler({ resolveToken: declines }));

      // oxlint-disable-next-line effect/imperative-loops -- the requests run one at a time so the limiter counts them in order
      for (let key = 0; key < 10_000; key += 1) {
        await send(`key-${key}`);
      }

      expect((await send("one-too-many")).status).toBe(429);
      // oxlint-disable-next-line effect/use-clock-service -- moves the clock vitest fakes, which only Date reads
      vi.setSystemTime(Date.now() + 61_000);
      expect((await send("one-too-many")).status).toBe(401);
    }, 30_000);
  });
});
