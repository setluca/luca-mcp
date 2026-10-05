import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const contracts = {
  "openapi.json": "apps/api/openapi.json",
  "api-key-policies.json": "apps/api/api-key-policies.json",
  "agent-scope.ts": "packages/schemas/src/agent-scope.ts",
  "public-route-policy.ts": "apps/api/src/lib/public-route-policy.ts",
  "agent-surface-log.ts": "packages/observability/src/agent-surface-log.ts",
  "channel.ts": "packages/schemas/src/channel.ts",
} as const;

const args = process.argv.slice(2);
const repoIndex = args.indexOf("--repo");
const refIndex = args.indexOf("--ref");
const write = args.includes("--write");
const check = args.includes("--check");

if (
  repoIndex < 0 ||
  !args[repoIndex + 1] ||
  write === check ||
  (refIndex >= 0 && !args[refIndex + 1])
) {
  console.error(
    "Usage: bun run contracts:sync --repo /path/to/luca [--ref origin/master] --check|--write"
  );
  process.exit(2);
}

const repo = resolve(args[repoIndex + 1]!);
const ref = refIndex >= 0 ? args[refIndex + 1]! : "HEAD";
const root = resolve(import.meta.dirname, "..");

function git(...gitArgs: string[]): Buffer {
  return execFileSync("git", ["-C", repo, ...gitArgs], {
    maxBuffer: 16 * 1024 * 1024,
  });
}

const commit = git("rev-parse", `${ref}^{commit}`).toString().trim();
const files: Record<string, Buffer> = {};

for (const [destination, source] of Object.entries(contracts)) {
  files[destination] = git("show", `${commit}:${source}`);
}

files["source.json"] = Buffer.from(
  `${JSON.stringify({ repository: "setluca/luca", commit }, null, 2)}\n`
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
  console.error(`Stale Luca contracts: ${stale.map(([name]) => name).join(", ")}`);
  process.exit(1);
}

console.log(
  write
    ? `Copied Luca contracts from ${commit}. Regenerate OpenAPI outputs and docs.`
    : `Luca contracts match ${commit}.`
);
