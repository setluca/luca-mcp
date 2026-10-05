#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { setEventSink, stderrEventSink } from "./observability.ts";
import { createLucaServer, parseToolset } from "./server.ts";

// stdout carries the protocol, so event lines go to stderr.
setEventSink(stderrEventSink);

/**
 * `serveStdio` owns the era decision for the connection: the opening exchange
 * picks either the 2026-07-28 protocol or the 2025 `initialize` handshake, and
 * one instance from this factory is pinned for the connection's lifetime. The
 * factory registers the same surface either way, so a client on either
 * revision sees an identical toolset.
 */
serveStdio(
  () => createLucaServer({ toolset: parseToolset(process.env.LUCA_TOOLSET) }),
  {
    // stdout carries the protocol, so every diagnostic goes to stderr. These
    // are out-of-band errors: reporting them never changes what the client
    // receives, and the connection stays up.
    onerror: (error) => {
      stderrEventSink(`Luca MCP server error: ${error.stack ?? error.message}`);
    },
  }
);
