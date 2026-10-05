import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import type { LucaError } from "../src/errors.ts";
import {
  type LucaApi,
  LucaApi as LucaApiTag,
  type LucaRequest,
} from "../src/http.ts";
import { JsonValue, type JsonValueInput } from "../src/serialization.ts";
import {
  type CreateLucaServerOptions,
  createLucaServer,
} from "../src/server.ts";

/**
 * The in-memory API a server test runs against. A handler answers one request
 * with a plain JSON value or a `LucaError`, so a test states what the Luca API
 * returned and nothing about how it was fetched.
 */
export type TestHandler = (
  request: LucaRequest
) => Effect.Effect<JsonValueInput, LucaError, never>;

const decodeJsonValue = Schema.decodeUnknownOption(JsonValue);

/**
 * A handler's value as the JSON the API client would have decoded, or null
 * when it is not JSON at all.
 */
/**
 * The config with its API key revealed. `toEqual` treats any two `Redacted`
 * values as equal, so a test that compares keys has to unwrap them first.
 */
export function revealApiKey<
  Config extends { apiKey: Redacted.Redacted<string> },
>(config: Config) {
  return { ...config, apiKey: Redacted.value(config.apiKey) };
}

export function toJsonValue(value: JsonValueInput): JsonValue {
  return Option.getOrElse(decodeJsonValue(value), () => null);
}

const decodeJsonRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
);

/** One JSON object parsed from text, such as a logged event line. */
export function parseJsonRecord(
  text: string
): Readonly<Record<string, unknown>> {
  return decodeJsonRecord(text);
}

const encodeJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** `value` as compact JSON, for asserting what a payload does or does not hold. */
export function jsonText(value: unknown): string {
  return encodeJsonText(value);
}

const encodePrettyJsonText = Schema.encodeSync(
  Schema.fromJsonString(Schema.Unknown, { space: 2 })
);

/** `value` as two-space-indented JSON, the layout of a tool's text content. */
export function prettyJsonText(value: unknown): string {
  return encodePrettyJsonText(value);
}

/** A sorted copy of `items`, so two name lists compare regardless of order. */
export function sorted(items: Iterable<string>): string[] {
  return Arr.sort(items, Order.String);
}

export function testLayer(handler: TestHandler) {
  const api: LucaApi = {
    request: (request) => handler(request).pipe(Effect.map(toJsonValue)),
  };

  return Layer.succeed(LucaApiTag, api);
}

/**
 * A client and server joined by an in-memory transport, so a test exercises the
 * real MCP wire shape — tool listings, annotations, structured content — rather
 * than the handler functions behind it.
 */
export async function connect(
  handler: TestHandler,
  options: Omit<CreateLucaServerOptions, "lucaLayer"> = {}
) {
  const server = createLucaServer({
    ...options,
    lucaLayer: testLayer(handler),
  });

  const client = new Client({ name: "luca-mcp-test-client", version: "0.1.0" });

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return {
    client,
    close: () => clientTransport.close(),
  };
}
