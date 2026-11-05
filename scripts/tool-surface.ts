import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";

import {
  isJsonArray,
  isJsonObject,
  type JsonObject,
  JsonValue,
} from "../src/serialization.ts";
import { isEntryPoint } from "./lib/script.ts";
import {
  INSPECTOR_EXIT,
  type InspectorConnection,
  type ListingMethod,
  type ProtocolEra,
  runInspector,
} from "./sweep/inspector.ts";

/**
 * What the server tells a client, as the MCP Inspector CLI reads it, written to
 * `tool-surface.json`. A change to a hint, a title, a description, or a schema
 * then shows up in the pull request that makes it, and a server that lists
 * something else than its release fails the check against that file.
 *
 * Hints and text are kept whole so a reviewer can read them. Schemas are hashed:
 * the generated schema files already show what changed, and this file only has
 * to prove that the server still serves them.
 */
const SURFACE_PATH = new URL("../tool-surface.json", import.meta.url).pathname;

const HOSTED_SERVER = "https://mcp.setluca.com/mcp";

const LIVE_KEY_VARIABLE = "LUCA_MCP_LIVE_KEY";

const ERAS: readonly ProtocolEra[] = ["legacy", "modern"];

/**
 * One pass over both eras costs about 34 requests, because the CLI connects anew
 * for each call, and the server allows a token 60 a minute. A minute between
 * passes keeps every pass inside that budget.
 */
const LIVE_ATTEMPTS = 3;

const LIVE_RETRY_MS = 60_000;

/** Longest value a drift line prints before cutting it short. */
const DRIFT_VALUE_LIMIT = 160;

/**
 * This checkout's build, serving every tool. A shell with `LUCA_TOOLSET` set
 * would otherwise list a smaller set than a client of the hosted server sees.
 */
const LOCAL_BUILD: InspectorConnection = {
  kind: "stdio",
  env: { LUCA_TOOLSET: "full" },
};

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(JsonValue));

/** One `--method` answer per surface the server exposes. */
export type SurfaceListings = {
  readonly initialize: JsonValue | undefined;
  readonly tools: JsonValue | undefined;
  readonly prompts: JsonValue | undefined;
  readonly resources: JsonValue | undefined;
  readonly resourceTemplates: JsonValue | undefined;
};

function canonical(value: JsonValue | undefined): JsonValue {
  if (isJsonArray(value)) {
    return value.map(canonical);
  }

  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, canonical(value[key])])
    );
  }

  return value ?? null;
}

function digest(value: JsonValue | undefined): string | null {
  return value === undefined
    ? null
    : createHash("sha256")
        .update(JSON.stringify(canonical(value)))
        .digest("hex")
        .slice(0, 16);
}

function asText(value: JsonValue | undefined): string {
  return P.isString(value) ? value : "";
}

/** The items at `key`, keyed by `name`, in a stable order. */
function byName(
  listing: JsonValue | undefined,
  key: string,
  name: string,
  entry: (item: JsonObject) => JsonValue = canonical
): JsonObject {
  const items = isJsonObject(listing) ? listing[key] : undefined;

  return Object.fromEntries(
    (isJsonArray(items) ? items : [])
      .filter(isJsonObject)
      .map((item) => [asText(item[name]), entry(item)] as const)
      .toSorted(([left], [right]) => left.localeCompare(right))
  );
}

function toolEntry(tool: JsonObject): JsonValue {
  const annotations = isJsonObject(tool.annotations) ? tool.annotations : {};

  return {
    title: annotations.title ?? tool.title ?? null,
    description: tool.description ?? null,
    readOnlyHint: annotations.readOnlyHint ?? null,
    destructiveHint: annotations.destructiveHint ?? null,
    idempotentHint: annotations.idempotentHint ?? null,
    openWorldHint: annotations.openWorldHint ?? null,
    inputSchema: digest(tool.inputSchema),
    outputSchema: digest(tool.outputSchema),
    meta: digest(tool._meta),
  };
}

/** The file's contents for a set of listings. `protocolVersion` varies by era. */
export function surfaceFromListings(listings: SurfaceListings): JsonObject {
  const initialize = isJsonObject(listings.initialize)
    ? listings.initialize
    : {};

  return {
    server: canonical({
      serverInfo: initialize.serverInfo ?? null,
      capabilities: initialize.capabilities ?? null,
      instructions: initialize.instructions ?? null,
    }),
    tools: byName(listings.tools, "tools", "name", toolEntry),
    prompts: byName(listings.prompts, "prompts", "name"),
    resources: byName(listings.resources, "resources", "uri"),
    resourceTemplates: byName(
      listings.resourceTemplates,
      "resourceTemplates",
      "uriTemplate"
    ),
  };
}

function flatten(
  value: JsonValue,
  path: string,
  into: Map<string, string>
): void {
  if (isJsonObject(value)) {
    for (const key of Object.keys(value)) {
      flatten(value[key] ?? null, `${path}${path ? " > " : ""}${key}`, into);
    }

    return;
  }

  into.set(path, JSON.stringify(canonical(value)));
}

function shorten(text: string): string {
  return text.length > DRIFT_VALUE_LIMIT
    ? `${text.slice(0, DRIFT_VALUE_LIMIT)}...`
    : text;
}

