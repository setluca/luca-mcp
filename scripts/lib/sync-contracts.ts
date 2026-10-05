import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { LUCA_CONTRACT_FILES } from "./contract-files.ts";
import { fetchDeployedLucaCommit } from "./deployed-luca.ts";

export type SyncOptions = {
  readonly repo: string;
  readonly ref: string | undefined;
  readonly deployed: boolean;
  readonly write: boolean;
};

type ContractSnapshots = {
  readonly commit: string;
  readonly files: Record<string, Buffer>;
};

export function parseSyncOptions(args: readonly string[]): SyncOptions {
  const repoIndex = args.indexOf("--repo");
  const refIndex = args.indexOf("--ref");
  const repo = repoIndex === -1 ? undefined : args[repoIndex + 1];
  const ref = refIndex === -1 ? undefined : args[refIndex + 1];
  const deployed = args.includes("--deployed");
  const write = args.includes("--write");
  const check = args.includes("--check");

  if (!repo || write === check || deployed === Boolean(ref)) {
    throw new Error(
      "Usage: bun run contracts:sync --repo /path/to/luca --deployed|--ref SHA --check|--write"
    );
  }

  return { repo: resolve(repo), ref, deployed, write };
}

function git(repo: string, ...args: string[]): Buffer {
  return execFileSync("git", ["-C", repo, ...args], {
    maxBuffer: 16 * 1024 * 1024,
  });
}

export function contractSnapshots(
  repo: string,
  ref: string
): ContractSnapshots {
  const commit = git(repo, "rev-parse", `${ref}^{commit}`).toString().trim();

  const files = Object.fromEntries(
    Object.entries(LUCA_CONTRACT_FILES).map(([destination, source]) => [
      destination,
      git(repo, "show", `${commit}:${source}`),
    ])
  );

  const sha256 = Object.fromEntries(
    Object.entries(files).map(([name, contents]) => [
      name,
      createHash("sha256").update(contents).digest("hex"),
    ])
  );

  files["source.json"] = Buffer.from(
    `${JSON.stringify({ repository: "setluca/luca", commit, sha256 }, null, 2)}\n`
  );

  return { commit, files };
}

export function applyContractSnapshots(
  root: string,
  files: Readonly<Record<string, Buffer>>,
  write: boolean
): string[] {
  return Object.entries(files).flatMap(([name, content]) => {
    const target = resolve(root, "contracts", name);

    if (write) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);

      return [];
    }

    try {
      return readFileSync(target).equals(content) ? [] : [name];
    } catch {
      return [name];
    }
  });
}

export async function syncLucaContracts(
  options: SyncOptions,
  root: string
): Promise<{ readonly commit: string; readonly stale: readonly string[] }> {
  const ref = options.deployed ? await fetchDeployedLucaCommit() : options.ref;

  if (!ref) {
    throw new Error(
      "A Luca commit or deployed production revision is required"
    );
  }

  const { commit, files } = contractSnapshots(options.repo, ref);
  const stale = applyContractSnapshots(root, files, options.write);

  return { commit, stale };
}
