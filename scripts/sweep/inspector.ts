import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { JsonValue } from "../../src/serialization.ts";

/** The requests that list what a server exposes. None takes an argument. */
export type ListingMethod =
  | "initialize"
  | "tools/list"
  | "resources/list"
  | "resources/templates/list"
  | "prompts/list";

/**
 * One request sent through the MCP Inspector CLI. Each runs as its own
 * `mcp-inspector --cli` process, so a verdict is the CLI's exit code and nothing
 * in this script speaks MCP itself.
 */
export type InspectorRequest =
  | {
      readonly method: "tools/call";
      readonly name: string;
      readonly args: JsonValue;
    }
  | { readonly method: "resources/read"; readonly uri: string }
  | { readonly method: "prompts/get"; readonly name: string }
  | { readonly method: ListingMethod };

/**
 * How a call signs in. `refresh` runs the stored refresh token first, which
 * proves the sign-in outlives its first access token; `stored` reuses the
 * stored access token and never opens a browser.
 */
export type InspectorAuth = "refresh" | "stored";

/**
 * Which server a call reaches. `oauth` uses the sign-in the web Inspector
 * stored. `bearer` sends a developer key to the hosted server, for CI, where a
 * refresh token that rotates on every use cannot be shared. `stdio` starts this
 * checkout's build, so a release can be checked before it ships.
 */
export type InspectorConnection =
  | {
      readonly kind: "oauth";
      readonly serverUrl: string;
      readonly auth: InspectorAuth;
    }
  | {
      readonly kind: "bearer";
      readonly serverUrl: string;
      readonly token: string;
    }
  | {
      readonly kind: "stdio";
      readonly env: Readonly<Record<string, string>>;
    };

/** The MCP revisions the server has to answer the same way in. */
export type ProtocolEra = "legacy" | "modern";

/** The CLI's one-line error envelope, written to stderr on a non-zero exit. */
const ErrorEnvelope = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    retryAfterMs: Schema.optional(Schema.Finite),
  }),
});

type ErrorEnvelope = typeof ErrorEnvelope.Type;

/** The text items of a tool result, the part an expected refusal is matched on. */
const ToolResultText = Schema.Struct({
  result: Schema.Struct({
    content: Schema.Array(
      Schema.Struct({ text: Schema.optional(Schema.String) })
    ),
  }),
});

export type InspectorOutcome = {
  readonly exitCode: number;
  readonly durationMs: number;
  /** The CLI's `--format json` output: `{ result }` for a request that answered. */
  readonly output: JsonValue | undefined;
  readonly error: ErrorEnvelope["error"] | undefined;
  /** The tool's text content, or the error message, for matching an expected refusal. */
  readonly text: string;
};

/**
 * The CLI's exit codes, from the Inspector's CLI docs. A tool that answers
 * `isError: true` exits 5 but still prints its result.
 */
export const INSPECTOR_EXIT = {
  ok: 0,
  authRequired: 3,
  unreachable: 4,
  toolError: 5,
  rateLimited: 11,
} as const;

/**
 * The hosted server allows a token 60 requests a minute, and each call costs 3
 * or 4 because the CLI connects anew every time. So a long run reaches the limit
 * as a matter of course, and waiting it out is not a failure.
 */
const RATE_LIMIT_ATTEMPTS = 5;

/** The wait when a 429 names none: the whole of the server's window. */
const RATE_LIMIT_WAIT_MS = 60_000;

const INSPECTOR_BIN = new URL(
  "../../node_modules/.bin/mcp-inspector",
  import.meta.url
).pathname;

const BUILT_SERVER = resolve(import.meta.dirname, "../../dist/index.js");

/** No call the sweep makes should take longer; a slower one is a failure too. */
export const CALL_LIMIT_MS = 30_000;

/** Kills a hung process a little after the limit so the report can still say so. */
const KILL_AFTER_MS = CALL_LIMIT_MS + 15_000;

const decodeOutput = Schema.decodeUnknownOption(
  Schema.fromJsonString(JsonValue)
);

const decodeErrorEnvelope = Schema.decodeUnknownOption(
  Schema.fromJsonString(ErrorEnvelope)
);

const decodeToolResultText = Schema.decodeUnknownOption(
  Schema.fromJsonString(ToolResultText)
);

