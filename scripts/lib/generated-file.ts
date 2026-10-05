import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { exitWith, type ScriptMode } from "./script.ts";

/** A path under this repository, resolved from this file's directory. */
export function packagePath(relativePath: string) {
  return Effect.map(Path.Path, (path) =>
    path.resolve(import.meta.dirname, "../..", relativePath)
  );
}

/** Writes `content` under this repository, creating its directory. */
export function writeGenerated(relativePath: string, content: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = yield* packagePath(relativePath);

    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.writeFileString(target, content);
    yield* Console.log(`wrote ${relativePath}`);
  });
}

/**
 * The current contents of a repository-relative path, or "" when the file does
 * not exist yet. Any other read failure still fails, so a permission or I/O
 * error is not reported as a stale file.
 */
export function readCurrent(relativePath: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const target = yield* packagePath(relativePath);

    return yield* fs.readFileString(target).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed("")
      )
    );
  });
}

/**
 * Writes one generated file, or in check mode exits 1 with `staleMessage` when
 * the committed file differs from `content`.
 */
export function writeOrCheck(options: {
  readonly mode: ScriptMode;
  readonly target: string;
  readonly content: string;
  readonly staleMessage: string;
  readonly syncMessage: string;
}) {
  if (options.mode === "write") {
    return writeGenerated(options.target, options.content);
  }

  return Effect.gen(function* () {
    const current = yield* readCurrent(options.target);

    if (current !== options.content) {
      return yield* exitWith([options.staleMessage]);
    }

    yield* Console.log(options.syncMessage);
  });
}
