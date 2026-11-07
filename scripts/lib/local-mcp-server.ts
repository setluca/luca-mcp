/**
 * The real remote handler on a local port, with Luca's API stubbed, for checks that
 * talk to the server over HTTP without a Luca account.
 *
 * The MCP conformance suite cannot send a token, so every request is given one. It
 * runs without rate limits, because the suite's requests would all share that token
 * and pass the hosted 60 a minute, which fails scenarios for the wrong reason.
 */
// oxlint-disable-next-line effect/use-http-client-service -- this is a server, and the rule is about making requests
import { createServer, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";

import * as Effect from "effect/Effect";
import * as P from "effect/Predicate";
import * as Redacted from "effect/Redacted";

import { createRemoteHandler } from "../../src/remote.ts";

/** Sent with every request. The stubbed API never checks it. */
export const LOCAL_TOKEN = "luca_local_protocol_check";

const allow = () => Effect.succeed(true);

const handler = createRemoteHandler({
  resolveToken: () =>
    Effect.succeedSome({
      apiBaseUrl: "http://localhost",
      authHeader: "x-api-key" as const,
      apiKey: Redacted.make(LOCAL_TOKEN),
    }),
  apiFetch: async () => Response.json({ items: [] }),
  publicHostname: "localhost",
  rateLimits: {
    perToken: allow,
    perTokenAddress: allow,
    perAnonymousAddress: allow,
  },
});

async function toRequest(incoming: IncomingMessage): Promise<Request> {
  const headers = new Headers();

  for (const [name, value] of Object.entries(incoming.headers)) {
    if (P.isString(value)) {
      headers.set(name, value);
    }
  }

  headers.set("authorization", `Bearer ${LOCAL_TOKEN}`);

  const method = incoming.method ?? "GET";

  return new Request(`http://${incoming.headers.host}${incoming.url}`, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? null : await buffer(incoming),
  });
}

export type LocalMcpServer = {
  readonly url: string;
  readonly close: () => Promise<void>;
};

export function startLocalMcpServer(port: number): Promise<LocalMcpServer> {
  const server = createServer(async (incoming, outgoing) => {
    const response = await handler(await toRequest(incoming));

    outgoing.writeHead(response.status, Object.fromEntries(response.headers));

    if (response.body === null) {
      outgoing.end();
    } else {
      Readable.fromWeb(response.body).pipe(outgoing);
    }
  });

  const close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });

  return new Promise((resolve) => {
    server.listen(port, () => {
      resolve({ url: `http://localhost:${port}/mcp`, close });
    });
  });
}