function methodArgs(request: InspectorRequest): readonly string[] {
  return Match.value(request).pipe(
    Match.discriminators("method")({
      "tools/call": (call) => [
        "--tool-name",
        call.name,
        "--tool-args-json",
        JSON.stringify(call.args),
      ],
      "resources/read": (read) => ["--uri", read.uri],
      "prompts/get": (prompt) => ["--prompt-name", prompt.name],
    }),
    Match.orElse(() => [])
  );
}

/** The CLI arguments that pick the server and how to sign in to it. */
function connectionArgs(connection: InspectorConnection): readonly string[] {
  return Match.value(connection).pipe(
    Match.discriminatorsExhaustive("kind")({
      oauth: ({ serverUrl, auth }) => [
        "--server-url",
        serverUrl,
        "--transport",
        "http",
        auth === "refresh" ? "--use-stored-auth" : "--stored-auth-only",
      ],
      bearer: ({ serverUrl, token }) => [
        "--server-url",
        serverUrl,
        "--transport",
        "http",
        "--header",
        `Authorization: Bearer ${token}`,
      ],
      stdio: () => ["bun", BUILT_SERVER],
    })
  );
}

/** The CLI arguments for one request. The target has to come right after --cli. */
function inspectorArgs(
  connection: InspectorConnection,
  request: InspectorRequest,
  era: ProtocolEra | undefined
): readonly string[] {
  return [
    "--cli",
    ...connectionArgs(connection),
    ...(era === undefined ? [] : ["--protocol-era", era]),
    "--format",
    "json",
    "--method",
    request.method,
    ...methodArgs(request),
  ];
}

/** The last stderr line that is the CLI's error envelope. */
function errorEnvelope(stderr: string): InspectorOutcome["error"] {
  const lines = Arr.reverse(stderr.trim().split("\n"));

  return Option.getOrUndefined(
    Arr.findFirst(lines, (line) =>
      Option.map(decodeErrorEnvelope(line), (envelope) => envelope.error)
    )
  );
}

/** The text items of a tool result, joined, or "" when there are none. */
function contentText(stdout: string): string {
  return Option.match(decodeToolResultText(stdout), {
    onNone: () => "",
    onSome: (decoded) =>
      decoded.result.content
        .flatMap((item) => (item.text === undefined ? [] : [item.text]))
        .join("\n"),
  });
}

/**
 * Runs one request and reports how it ended, waiting out a rate limit first.
 * Never rejects.
 */
export async function runInspector(
  connection: InspectorConnection,
  request: InspectorRequest,
  era?: ProtocolEra
): Promise<InspectorOutcome> {
  let outcome = await runOnce(connection, request, era);

  for (
    let attempt = 1;
    attempt < RATE_LIMIT_ATTEMPTS &&
    outcome.exitCode === INSPECTOR_EXIT.rateLimited;
    attempt++
  ) {
    const wait = outcome.error?.retryAfterMs ?? RATE_LIMIT_WAIT_MS;

    await new Promise((resolve) => {
      setTimeout(resolve, wait);
    });

    outcome = await runOnce(connection, request, era);
  }

  return outcome;
}

function runOnce(
  connection: InspectorConnection,
  request: InspectorRequest,
  era: ProtocolEra | undefined
): Promise<InspectorOutcome> {
  const started = performance.now();

  return new Promise((resolve) => {
    // stdin is closed so a step-up prompt is declined at once instead of
    // waiting on a terminal nobody is watching.
    // fallow-ignore-next-line security-sink -- the command is this repo's own Inspector binary, run without a shell, and its arguments come from the sweep plan and the operator's own command-line flags
    const child = spawn(
      INSPECTOR_BIN,
      [...inspectorArgs(connection, request, era)],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ...(connection.kind === "stdio" ? connection.env : undefined),
        },
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => child.kill("SIGKILL"), KILL_AFTER_MS);

    child.on("close", (code) => {
      clearTimeout(timer);

      const error = errorEnvelope(stderr);

      resolve({
        exitCode: code ?? 1,
        durationMs: Math.round(performance.now() - started),
        output: Option.getOrUndefined(decodeOutput(stdout)),
        error,
        text: contentText(stdout) || error?.message || stderr.trim(),
      });
    });
  });
}
