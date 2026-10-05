import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import * as Schema from "effect/Schema";

import { JsonValue } from "../../src/serialization.ts";
import { LUCA_CONTRACT_FILES } from "./contract-files.ts";

const Commit = /^[0-9a-f]{40}$/u;

const DeploymentHealth = Schema.Struct({
  runtime: Schema.Struct({ environment: Schema.String }),
  version: Schema.Struct({ tag: Schema.String }),
});

const ContractSource = Schema.Struct({
  repository: Schema.Literal("setluca/luca"),
  commit: Schema.String,
  sha256: Schema.Record(Schema.String, Schema.String),
});

export function deployedLucaCommit(value: JsonValue): string {
  const health = Schema.decodeUnknownSync(DeploymentHealth)(value);

  if (
    health.runtime.environment !== "production" ||
    !Commit.test(health.version.tag)
  ) {
    throw new Error("Luca health did not identify a production commit");
  }

  return health.version.tag;
}

export function assertDeployedContracts(input: {
  readonly source: JsonValue;
  readonly deployedCommit: string;
  readonly snapshots: Readonly<Record<string, Buffer>>;
  readonly snapshotOpenApi: JsonValue;
  readonly deployedOpenApi: JsonValue;
}): void {
  const source = Schema.decodeUnknownSync(ContractSource)(input.source);

  if (!Commit.test(source.commit) || source.commit !== input.deployedCommit) {
    throw new Error(
      `MCP contracts pin ${source.commit}; Luca production runs ${input.deployedCommit}. Sync from the deployed commit.`
    );
  }

  for (const name of Object.keys(LUCA_CONTRACT_FILES)) {
    const contents = input.snapshots[name];

    if (
      !contents ||
      createHash("sha256").update(contents).digest("hex") !==
        source.sha256[name]
    ) {
      throw new Error(
        `Pinned Luca contract ${name} differs from its source digest`
      );
    }
  }

  if (!isDeepStrictEqual(input.snapshotOpenApi, input.deployedOpenApi)) {
    throw new Error("The pinned OpenAPI snapshot differs from Luca production");
  }
}

export async function fetchDeployedJson(
  path: "/health" | "/openapi.json"
): Promise<JsonValue> {
  const options = {
    cache: "no-store" as const,
    signal: AbortSignal.timeout(20_000),
  };

  const response =
    path === "/health"
      ? await fetch("https://api.setluca.com/health", options)
      : await fetch("https://api.setluca.com/openapi.json", options);

  if (!response.ok) {
    throw new Error(`Luca ${path} returned HTTP ${response.status}`);
  }

  return Schema.decodeUnknownSync(JsonValue)(await response.json());
}

export async function fetchDeployedLucaCommit(): Promise<string> {
  return deployedLucaCommit(await fetchDeployedJson("/health"));
}