/** One line per value that differs. Empty means the two surfaces match. */
export function surfaceDrift(
  expected: JsonValue,
  actual: JsonValue
): readonly string[] {
  const want = new Map<string, string>();
  const got = new Map<string, string>();

  flatten(expected, "", want);
  flatten(actual, "", got);

  return [...new Set([...want.keys(), ...got.keys()])]
    .toSorted()
    .flatMap((path) => {
      const wanted = want.get(path);
      const found = got.get(path);

      if (wanted === found) {
        return [];
      }

      if (wanted === undefined) {
        return [`${path}: not expected, server has ${shorten(found ?? "")}`];
      }

      return [
        found === undefined
          ? `${path}: expected ${shorten(wanted)}, server has none`
          : `${path}: expected ${shorten(wanted)}, server has ${shorten(found)}`,
      ];
    });
}

async function listed(
  connection: InspectorConnection,
  method: ListingMethod,
  era: ProtocolEra
): Promise<JsonValue | undefined> {
  const outcome = await runInspector(connection, { method }, era);

  if (outcome.exitCode !== INSPECTOR_EXIT.ok) {
    throw new Error(
      `${method} (${era}) exited ${outcome.exitCode}: ${outcome.error?.message ?? outcome.text}`
    );
  }

  return isJsonObject(outcome.output) ? outcome.output.result : undefined;
}

async function readSurface(
  connection: InspectorConnection,
  era: ProtocolEra
): Promise<JsonObject> {
  return surfaceFromListings({
    initialize: await listed(connection, "initialize", era),
    tools: await listed(connection, "tools/list", era),
    prompts: await listed(connection, "prompts/list", era),
    resources: await listed(connection, "resources/list", era),
    resourceTemplates: await listed(
      connection,
      "resources/templates/list",
      era
    ),
  });
}

/** Every line where a protocol era's answer differs from `expected`. */
async function driftAcrossEras(
  connection: InspectorConnection,
  expected: JsonValue
): Promise<readonly string[]> {
  const lines: string[] = [];

  for (const era of ERAS) {
    const actual = await readSurface(connection, era);

    lines.push(
      ...surfaceDrift(expected, actual).map((line) => `[${era}] ${line}`)
    );
  }

  return lines;
}

function report(drift: readonly string[], source: string): number {
  if (drift.length === 0) {
    console.log(`${source} matches, in both protocol eras.`);

    return 0;
  }

  console.error(`${source} has drifted, ${drift.length} difference(s):`);

  for (const line of drift) {
    console.error(`  ${line}`);
  }

  return 1;
}

async function write(): Promise<number> {
  const [first, ...rest] = ERAS;
  const surface = await readSurface(LOCAL_BUILD, first ?? "legacy");

  // The file is what both eras have to serve, so they have to agree first.
  const disagreement = await Promise.all(
    rest.map(async (era) =>
      surfaceDrift(surface, await readSurface(LOCAL_BUILD, era)).map(
        (line) => `[${era}] ${line}`
      )
    )
  );

  if (disagreement.flat().length > 0) {
    return report(disagreement.flat(), "The modern protocol era");
  }

  writeFileSync(SURFACE_PATH, `${JSON.stringify(surface, null, 2)}\n`);
  console.log(`Wrote ${SURFACE_PATH}`);

  return 0;
}

function readExpected(path: string): JsonValue {
  return decodeJson(readFileSync(path, "utf-8"));
}

async function check(): Promise<number> {
  const code = report(
    await driftAcrossEras(LOCAL_BUILD, readExpected(SURFACE_PATH)),
    "The build"
  );

  if (code !== 0) {
    console.error(
      "If this change is intended, run: bun run build && bun run surface:generate"
    );
  }

  return code;
}

/** The deploy can take a moment to reach every edge, so a miss is tried again. */
async function live(input: {
  readonly serverUrl: string;
  readonly expectedPath: string;
  readonly allowMissingKey: boolean;
}): Promise<number> {
  const token = process.env[LIVE_KEY_VARIABLE];

  if (token === undefined || token === "") {
    const message = `${LIVE_KEY_VARIABLE} is not set, so the live check did not run. See scripts/setup-drift-checks.sh.`;

    if (input.allowMissingKey) {
      console.log(`::warning::${message}`);

      return 0;
    }

    console.error(message);

    return 1;
  }

  const expected = readExpected(input.expectedPath);

  const connection: InspectorConnection = {
    kind: "bearer",
    serverUrl: input.serverUrl,
    token,
  };

  for (let attempt = 1; attempt < LIVE_ATTEMPTS; attempt++) {
    try {
      const drift = await driftAcrossEras(connection, expected);

      if (drift.length === 0) {
        return report(drift, input.serverUrl);
      }

      console.log(
        `Live check ${attempt}/${LIVE_ATTEMPTS} found ${drift.length} difference(s)`
      );
    } catch (error) {
      console.log(`Live check ${attempt}/${LIVE_ATTEMPTS}: ${String(error)}`);
    }

    await new Promise((resolve) => {
      setTimeout(resolve, LIVE_RETRY_MS);
    });
  }

  return report(await driftAcrossEras(connection, expected), input.serverUrl);
}

async function main(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      write: { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      live: { type: "boolean", default: false },
      expected: { type: "string", default: SURFACE_PATH },
      "server-url": { type: "string", default: HOSTED_SERVER },
      "allow-missing-key": { type: "boolean", default: false },
    },
  });

  if (values.write) {
    return write();
  }

  if (values.check) {
    return check();
  }

  if (values.live) {
    return live({
      serverUrl: values["server-url"],
      expectedPath: values.expected,
      allowMissingKey: values["allow-missing-key"],
    });
  }

  console.error(
    "Usage: bun scripts/tool-surface.ts --write | --check | --live [--expected <file>] [--server-url <url>] [--allow-missing-key]"
  );

  return 2;
}

if (isEntryPoint(import.meta.filename)) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    console.error(String(error));
    process.exit(1);
  }
}
