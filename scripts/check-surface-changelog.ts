/**
 * Lists what clients will see change since the last release, and fails when the
 * changelog doesn't cover it. A tool added or removed has to be named, and any other
 * change needs some entry. It compares with the release rather than the previous
 * commit, so a miss stays red until the changelog is fixed instead of clearing on the
 * next merge.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

import * as Arr from "effect/Array";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { type JsonValue, parseJson } from "../src/serialization.ts";
import { exitWith, isEntryPoint, runScript } from "./lib/script.ts";
import { changedPaths } from "./lib/tool-surface.ts";

/** Every release changes this, and the version bump is not news to a client. */
const VERSION_PATH = "server > serverInfo > version";

const SurfaceTools = Schema.Struct({
  tools: Schema.Record(Schema.String, Schema.Unknown),
});

const toolNames = (surface: JsonValue): readonly string[] =>
  Object.keys(Schema.decodeUnknownSync(SurfaceTools)(surface).tools);

export type SurfaceChanges = {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly paths: readonly string[];
};

export function surfaceChanges(
  before: JsonValue,
  after: JsonValue
): SurfaceChanges {
  const beforeTools = toolNames(before);
  const afterTools = toolNames(after);

  return {
    added: afterTools.filter((name) => !beforeTools.includes(name)),
    removed: beforeTools.filter((name) => !afterTools.includes(name)),
    paths: changedPaths(before, after).filter((path) => path !== VERSION_PATH),
  };
}

/** The changelog's entries newer than `version`, without their headings. */
export function changelogNotesSince(
  changelog: string,
  version: string
): string {
  const start = changelog.indexOf("## [Unreleased]");
  const end = changelog.indexOf(`## [${version}]`);

  if (start === -1 || end === -1) {
    throw new Error(`CHANGELOG.md has no Unreleased or ${version} heading`);
  }

  return changelog
    .slice(start, end)
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n")
    .trim();
}

/** What the changelog fails to cover. Empty means it covers everything. */
export function changelogGaps(
  { added, removed, paths }: SurfaceChanges,
  notes: string
): readonly string[] {
  const unnamed = [...added, ...removed].flatMap((name) =>
    notes.includes(name)
      ? []
      : [`${name} was added or removed, and the changelog doesn't name it`]
  );

  return Arr.isReadonlyArrayEmpty(paths) || notes !== ""
    ? unnamed
    : [...unnamed, "Clients will see changes, and the changelog has no entry"];
}

/** The changes as Markdown, by tool, for the run's summary. */
export function changesSummary(
  { added, removed, paths }: SurfaceChanges,
  release: string
): string {
  if (Arr.isReadonlyArrayEmpty(paths)) {
    return `Nothing a client sees has changed since ${release}.`;
  }

  const moved = paths.filter(
    (path) =>
      !added.some((name) => path.includes(` ${name} `)) &&
      !removed.some((name) => path.includes(` ${name} `))
  );

  return [
    `### Changes for clients since ${release}`,
    ...added.map((name) => `- Added \`${name}\``),
    ...removed.map((name) => `- Removed \`${name}\``),
    ...moved.map((path) => `- Changed \`${path}\``),
  ].join("\n");
}

function git(...args: readonly string[]): string {
  // fallow-ignore-next-line security-sink -- git is fixed, and the arguments are this repository's own refs
  return execFileSync("git", args, {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

const program = Effect.fn("check-surface-changelog")(function* () {
  const release = git("tag", "--list", "mcp-v*", "--sort=-version:refname")
    .split("\n")[0]
    ?.trim();

  if (release === undefined || release === "") {
    return yield* exitWith([
      "There is no mcp-v* tag. Fetch them, or tag a release first.",
    ]);
  }

  const changes = surfaceChanges(
    yield* parseJson(git("show", `${release}:tool-surface.json`)),
    yield* parseJson(readFileSync("tool-surface.json", "utf-8"))
  );

  const summary = changesSummary(changes, release);

  yield* Console.log(summary);

  if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }

  const gaps = changelogGaps(
    changes,
    changelogNotesSince(
      readFileSync("CHANGELOG.md", "utf-8"),
      release.replace("mcp-v", "")
    )
  );

  if (gaps.length > 0) {
    return yield* exitWith([...gaps]);
  }
});

if (isEntryPoint(import.meta.filename)) {
  runScript(program());
}
