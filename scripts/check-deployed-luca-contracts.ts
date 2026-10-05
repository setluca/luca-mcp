import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as Schema from "effect/Schema";

import { JsonValue } from "../src/serialization.ts";
import { LUCA_CONTRACT_FILES } from "./lib/contract-files.ts";
import {
  assertDeployedContracts,
  fetchDeployedJson,
  fetchDeployedLucaCommit,
} from "./lib/deployed-luca.ts";

const contracts = resolve(import.meta.dirname, "../contracts");

function readJson(filename: string): JsonValue {
  return Schema.decodeUnknownSync(Schema.fromJsonString(JsonValue))(
    readFileSync(resolve(contracts, filename), "utf-8")
  );
}

const source = readJson("source.json");

const snapshotOpenApi = readJson("openapi.json");

const snapshots = Object.fromEntries(
  Object.keys(LUCA_CONTRACT_FILES).map((name) => [
    name,
    readFileSync(resolve(contracts, name)),
  ])
);

for (let attempt = 1; attempt <= 3; attempt++) {
  const before = await fetchDeployedLucaCommit();

  const deployedOpenApi = await fetchDeployedJson("/openapi.json");

  const after = await fetchDeployedLucaCommit();

  if (before !== after) {
    if (attempt === 3) {
      throw new Error("Luca production changed during the contract check");
    }

    continue;
  }

  assertDeployedContracts({
    source,
    deployedCommit: after,
    snapshots,
    snapshotOpenApi,
    deployedOpenApi,
  });

  console.log(`MCP contracts match Luca production ${after}.`);
  break;
}
