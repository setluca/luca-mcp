import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { loadRemoteSettings } from "../src/config.ts";
import type { TokenResolver } from "../src/remote.ts";

export const MCP_URL = new URL("http://mcp.test/mcp");

export const VALID_API_KEY = `luca_${"a".repeat(64)}`;

export const DEFAULT_SETTINGS = Effect.runSync(loadRemoteSettings({}));

/** An API that vouches for every key, so handler tests never leave the process. */
export const acceptingFetch = (async () =>
  Response.json({ capabilities: [] })) as typeof fetch;

export const declines: TokenResolver = () => Effect.succeed(Option.none());
