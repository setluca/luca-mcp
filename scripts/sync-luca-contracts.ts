import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { LUCA_CONTRACT_FILES } from "./lib/contract-files.ts";
import { fetchDeployedLucaCommit } from "./lib/deployed-luca.ts";

const args = process.argv.slice(2);

const repoIndex = args.indexOf("--repo");

const refIndex = args.indexOf("--ref");

const repoArgument = repoIndex === -1 ? undefined : args[repoIndex + 1];

const refArgument = refIndex === -1 ? undefined : args[refIndex + 1];

const deployed = args.includes("--deployed");

const write = args.includes("--write");

const check = args.includes("--check");

if (!repoArgument || write === check || deployed === Boolean(refArgument)) {
  console.error(
    "Usage: bun run contracts:sync --repo /path/to/luca --deployed|--ref SHA --check|--write"
  );
  process.exit(2);
}

const repo = resolve(repoArgument);

const ref = deployed ? await fetchDeployedLucaCommit() : refArgument;

if (!ref) {
  throw new Error("A Luca commit or deployed production revision is required");
}

const root = resolve(import.meta.dirname, "..");

function git(...gitArgs: string[]): Buffer {
  return execFileSync("git", ["-C", repo, ...gitArgs], {
    maxBuffer: 16 * 1024 * 1024,
  });
}

const commit = git("rev-parse", `${ref}^{commit}`).toString().trim();

const files: Record<string, Buffer> = {};

for (const [destination, source] of Object.entries(LUCA_CONTRACT_FILES)) {
  files[destination] = git("show", `${commit}:${source}`);
}

const sha256 = Object.fromEntries(
  Object.entries(files).map(([name, contents]) => [
    name,
    createHash("sha256").update(contents).digest("hex"),
  ])
);

files["source.json"] = Buffer.from(
  `${JSON.stringify({ repository: "setluca/luca", commit, sha256 }, null, 2)}\n`
);

const stale = Object.entries(files).filter(([name, content]) => {
  const target = resolve(root, "contracts", name);

  if (write) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);

    return false;
  }

  try {
    return !readFileSync(target).equals(content);
  } catch {
    return true;
  }
});

if (stale.length > 0) {
  console.error(
    `Stale Luca contracts: ${stale.map(([name]) => name).join(", ")}`
  );
  process.exit(1);
}

console.log(
  write
    ? `Copied Luca contracts from ${commit}. Regenerate OpenAPI outputs and docs.`
    : `Luca contracts match ${commit}.`
);
