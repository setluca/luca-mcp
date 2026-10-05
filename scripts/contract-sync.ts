import { resolve } from "node:path";

import { parseSyncOptions, syncLucaContracts } from "./lib/sync-contracts.ts";

const options = parseSyncOptions(process.argv.slice(2));

const root = resolve(import.meta.dirname, "..");

const { commit, stale } = await syncLucaContracts(options, root);

if (stale.length > 0) {
  console.error(`Stale Luca contracts: ${stale.join(", ")}`);
  process.exit(1);
}

console.log(
  options.write
    ? `Copied Luca contracts from ${commit}. Regenerate OpenAPI outputs and docs.`
    : `Luca contracts match ${commit}.`
);
