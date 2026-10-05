import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { describe, expect, it, onTestFinished } from "vitest";

import {
  LucaConfig,
  LucaConfigLive,
  loadConfig as loadConfigEffect,
  loadRemoteSettings,
} from "../src/config.ts";
import { LucaConfigError } from "../src/errors.ts";
import { jsonText, revealApiKey } from "./helpers.ts";

const loadConfig = (env: NodeJS.ProcessEnv) =>
  revealApiKey(Effect.runSync(loadConfigEffect(env)));

const configFailure = (env: NodeJS.ProcessEnv) =>
  Effect.runSync(Effect.flip(loadConfigEffect(env)));

describe("LucaConfig tag", () => {
  it("exposes its Context.Service key", () => {
    expect(LucaConfig.key).toBe("@luca/mcp/LucaConfig");
  });
});

describe("loadConfig", () => {
  it("loads the required API key and defaults", () => {
    const config = loadConfig({ LUCA_API_KEY: "luca_test" });

    expect(config).toEqual({
      apiBaseUrl: "https://api.setluca.com",
      apiKey: "luca_test",
      authHeader: "x-api-key",
    });
  });

  it("supports bearer auth and workspace overrides", () => {
    const config = loadConfig({
      LUCA_API_TOKEN: "luca_test",
      LUCA_API_BASE_URL: "https://api.example.com/",
      LUCA_AUTH_HEADER: "bearer",
      LUCA_WORKSPACE_ID: "00000000-0000-0000-0000-000000000000",
      LUCA_WORKSPACE_SLUG: "demo",
    });

    expect(config).toEqual({
      apiBaseUrl: "https://api.example.com",
      apiKey: "luca_test",
      authHeader: "authorization",
      workspaceId: "00000000-0000-0000-0000-000000000000",
      workspaceSlug: "demo",
    });
  });

  it("trims values and removes trailing base URL slashes", () => {
    const config = loadConfig({
      LUCA_API_KEY: "  luca_test  ",
      LUCA_API_BASE_URL: "https://api.example.com///",
      LUCA_AUTH_HEADER: " authorization ",
    });

    expect(config).toEqual({
      apiBaseUrl: "https://api.example.com",
      apiKey: "luca_test",
      authHeader: "authorization",
    });
  });

  it("recognizes an explicit x-api-key auth header", () => {
    const config = loadConfig({
      LUCA_API_KEY: "luca_test",
      LUCA_AUTH_HEADER: "x-api-key",
    });

    expect(config.authHeader).toBe("x-api-key");
  });

  it("fails when the API key is missing", () => {
    const failure = configFailure({});

    expect(failure).toBeInstanceOf(LucaConfigError);
    expect(failure.message).toBe(
      "Set LUCA_API_KEY to a Luca developer API key."
    );
  });

  it("fails when the auth header mode is invalid", () => {
    const failure = configFailure({
      LUCA_API_KEY: "luca_test",
      LUCA_AUTH_HEADER: "cookie",
    });

    expect(failure).toBeInstanceOf(LucaConfigError);
    expect(failure.message).toBe(
      "LUCA_AUTH_HEADER must be x-api-key or authorization"
    );
  });
});

describe("loadRemoteSettings", () => {
  it("reads the settings without needing an API key", () => {
    const settings = Effect.runSync(
      loadRemoteSettings({
        LUCA_API_BASE_URL: "https://api.example.com//",
        LUCA_AUTH_HEADER: "bearer",
        LUCA_REQUEST_TIMEOUT_MS: "5000",
      })
    );

    expect(settings).toEqual({
      apiBaseUrl: "https://api.example.com",
      authHeader: "authorization",
      requestTimeoutMs: 5000,
    });
  });

  it("fails on an unknown auth header", () => {
    const failure = Effect.runSync(
      Effect.flip(loadRemoteSettings({ LUCA_AUTH_HEADER: "cookie" }))
    );

    expect(failure).toBeInstanceOf(LucaConfigError);
  });
});

describe("the API key", () => {
  it("never prints when the config is logged", () => {
    const config = Effect.runSync(
      loadConfigEffect({ LUCA_API_KEY: "luca_secret_value" })
    );

    expect(String(config.apiKey)).not.toContain("luca_secret_value");
    expect(jsonText(config)).not.toContain("luca_secret_value");
  });

  it("treats a blank LUCA_API_KEY as unset and falls back to LUCA_API_TOKEN", () => {
    expect(
      loadConfig({ LUCA_API_KEY: "   ", LUCA_API_TOKEN: "luca_legacy" }).apiKey
    ).toBe("luca_legacy");
  });
});

describe("parseTimeoutMs", () => {
  it("reads a positive whole number of milliseconds", () => {
    const config = loadConfig({
      LUCA_API_KEY: "luca_test",
      LUCA_REQUEST_TIMEOUT_MS: " 5000 ",
    });

    expect(config.requestTimeoutMs).toBe(5000);
  });

  it("leaves the default in place for anything it cannot read", () => {
    // A typo degrades to the client's own default rather than to no timeout.
    Arr.forEach(["", "abc", "0", "-1", "1.5"], (value) => {
      const config = loadConfig({
        LUCA_API_KEY: "luca_test",
        LUCA_REQUEST_TIMEOUT_MS: value,
      });

      expect(config.requestTimeoutMs).toBeUndefined();
    });
  });
});

describe("LucaConfigLive", () => {
  it("fails with the LucaConfigError loadConfig reports", async () => {
    const originalEnv = process.env;
    process.env = { ...originalEnv };
    delete process.env.LUCA_API_KEY;
    delete process.env.LUCA_API_TOKEN;

    onTestFinished(() => {
      process.env = originalEnv;
    });

    const failure = await Effect.runPromise(
      Effect.flip(Effect.provide(LucaConfig, LucaConfigLive))
    );

    expect(failure).toBeInstanceOf(LucaConfigError);
    expect(failure.message).toBe(
      "Set LUCA_API_KEY to a Luca developer API key."
    );
  });
});
