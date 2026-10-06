import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { loadRemoteSettings, type RemoteSettings } from "../src/config.ts";
import { apiKeyResolver, looksLikeDeveloperKey } from "../src/remote.ts";
import { createKeyCheckCache } from "../src/resolvers.ts";
import type { TokenResolver } from "../src/token-verification.ts";
import { revealApiKey } from "./helpers.ts";
import {
  acceptingFetch,
  DEFAULT_SETTINGS,
  VALID_API_KEY,
} from "./remote-fixtures.ts";

describe("apiKeyResolver", () => {
  /** A resolver with its own check cache, so no test inherits another's pass. */
  const keyResolver = (
    settings: RemoteSettings,
    fetchImpl: typeof fetch,
    checks = createKeyCheckCache()
  ) => apiKeyResolver(settings, fetchImpl, checks);

  const resolve = (resolver: TokenResolver, token: string) =>
    Effect.runPromise(
      resolver(token).pipe(
        Effect.map((config) =>
          Option.getOrNull(Option.map(config, revealApiKey))
        )
      )
    );

  const failureTag = (resolver: TokenResolver, token: string) =>
    Effect.runPromise(
      Effect.exit(resolver(token)).pipe(
        Effect.map((exit) =>
          Exit.isFailure(exit)
            ? (Option.getOrNull(Exit.findErrorOption(exit))?._tag ?? null)
            : null
        )
      )
    );

  const neverCalled = () =>
    vi.fn<typeof fetch>(async () => {
      // oxlint-disable-next-line effect/avoid-untagged-errors -- a plain throw fails the test if the resolver reaches fetch
      throw new Error("the API must not be called");
    });

  it("resolves a verified developer key to the production API by default", async () => {
    expect(
      await resolve(
        keyResolver(DEFAULT_SETTINGS, acceptingFetch),
        VALID_API_KEY
      )
    ).toEqual({
      apiBaseUrl: "https://api.setluca.com",
      apiKey: VALID_API_KEY,
      authHeader: "x-api-key",
    });
  });

  it("verifies the key with one GET to the API before accepting it", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({}));

    await resolve(keyResolver(DEFAULT_SETTINGS, fetchMock), VALID_API_KEY);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "https://api.setluca.com/api/capabilities",
      expect.objectContaining({
        method: "GET",
        redirect: "manual",
        headers: expect.objectContaining({ "x-api-key": VALID_API_KEY }),
      })
    );
  });

  it("sends the key in the configured auth header", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({}));

    const settings = Effect.runSync(
      loadRemoteSettings({ LUCA_AUTH_HEADER: "bearer" })
    );

    await resolve(keyResolver(settings, fetchMock), VALID_API_KEY);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: `Bearer ${VALID_API_KEY}`,
        }),
      })
    );
  });

  it("carries the auth header and timeout from the settings", async () => {
    const resolver = keyResolver(
      Effect.runSync(
        loadRemoteSettings({
          LUCA_API_BASE_URL: "https://api.example.com///",
          LUCA_AUTH_HEADER: "bearer",
          LUCA_REQUEST_TIMEOUT_MS: "5000",
        })
      ),
      acceptingFetch
    );

    expect(await resolve(resolver, VALID_API_KEY)).toEqual({
      apiBaseUrl: "https://api.example.com",
      apiKey: VALID_API_KEY,
      authHeader: "authorization",
      requestTimeoutMs: 5000,
    });
  });

  it("declines a fabricated key the API answers 401 for", async () => {
    const resolver = keyResolver(DEFAULT_SETTINGS, (async () =>
      Response.json(
        { error: "unauthorized" },
        { status: 401 }
      )) as typeof fetch);

    expect(await resolve(resolver, VALID_API_KEY)).toBeNull();
  });

  it.each([404, 429, 500, 503])(
    "fails as unavailable when the API answers %i, which says nothing about the key",
    async (status) => {
      const resolver = keyResolver(DEFAULT_SETTINGS, (async () =>
        Response.json({}, { status })) as typeof fetch);

      expect(await failureTag(resolver, VALID_API_KEY)).toBe(
        "TokenVerificationUnavailable"
      );
    }
  );

  const lucaForbidden = () =>
    Response.json(
      {
        error: {
          code: "scope_required",
          message: "API key scope is required",
          requestId: "req_1",
        },
      },
      { status: 403 }
    );

  it("accepts a key the API answers 403 for in its own error shape, since the key is valid", async () => {
    const resolver = keyResolver(DEFAULT_SETTINGS, (async () =>
      lucaForbidden()) as typeof fetch);

    expect(await resolve(resolver, VALID_API_KEY)).toEqual({
      apiBaseUrl: "https://api.setluca.com",
      apiKey: VALID_API_KEY,
      authHeader: "x-api-key",
    });
  });

  it("accepts a key the API asks to name a workspace, since the key is valid", async () => {
    const resolver = keyResolver(DEFAULT_SETTINGS, (async () =>
      Response.json(
        { error: "workspace_required" },
        { status: 400 }
      )) as typeof fetch);

    expect(await resolve(resolver, VALID_API_KEY)).toEqual(
      expect.objectContaining({ apiKey: VALID_API_KEY })
    );
  });

  it("declines a key that reaches no workspace", async () => {
    const resolver = keyResolver(DEFAULT_SETTINGS, (async () =>
      Response.json({ error: "forbidden" }, { status: 403 })) as typeof fetch);

    expect(await resolve(resolver, VALID_API_KEY)).toBeNull();
  });

  it("fails as unavailable on a 400 with any other body", async () => {
    const resolver = keyResolver(DEFAULT_SETTINGS, (async () =>
      Response.json(
        { error: "bad_request" },
        { status: 400 }
      )) as typeof fetch);

    expect(await failureTag(resolver, VALID_API_KEY)).toBe(
      "TokenVerificationUnavailable"
    );
  });

  it("gives up on a key check after 5 seconds and aborts it", async () => {
    let signal: AbortSignal | undefined;

    const fetchMock = vi.fn<typeof fetch>((_url, init) => {
      signal = init?.signal ?? undefined;

      return new Promise<Response>(() => {});
    });

    const settings = Effect.runSync(
      loadRemoteSettings({ LUCA_REQUEST_TIMEOUT_MS: "30000" })
    );

    const outcome = await Effect.runPromise(
      Effect.flip(keyResolver(settings, fetchMock)(VALID_API_KEY))
    );

    expect(outcome.message).toBe(
      "Token verification did not answer within 5000ms"
    );
    expect(signal?.aborted).toBe(true);
  }, 10_000);

  it.each([
    [
      "an edge page",
      () => new Response("<html>blocked</html>", { status: 403 }),
    ],
    [
      "an unrelated JSON body",
      () => Response.json({ error: "no" }, { status: 403 }),
    ],
    ["an empty body", () => new Response(null, { status: 403 })],
  ])("fails as unavailable on a 403 with %s", async (_name, answer) => {
    const resolver = keyResolver(DEFAULT_SETTINGS, (async () =>
      answer()) as typeof fetch);

    expect(await failureTag(resolver, VALID_API_KEY)).toBe(
      "TokenVerificationUnavailable"
    );
  });

  describe("check cache", () => {
    const countingFetch = (answer: () => Response) =>
      vi.fn<typeof fetch>(async () => answer());

    it("skips the API for a key that passed within 60 seconds", async () => {
      const fetchMock = countingFetch(() => Response.json({}));
      const resolver = keyResolver(DEFAULT_SETTINGS, fetchMock);

      await resolve(resolver, VALID_API_KEY);
      expect(await resolve(resolver, VALID_API_KEY)).toEqual(
        expect.objectContaining({ apiKey: VALID_API_KEY })
      );
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("shares the cache between resolvers built from it", async () => {
      const fetchMock = countingFetch(() => Response.json({}));
      const checks = createKeyCheckCache();

      await resolve(
        keyResolver(DEFAULT_SETTINGS, fetchMock, checks),
        VALID_API_KEY
      );
      await resolve(
        keyResolver(DEFAULT_SETTINGS, fetchMock, checks),
        VALID_API_KEY
      );
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("checks again once the 60 seconds are up", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      onTestFinished(() => {
        vi.useRealTimers();
      });

      const fetchMock = countingFetch(() => Response.json({}));
      const resolver = keyResolver(DEFAULT_SETTINGS, fetchMock);

      await resolve(resolver, VALID_API_KEY);
      // oxlint-disable-next-line effect/use-clock-service -- moves the clock vitest fakes, which only Date reads
      vi.setSystemTime(Date.now() + 59_000);
      await resolve(resolver, VALID_API_KEY);
      expect(fetchMock).toHaveBeenCalledOnce();

      // oxlint-disable-next-line effect/use-clock-service -- moves the clock vitest fakes, which only Date reads
      vi.setSystemTime(Date.now() + 2000);
      await resolve(resolver, VALID_API_KEY);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("never caches a refusal or an outage", async () => {
      const answers = [401, 503, 401].map(
        (status) => () => Response.json({}, { status })
      );

      const fetchMock = vi.fn<typeof fetch>(async () => {
        const answer = answers.shift();

        return answer?.() ?? Response.json({});
      });

      const resolver = keyResolver(DEFAULT_SETTINGS, fetchMock);

      expect(await resolve(resolver, VALID_API_KEY)).toBeNull();
      expect(await failureTag(resolver, VALID_API_KEY)).toBe(
        "TokenVerificationUnavailable"
      );
      expect(await resolve(resolver, VALID_API_KEY)).toBeNull();
      expect(await resolve(resolver, VALID_API_KEY)).not.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it("never caches a 429 from the key check", async () => {
      const answers = [429];

      const fetchMock = vi.fn<typeof fetch>(async () => {
        const status = answers.shift();

        return status === undefined
          ? Response.json({})
          : Response.json({}, { status });
      });

      const resolver = keyResolver(DEFAULT_SETTINGS, fetchMock);

      expect(await failureTag(resolver, VALID_API_KEY)).toBe(
        "TokenVerificationUnavailable"
      );
      expect(await resolve(resolver, VALID_API_KEY)).not.toBeNull();
      expect(await resolve(resolver, VALID_API_KEY)).not.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("holds a hash of the key, never the key", async () => {
      const checks = createKeyCheckCache();

      await resolve(
        keyResolver(DEFAULT_SETTINGS, acceptingFetch, checks),
        VALID_API_KEY
      );

      expect([...checks.keys()]).toEqual([
        expect.stringMatching(/^[a-f0-9]{64}$/),
      ]);
      expect([...checks.keys()].join(",")).not.toContain(VALID_API_KEY);
    });

    it("stays bounded: a full table of live passes skips caching instead of growing", async () => {
      const checks = createKeyCheckCache();
      const resolver = keyResolver(DEFAULT_SETTINGS, acceptingFetch, checks);

      // oxlint-disable-next-line effect/imperative-loops -- the passes are cached one at a time until the table is full
      for (let index = 0; index < 10_000; index += 1) {
        await resolve(resolver, `luca_${index.toString(16).padStart(64, "0")}`);
      }

      expect(checks.size()).toBe(10_000);
      await resolve(resolver, `luca_${"f".repeat(64)}`);
      expect(checks.size()).toBe(10_000);
    }, 30_000);

    it("sweeps expired passes when the table is full", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      onTestFinished(() => {
        vi.useRealTimers();
      });

      const checks = createKeyCheckCache();
      const resolver = keyResolver(DEFAULT_SETTINGS, acceptingFetch, checks);

      // oxlint-disable-next-line effect/imperative-loops -- the passes are cached one at a time until the table is full
      for (let index = 0; index < 10_000; index += 1) {
        await resolve(resolver, `luca_${index.toString(16).padStart(64, "0")}`);
      }

      // oxlint-disable-next-line effect/use-clock-service -- moves the clock vitest fakes, which only Date reads
      vi.setSystemTime(Date.now() + 61_000);
      await resolve(resolver, `luca_${"f".repeat(64)}`);
      expect(checks.size()).toBe(1);
    }, 30_000);
  });

  it("fails as unavailable when the API cannot be reached", async () => {
    const resolver = keyResolver(DEFAULT_SETTINGS, (() =>
      // oxlint-disable-next-line effect/avoid-untagged-errors -- fetch rejects with a plain Error, and this stub reproduces it
      Promise.reject(new Error("boom"))) as typeof fetch);

    expect(await failureTag(resolver, VALID_API_KEY)).toBe(
      "TokenVerificationUnavailable"
    );
  });

  it("rejects a token without the luca_ prefix, with no API call", async () => {
    const fetchMock = neverCalled();

    expect(
      await resolve(keyResolver(DEFAULT_SETTINGS, fetchMock), "not-a-luca-key")
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed luca_ token with no API call", async () => {
    const fetchMock = neverCalled();
    const resolver = keyResolver(DEFAULT_SETTINGS, fetchMock);
    expect(await resolve(resolver, "luca_not-a-real-key")).toBeNull();
    expect(await resolve(resolver, "luca_")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("looksLikeDeveloperKey", () => {
  it.each([VALID_API_KEY, "LUCA_ABC", "luca_not-a-real-key", "luca_"])(
    "sends %s to apiKeyResolver",
    (token) => {
      expect(looksLikeDeveloperKey(token)).toBe(true);
    }
  );

  it.each(["luca_ort_something", "eyJhbGciOiJFZERTQSJ9.e30.sig", "xluca_0"])(
    "sends %s to oauthResolver",
    (token) => {
      expect(looksLikeDeveloperKey(token)).toBe(false);
    }
  );
});
