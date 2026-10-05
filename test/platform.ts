import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";

/**
 * Runs `program` with the Bun file system and path services. For tests that
 * read repository files while vitest collects them, before any test runs.
 */
export function runWithPlatform<A, E>(
  program: Effect.Effect<A, E, BunServices.BunServices>
): Promise<A> {
  return Effect.runPromise(Effect.provide(program, BunServices.layer));
}
