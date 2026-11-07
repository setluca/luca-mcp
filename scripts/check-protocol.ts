/**
 * Checks the HTTP transport as a client sees it, against the real handler. Inspector
 * reads every listing and compares it with `tool-surface.json`, which `surface:check`
 * only does over stdio. Then the official MCP conformance suite runs, and fails on
 * anything outside `conformance-baseline.yml`.
 */
import { spawn } from "node:child_process";

import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { parseJson } from "../src/serialization.ts";
import { packagePath } from "./lib/generated-file.ts";
import { LOCAL_TOKEN, startLocalMcpServer } from "./lib/local-mcp-server.ts";
import { exitWith, runScript } from "./lib/script.ts";
import { driftAcrossEras } from "./lib/tool-surface.ts";

const PORT = 8797;

function runConformance(url: string): Promise<number> {
  return new Promise((resolve) => {
    // fallow-ignore-next-line security-sink -- the command is fixed and the url is local
    const suite = spawn(
      "bunx",
      [
        "conformance",
        "server",
        "--url",
        url,
        "--expected-failures",
        "conformance-baseline.yml",
        "--output-dir",
        "conformance-results",
      ],
      { stdio: "inherit" }
    );

    suite.on("close", (code) => resolve(code ?? 1));
  });
}

const program = Effect.fn("check-protocol")(function* () {
  const fs = yield* FileSystem.FileSystem;

  const expected = yield* parseJson(
    yield* fs.readFileString(yield* packagePath("tool-surface.json"))
  );

  const server = yield* Effect.acquireRelease(
    Effect.tryPromise(() => startLocalMcpServer(PORT)),
    (running) => Effect.ignore(Effect.tryPromise(() => running.close()))
  );

  const drift = yield* driftAcrossEras(
    { kind: "bearer", serverUrl: server.url, token: LOCAL_TOKEN },
    expected
  );

  if (drift.length > 0) {
    return yield* exitWith([
      `Over HTTP, the server differs from tool-surface.json in ${drift.length} place(s):`,
      ...drift.map((line) => `  ${line}`),
    ]);
  }

  yield* Console.log(
    "Over HTTP, the server matches tool-surface.json, in both protocol eras."
  );

  const code = yield* Effect.tryPromise(() => runConformance(server.url));

  if (code !== 0) {
    return yield* exitWith(
      ["The conformance suite found a new failure."],
      code
    );
  }
}, Effect.scoped);

runScript(program());
