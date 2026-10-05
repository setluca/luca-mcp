import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";
import { describe, expect, it, vi } from "vitest";

import { loadRemoteSettings, type RemoteSettingsEnv } from "../src/config.ts";
import { oauthResolver } from "../src/oauth-resolver.ts";
import type { TokenResolver } from "../src/remote.ts";
import { revealApiKey } from "./helpers.ts";

/** The settings the Worker would decode from this env. */
const settingsFor = (env: RemoteSettingsEnv) =>
  Effect.runSync(loadRemoteSettings(env));

/** The config a resolver answers with, or null when it declines. */
const run = (resolve: TokenResolver, token: string) =>
  Effect.runPromise(
    resolve(token).pipe(
      Effect.map((config) => Option.getOrNull(Option.map(config, revealApiKey)))
    )
  );

/** The tag a resolver fails with, or null when it answers. */
const failureTag = (resolve: TokenResolver, token: string) =>
  Effect.runPromise(
    Effect.exit(resolve(token)).pipe(
      Effect.map((exit) =>
        Exit.isFailure(exit)
          ? (Option.getOrNull(Exit.findErrorOption(exit))?._tag ?? null)
          : null
      )
    )
  );

describe("oauthResolver", () => {
  const settings = settingsFor({
    LUCA_API_BASE_URL: "https://api.example.com",
  });

  it("resolves a token via POST /oauth/resolve", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ apiKey: "luca_abc", scopes: ["luca:read"] })
    );

    const resolve = oauthResolver(settings, fetchMock as typeof fetch);
    const config = await run(resolve, "some.jwt.token");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/oauth/resolve",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer some.jwt.token",
        }),
      })
    );
    expect(config).toEqual({
      apiBaseUrl: "https://api.example.com",
      apiKey: "luca_abc",
      authHeader: "x-api-key",
    });
  });

  it("gives the vended key the same auth header and timeout as the settings", async () => {
    const resolve = oauthResolver(
      settingsFor({
        LUCA_API_BASE_URL: "https://api.example.com",
        LUCA_AUTH_HEADER: "bearer",
        LUCA_REQUEST_TIMEOUT_MS: "5000",
      }),
      (async () => Response.json({ apiKey: "luca_abc" })) as typeof fetch
    );

    expect(await run(resolve, "some.jwt.token")).toEqual({
      apiBaseUrl: "https://api.example.com",
      apiKey: "luca_abc",
      authHeader: "authorization",
      requestTimeoutMs: 5000,
    });
  });

  it("passes an AbortSignal to the OAuth resolve request and closes it afterward", async () => {
    let requestSignal: AbortSignal | undefined;

    const fetchMock = vi.fn<typeof fetch>((_url, init) => {
      requestSignal = init?.signal as AbortSignal | undefined;

      return Promise.resolve(
        Response.json({ error: "unauthorized" }, { status: 401 })
      );
    });

    const resolve = oauthResolver(settings, fetchMock);

    expect(await run(resolve, "some.jwt.token")).toBeNull();
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    expect(requestSignal?.aborted).toBe(true);
  });

  it.each([
    "bad",
    "luca_ort_refresh",
    "a.b",
    "a.b.c.d",
    "a..c",
    "a.b.c d",
    "a.b.c=",
  ])("refuses %s as not JWT-shaped, with no API call", async (token) => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ apiKey: "luca_abc" })
    );

    const resolve = oauthResolver(settings, fetchMock);

    expect(await run(resolve, token)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null on 401", async () => {
    const resolve = oauthResolver(settings, (async () =>
      Response.json(
        { error: "unauthorized" },
        { status: 401 }
      )) as typeof fetch);

    expect(await run(resolve, "bad.jwt.token")).toBeNull();
  });

  it("fails as unavailable on network failure, so the client retries", async () => {
    const resolve = oauthResolver(settings, (() =>
      // oxlint-disable-next-line effect/avoid-untagged-errors -- fetch rejects with a plain Error, and this stub reproduces it
      Promise.reject(new Error("boom"))) as typeof fetch);

    expect(await failureTag(resolve, "some.jwt.token")).toBe(
      "TokenVerificationUnavailable"
    );
  });

  it.each([429, 500, 503])(
    "fails as unavailable when the API answers %i",
    async (status) => {
      const resolve = oauthResolver(settings, (async () =>
        Response.json({ error: "down" }, { status })) as typeof fetch);

      expect(await failureTag(resolve, "some.jwt.token")).toBe(
        "TokenVerificationUnavailable"
      );
    }
  );

  it("fails as unavailable when a 2xx body is not JSON", async () => {
    const resolve = oauthResolver(
      settings,
      (async () => new Response("<html>", { status: 200 })) as typeof fetch
    );

    expect(await failureTag(resolve, "some.jwt.token")).toBe(
      "TokenVerificationUnavailable"
    );
  });

  it.each([
    { name: "a numeric key", apiKey: 42 },
    { name: "an empty key", apiKey: "" },
  ])("fails as unavailable when a 2xx body has $name", async ({ apiKey }) => {
    const resolve = oauthResolver(settings, (async () =>
      Response.json({ apiKey })) as typeof fetch);

    expect(await failureTag(resolve, "some.jwt.token")).toBe(
      "TokenVerificationUnavailable"
    );
  });

  it.each([400, 403, 404])(
    "fails as unavailable on %i, which says nothing about the token",
    async (status) => {
      // Only a 401 is a verdict on the token. Reading a misrouted 404 or an
      // edge 403 as one would send every connected client back to sign-in.
      const resolve = oauthResolver(settings, (async () =>
        Response.json({ error: "nope" }, { status })) as typeof fetch);

      expect(await failureTag(resolve, "some.jwt.token")).toBe(
        "TokenVerificationUnavailable"
      );
    }
  );

  it("refuses redirects so the bearer token stays on the named host", async () => {
    const fetchMock = vi.fn(async () => Response.json({ apiKey: "luca_abc" }));
    const resolve = oauthResolver(settings, fetchMock as typeof fetch);

    await run(resolve, "some.jwt.token");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ redirect: "error" })
    );
  });

  it("returns null when the response has no apiKey", async () => {
    const resolve = oauthResolver(settings, (async () =>
      Response.json({ scopes: [] })) as typeof fetch);

    expect(await run(resolve, "some.jwt.token")).toBeNull();
  });

  it("collapses multiple trailing slashes off the configured base URL", async () => {
    const fetchMock = vi.fn(async () => Response.json({ apiKey: "luca_abc" }));

    const resolve = oauthResolver(
      settingsFor({ LUCA_API_BASE_URL: "https://api.example.com///" }),
      fetchMock as typeof fetch
    );

    await run(resolve, "some.jwt.token");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/oauth/resolve",
      expect.anything()
    );
  });

  it("defaults the base URL when LUCA_API_BASE_URL is unset", async () => {
    const fetchMock = vi.fn(async () => Response.json({ apiKey: "luca_abc" }));

    const resolve = oauthResolver(settingsFor({}), fetchMock as typeof fetch);
    await run(resolve, "some.jwt.token");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.setluca.com/oauth/resolve",
      expect.anything()
    );
  });

  it("returns null for a non-ok response even when the body has an apiKey", async () => {
    const resolve = oauthResolver(settings, (async () =>
      Response.json(
        { apiKey: "luca_x", scopes: ["luca:read"] },
        { status: 401 }
      )) as typeof fetch);

    expect(await run(resolve, "bad.jwt.token")).toBeNull();
  });
});

