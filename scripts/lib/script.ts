import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Arr from "effect/Array";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";

import type { JsonValueInput } from "../../src/serialization.ts";

/** The services a script gets: the local file system, path handling, and stdio. */
export type ScriptServices = BunServices.BunServices;

/**
 * A script printed its own report and now only needs the process to exit with
 * `exitCode`. `runMain` reads the code off the error and skips its own log,
 * because the report already said what went wrong.
 */
export class ScriptExit extends Schema.TaggedError<ScriptExit>()("ScriptExit", {
  exitCode: Schema.Number,
}) {
  override readonly [Runtime.errorReported] = false;

  override get [Runtime.errorExitCode]() {
    return this.exitCode;
  }
}

/** Prints each line to stderr, then exits with `exitCode`. */
export function exitWith(
  lines: readonly string[],
  exitCode = 1
): Effect.Effect<never, ScriptExit> {
  return Effect.andThen(
    Effect.forEach(lines, (line) => Console.error(line), {
      concurrency: 1,
      discard: true,
    }),
    Effect.fail(new ScriptExit({ exitCode }))
  );
}

export type ScriptMode = "write" | "check";

/** Reads `--write` or `--check` off the command line, or exits 2 with `usage`. */
export function scriptMode(
  usage: string
): Effect.Effect<ScriptMode, ScriptExit> {
  return Effect.suspend(() => {
    if (Arr.contains(process.argv, "--write")) {
      return Effect.succeed("write" as const);
    }

    if (Arr.contains(process.argv, "--check")) {
      return Effect.succeed("check" as const);
    }

    return exitWith([usage], 2);
  });
}

/** True when the module at `filename` is the file `bun` was asked to run. */
export function isEntryPoint(filename: string): boolean {
  return process.argv[1] === filename;
}

/** Runs a script's program with the Bun platform services and exits with its result. */
export function runScript<E>(
  program: Effect.Effect<void, E, ScriptServices>
): void {
  BunRuntime.runMain(Effect.provide(program, BunServices.layer));
}

const encodePrettyJson = Schema.encodeSync(
  Schema.fromJsonString(Schema.Unknown, { space: 2 })
);

/** `value` as two-space-indented JSON, the layout every generated file uses. */
export function prettyJson(value: JsonValueInput): string {
  return encodePrettyJson(value);
}
