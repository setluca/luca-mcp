import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as R from "effect/Record";

import { ROUTE_CATALOG } from "../../src/generated/route-catalog.ts";
import { loadOpenApi } from "../load-openapi.ts";
import { writeOrCheck } from "./generated-file.ts";
import {
  findOpenApiOperation,
  type OpenApiOperation,
} from "./openapi-operation.ts";
import { exitWith, type ScriptExit, scriptMode } from "./script.ts";

function operationKey(method: string, path: string) {
  return `${method.toUpperCase()} ${path}`;
}

/** One file a codegen script writes, or in check mode compares. */
export type GeneratedFile<Value> = {
  /** Relative to `apps/mcp`. */
  readonly target: string;
  readonly render: (record: Record<string, Value>) => string;
};

/**
 * Every route the API-key allowlist grants, once each. The generators walk the
 * route catalog rather than the operation registry: the registry loads the
 * files they write, so reading it here would make each run depend on the
 * previous run's output, and a new export could not be generated at all.
 */
const CATALOG_ROUTES = Arr.dedupeWith(
  R.values(ROUTE_CATALOG).map(({ method, path }) => ({ method, path })),
  (a, b) => a.method === b.method && a.path === b.path
);

/**
 * Shared driver for the two `generate-openapi-*` scripts: parse the
 * `--write`/`--check` mode, load the OpenAPI snapshot, map every catalog route
 * through the caller's `extract`, render each file, and either write it or
 * diff it against the committed copy. Only the per-script pieces (how to
 * extract a value from the decoded operation, and which files to render from
 * the record) vary.
 */
export function runCodegen<Value>(config: {
  readonly scriptName: string;
  /** Fails with a {@link ScriptExit} when a route cannot be generated. */
  readonly extract: (
    operation: OpenApiOperation,
    route: string
  ) => Effect.Effect<Value, ScriptExit>;
  readonly files: readonly GeneratedFile<Value>[];
}) {
  return Effect.gen(function* () {
    const mode = yield* scriptMode(
      `usage: ${config.scriptName} --write|--check`
    );

    const { spec } = yield* loadOpenApi();

    const entries = yield* Effect.forEach(
      CATALOG_ROUTES,
      (operation) =>
        Option.match(findOpenApiOperation(spec, operation), {
          onNone: () =>
            exitWith([
              `Missing OpenAPI operation ${operation.method} ${operation.path}`,
            ]),
          onSome: (openApiOperation) => {
            const route = operationKey(operation.method, operation.path);

            return Effect.map(
              config.extract(openApiOperation, route),
              (value) => [route, value] as const
            );
          },
        }),
      { concurrency: 1 }
    );

    const record = R.fromEntries(entries);

    yield* Effect.forEach(
      config.files,
      (file) =>
        writeOrCheck({
          mode,
          target: file.target,
          content: file.render(record),
          staleMessage: `${file.target} is out of date. Run \`bun run openapi:generate\`.`,
          syncMessage: `${file.target} is in sync`,
        }),
      { concurrency: 1, discard: true }
    );
  });
}