describe("oauthResolver request bound", () => {
  const hangingFetch = () =>
    vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));

  /**
   * Runs the resolver against the test clock: whether it had settled 100 ms
   * before `boundMs`, and the tag it failed with once the clock passed it.
   */
  const boundedAt = (resolve: TokenResolver, boundMs: number) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.exit(resolve("some.jwt.token"))
        );

        yield* TestClock.adjust(Duration.millis(boundMs - 100));
        const early = fiber.pollUnsafe();
        yield* TestClock.adjust(Duration.millis(200));
        const exit = yield* Fiber.join(fiber);

        return {
          settledEarly: early !== undefined,
          tag: Exit.isFailure(exit)
            ? Option.getOrNull(Exit.findErrorOption(exit))?._tag
            : "answered",
        };
      }).pipe(Effect.provide(TestClock.layer()))
    );

  it("abandons a hung resolve at the timeout the env names", async () => {
    let requestSignal: AbortSignal | undefined;

    const fetchMock = vi.fn<typeof fetch>((_url, init) => {
      requestSignal = init?.signal as AbortSignal | undefined;

      return new Promise<Response>(() => undefined);
    });

    const resolve = oauthResolver(
      settingsFor({
        LUCA_API_BASE_URL: "https://api.example.com",
        LUCA_REQUEST_TIMEOUT_MS: "1000",
      }),
      fetchMock
    );

    expect(await boundedAt(resolve, 1000)).toEqual({
      settledEarly: false,
      tag: "TokenVerificationUnavailable",
    });
    expect(requestSignal?.aborted).toBe(true);
  });

  it("falls back to the 5s resolve bound when the env names no timeout", async () => {
    // The resolver sits on the auth path of every request, so an unbounded one
    // would hang the whole call rather than fail it. A missing env var has to
    // land on the resolve bound, not on no bound at all.
    const resolve = oauthResolver(
      settingsFor({ LUCA_API_BASE_URL: "https://api.example.com" }),
      hangingFetch()
    );

    expect(await boundedAt(resolve, 5000)).toEqual({
      settledEarly: false,
      tag: "TokenVerificationUnavailable",
    });
  });

  it("caps a longer configured timeout at the 5s resolve bound", async () => {
    const resolve = oauthResolver(
      settingsFor({
        LUCA_API_BASE_URL: "https://api.example.com",
        LUCA_REQUEST_TIMEOUT_MS: "30000",
      }),
      hangingFetch()
    );

    expect(await boundedAt(resolve, 5000)).toEqual({
      settledEarly: false,
      tag: "TokenVerificationUnavailable",
    });
  });

  it("falls back to the same bound when the env names a nonsense timeout", async () => {
    const resolve = oauthResolver(
      settingsFor({
        LUCA_API_BASE_URL: "https://api.example.com",
        LUCA_REQUEST_TIMEOUT_MS: "soon",
      }),
      hangingFetch()
    );

    expect(await boundedAt(resolve, 5000)).toEqual({
      settledEarly: false,
      tag: "TokenVerificationUnavailable",
    });
  });
});
