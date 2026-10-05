import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LUCA_CONTRACT_FILES } from "../scripts/lib/contract-files.ts";
import {
  applyContractSnapshots,
  contractSnapshots,
  parseSyncOptions,
  syncLucaContracts,
} from "../scripts/lib/sync-contracts.ts";

const temporary: string[] = [];

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "luca-mcp-contracts-"));
  temporary.push(path);

  return path;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args])
    .toString()
    .trim();
}

describe("contract sync", () => {
  afterEach(() => {
    for (const path of temporary.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it("accepts one source and one action", () => {
    expect(
      parseSyncOptions(["--repo", ".", "--ref", "abc", "--check"])
    ).toMatchObject({
      ref: "abc",
      deployed: false,
      write: false,
    });
    expect(
      parseSyncOptions(["--repo", ".", "--deployed", "--write"])
    ).toMatchObject({
      deployed: true,
      write: true,
    });
  });

  it.each([
    [],
    ["--repo", ".", "--ref", "abc"],
    ["--repo", ".", "--deployed", "--ref", "abc", "--check"],
    ["--repo", ".", "--deployed", "--check", "--write"],
  ])("rejects incomplete or ambiguous arguments", (...args) => {
    expect(() => parseSyncOptions(args)).toThrow(/Usage/u);
  });

  it("pins a Git commit, detects drift, and writes matching snapshots", async () => {
    const repo = directory();
    const root = directory();
    git(repo, "init", "-q");

    for (const [destination, source] of Object.entries(LUCA_CONTRACT_FILES)) {
      const target = join(repo, source);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, `content for ${destination}\n`);
    }

    git(repo, "add", ".");
    git(
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      "contract fixture"
    );

    const commit = git(repo, "rev-parse", "HEAD");
    const snapshots = contractSnapshots(repo, "HEAD");
    expect(snapshots.commit).toBe(commit);
    expect(
      JSON.parse(snapshots.files["source.json"]!.toString())
    ).toMatchObject({
      repository: "setluca/luca",
      commit,
    });
    expect(applyContractSnapshots(root, snapshots.files, false)).toHaveLength(
      7
    );
    expect(applyContractSnapshots(root, snapshots.files, true)).toEqual([]);
    expect(applyContractSnapshots(root, snapshots.files, false)).toEqual([]);

    writeFileSync(join(root, "contracts", "channel.ts"), "changed");

    const result = await syncLucaContracts(
      { repo, ref: commit, deployed: false, write: false },
      root
    );

    expect(result.stale).toEqual(["channel.ts"]);
    expect(
      readFileSync(join(root, "contracts", "source.json"), "utf-8")
    ).toContain(commit);
  });
});
