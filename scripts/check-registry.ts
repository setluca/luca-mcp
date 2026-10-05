import * as Arr from "effect/Array";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HashSet from "effect/HashSet";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { LUCA_OPERATIONS } from "../src/operations.ts";
import { LUCA_TASK_TOOLS } from "../src/task-tools.ts";
import { LUCA_MCP_VERSION } from "../src/version.ts";
import { packagePath } from "./lib/generated-file.ts";
import { exitWith, isEntryPoint, runScript } from "./lib/script.ts";

const EnvironmentVariable = Schema.Struct({
  name: Schema.String,
});

const PackageEntry = Schema.Struct({
  version: Schema.optionalKey(Schema.String),
  identifier: Schema.optionalKey(Schema.String),
  environmentVariables: Schema.optionalKey(Schema.Array(EnvironmentVariable)),
});

const RemoteEntry = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
});

const ServerJson = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  packages: Schema.optionalKey(Schema.Array(PackageEntry)),
  remotes: Schema.optionalKey(Schema.Array(RemoteEntry)),
});

const PackageJson = Schema.Struct({
  version: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  mcpName: Schema.optionalKey(Schema.String),
});

export type ServerJson = typeof ServerJson.Type;

export type PackageJson = typeof PackageJson.Type;

// The MCP registry rejects descriptions over 100 characters (422 at publish
// time); enforce it here so CI catches it before the registry does.
const DESCRIPTION_LIMIT = 100;

/**
 * Remote transports the registry's schema allows. A `remotes` entry that names
 * anything else, or omits the url, fails validation at publish time, which is
 * the worst moment to find out: the npm package has already gone out by then
 * and only the registry listing fails.
 */
const RemoteTransportType = Schema.Literals(["streamable-http", "sse"]);

const isRemoteTransportType = Schema.is(RemoteTransportType);

const REMOTE_URL = /^https?:\/\/[^\s]+$/;

/**
 * Every environment variable `src/config.ts` (`loadConfig`) and `src/index.ts`
 * read, maintained by hand rather than parsed out of source. Parsing two files
 * for `process.env.LUCA_*` and `env.LUCA_*` reads is more code than the drift
 * it would catch. Add a name here in the same commit that adds a
 * `LUCA_*` read to either file. `checkRegistry` fails loudly on any name
 * server.json does not declare, so a missed entry here moves the drift one
 * file over instead of catching it. Keep this list matched to the two source
 * files by hand.
 */
export const READ_ENVIRONMENT_VARIABLES = [
  "LUCA_API_KEY",
  "LUCA_API_TOKEN",
  "LUCA_API_BASE_URL",
  "LUCA_AUTH_HEADER",
  "LUCA_WORKSPACE_ID",
  "LUCA_WORKSPACE_SLUG",
  "LUCA_TOOLSET",
] as const;

export type RegistryCheckInputs = {
  readonly server: ServerJson;
  readonly pkg: PackageJson;
  readonly lucaMcpVersion: string;
  readonly operationCount: number;
  readonly taskToolCount: number;
};

/**
 * True when `needle` appears in `haystack` as a whole number, not as a
 * substring of a longer number. Plain `includes(String(needle))` would treat
 * "96" as present inside "196" or "1296" and miss the drift entirely.
 */
function includesWholeNumber(haystack: string, needle: number): boolean {
  // needle is a number, so it cannot carry a regex metacharacter, and this
  // runs at build time over our own manifests rather than over request data.
  // fallow-ignore-next-line security-sink -- needle is a number, and this runs at build time
  return new RegExp(`(?<!\\d)${needle}(?!\\d)`).test(haystack);
}

/**
 * Pure check logic: compares server.json, package.json, and the live counts
 * from `src/operations.ts` / `src/task-tools.ts`, and returns every mismatch
 * found. No file I/O and no process exit here, so tests can call it directly
 * with fixtures instead of writing files to disk.
 */
export function checkRegistry(inputs: RegistryCheckInputs): string[] {
  return [
    ...checkVersions(inputs),
    ...checkIdentity(inputs),
    ...checkDescription(inputs),
    ...checkEnvironment(inputs.server),
    ...checkRemotes(inputs.server.remotes ?? []),
  ];
}

function checkVersions(inputs: RegistryCheckInputs): string[] {
  const { server, pkg, lucaMcpVersion } = inputs;
  const errors: string[] = [];

  if (server.version !== pkg.version) {
    errors.push(
      `server.json version (${server.version}) does not match package.json version (${pkg.version}). Fix server.json.`
    );
  }

  if (lucaMcpVersion !== pkg.version) {
    errors.push(
      `src/version.ts LUCA_MCP_VERSION (${lucaMcpVersion}) does not match package.json version (${pkg.version}). Fix src/version.ts.`
    );
  }

  const pkgEntry = server.packages?.[0];

  if (pkgEntry?.version !== pkg.version) {
    errors.push(
      `server.json packages[0].version (${pkgEntry?.version}) does not match package.json version (${pkg.version}). Fix server.json.`
    );
  }

  return errors;
}

function checkIdentity({ server, pkg }: RegistryCheckInputs): string[] {
  const errors: string[] = [];
  const pkgEntry = server.packages?.[0];

  if (pkgEntry?.identifier !== pkg.name) {
    errors.push(
      `server.json packages[0].identifier (${pkgEntry?.identifier}) does not match package.json name (${pkg.name}). Fix server.json.`
    );
  }

  // The MCP registry validates ownership of an npm-backed server by reading
  // the published package's `mcpName` field, which has to equal server.json's
  // `name`.
  if (pkg.mcpName !== server.name) {
    errors.push(
      `package.json mcpName (${pkg.mcpName}) does not match server.json name (${server.name}). Fix package.json or server.json so they agree.`
    );
  }

  return errors;
}

function checkDescription({
  server,
  operationCount,
  taskToolCount,
}: RegistryCheckInputs): string[] {
  const errors: string[] = [];
  const description = server.description ?? "";

  if (!includesWholeNumber(description, operationCount)) {
    errors.push(
      `server.json description must state the real API operation count (${operationCount}) as a whole number. Fix server.json.`
    );
  }

  if (!includesWholeNumber(description, taskToolCount)) {
    errors.push(
      `server.json description must state the real task tool count (${taskToolCount}) as a whole number. Fix server.json.`
    );
  }

  if (description.length > DESCRIPTION_LIMIT) {
    errors.push(
      `server.json description is ${description.length} chars; the MCP registry allows at most ${DESCRIPTION_LIMIT}. Fix server.json.`
    );
  }

  return errors;
}

function checkEnvironment(server: ServerJson): string[] {
  const errors: string[] = [];

  const declaredNames = HashSet.fromIterable(
    (server.packages?.[0]?.environmentVariables ?? []).map(
      (entry) => entry.name
    )
  );

  Arr.forEach(READ_ENVIRONMENT_VARIABLES, (name) => {
    if (!HashSet.has(declaredNames, name)) {
      errors.push(
        `${name} is read by src/config.ts or src/index.ts but not declared in server.json packages[0].environmentVariables. Fix server.json.`
      );
    }
  });

  return errors;
}

/**
 * Every malformed `remotes` entry. The hosted Worker is advertised here, and a
 * listing that points a client at a url it cannot reach is worse than one that
 * advertises stdio alone.
 */
function checkRemotes(remotes: readonly (typeof RemoteEntry.Type)[]) {
  const errors: string[] = [];

  Arr.forEach(remotes.entries(), ([index, remote]) => {
    const at = `server.json remotes[${index}]`;

    if (!isRemoteTransportType(remote.type)) {
      errors.push(
        `${at} has transport type ${remote.type ?? "(missing)"}; the registry accepts ${RemoteTransportType.literals.join(" or ")}.`
      );
    }

    if (!(remote.url && REMOTE_URL.test(remote.url))) {
      errors.push(
        `${at} needs an http(s) url; got ${remote.url ?? "(missing)"}.`
      );
    }
  });

  return errors;
}

/**
 * A title that still reads like an identifier. Every operation title used to be
 * `"Luca " + id`, which tells a client nothing the tool name did not already
 * say. Rejecting the machine shapes here is what keeps a new operation from
 * shipping with one.
 *
 * A dotted word only counts when the half before the dot names an operation
 * group. Rejecting every dot would reject "Connect Cal.com", which is a real
 * provider name and a perfectly good title.
 */
function isMachineTitle(
  title: string,
  id: string,
  groups: HashSet.HashSet<string>
): boolean {
  return (
    title.includes(id) ||
    title.includes("_") ||
    /^luca\b/i.test(title) ||
    dottedPrefixes(title).some((prefix) => HashSet.has(groups, prefix))
  );
}

/** The lowercased word in front of each dot: "Read leads.get" gives ["leads"]. */
function dottedPrefixes(title: string): string[] {
  return [...title.matchAll(/([A-Za-z]+)\.[A-Za-z]/g)].map((match) =>
    (match[1] ?? "").toLowerCase()
  );
}

/** Every operation title that is missing, machine-shaped, or duplicated. */
export function checkOperationTitles(
  operations: readonly { readonly id: string; readonly title: string }[]
): string[] {
  const errors: string[] = [];
  const seen = MutableHashMap.empty<string, string>();

  const groups = HashSet.fromIterable(
    operations.map((operation) =>
      (operation.id.split(".")[0] ?? operation.id).toLowerCase()
    )
  );

  Arr.forEach(operations, (operation) => {
    const title = operation.title.trim();

    if (Str.isEmpty(title)) {
      errors.push(
        `${operation.id} has an empty title. Write one in its catalog entry.`
      );

      return;
    }

    if (isMachineTitle(title, operation.id, groups)) {
      errors.push(
        `${operation.id} has a machine-shaped title ("${title}"). Write a short human label instead.`
      );
    }

    const owner = MutableHashMap.get(seen, title);

    if (Option.isNone(owner)) {
      MutableHashMap.set(seen, title, operation.id);
    } else {
      errors.push(
        `${operation.id} and ${owner.value} share the title "${title}". Titles are what a client shows, so make them distinct.`
      );
    }
  });

  return errors;
}

/** Reads a repository-relative path and decodes it as JSON shaped by `schema`. */
function readJsonFile<S extends Schema.Top>(relativePath: string, schema: S) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(yield* packagePath(relativePath));

    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(
      text
    );
  });
}

const main = Effect.fn("check-registry")(function* () {
  const server = yield* readJsonFile("server.json", ServerJson);
  const pkg = yield* readJsonFile("package.json", PackageJson);

  const errors = checkRegistry({
    server,
    pkg,
    lucaMcpVersion: LUCA_MCP_VERSION,
    operationCount: LUCA_OPERATIONS.length,
    taskToolCount: LUCA_TASK_TOOLS.length,
  }).concat(checkOperationTitles(LUCA_OPERATIONS));

  if (Arr.isReadonlyArrayNonEmpty(errors)) {
    return yield* exitWith([
      "server.json is out of sync:",
      ...errors.map((error) => `- ${error}`),
    ]);
  }

  yield* Console.log("server.json is in sync");
});

// Only run the CLI when this file is the process entry point, so tests can
// import `checkRegistry` (and the other exports above) without triggering a
// real file read or a process exit.
if (isEntryPoint(import.meta.filename)) {
  runScript(main());
}
