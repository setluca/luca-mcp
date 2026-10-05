import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { LUCA_CONTRACT_FILES } from "../scripts/lib/contract-files.ts";
import {
  assertDeployedContracts,
  deployedLucaCommit,
} from "../scripts/lib/deployed-luca.ts";

const deployedCommit = "940f7f2823f254d61d809ba6c52c20d968f45d8e";

const snapshots = Object.fromEntries(
  Object.keys(LUCA_CONTRACT_FILES).map((name) => [name, Buffer.from(name)])
);

const sha256 = Object.fromEntries(
  Object.entries(snapshots).map(([name, contents]) => [
    name,
    createHash("sha256").update(contents).digest("hex"),
  ])
);

function source(commit = deployedCommit) {
  return { repository: "setluca/luca", commit, sha256 };
}

describe("Luca production contract pin", () => {
  it("accepts a production health response with an exact commit", () => {
    expect(
      deployedLucaCommit({
        runtime: { environment: "production" },
        version: { tag: deployedCommit },
      })
    ).toBe(deployedCommit);
  });

  it.each([
    {
      runtime: { environment: "development" },
      version: { tag: deployedCommit },
    },
    { runtime: { environment: "production" }, version: { tag: "master" } },
    { runtime: { environment: "production" }, version: null },
  ])("rejects health without a deployed production commit", (health) => {
    expect(() => deployedLucaCommit(health)).toThrow();
  });

  it("accepts the exact commit and a semantically equal OpenAPI snapshot", () => {
    expect(() =>
      assertDeployedContracts({
        source: source(),
        deployedCommit,
        snapshots,
        snapshotOpenApi: { info: { version: "1" }, paths: {} },
        deployedOpenApi: { paths: {}, info: { version: "1" } },
      })
    ).not.toThrow();
  });

  it("rejects an ahead or rolled-back contract pin", () => {
    expect(() =>
      assertDeployedContracts({
        source: source("c6c9d0064e089926a1e6b81bbf78a7a956c3206f"),
        deployedCommit,
        snapshots,
        snapshotOpenApi: {},
        deployedOpenApi: {},
      })
    ).toThrow(/pin .* production runs/u);
  });

  it("rejects an OpenAPI snapshot that differs from production", () => {
    expect(() =>
      assertDeployedContracts({
        source: source(),
        deployedCommit,
        snapshots,
        snapshotOpenApi: { paths: { "/old": {} } },
        deployedOpenApi: { paths: { "/new": {} } },
      })
    ).toThrow(/OpenAPI snapshot differs/u);
  });

  it("rejects a contract file modified after the source commit was pinned", () => {
    expect(() =>
      assertDeployedContracts({
        source: source(),
        deployedCommit,
        snapshots: { ...snapshots, "channel.ts": Buffer.from("changed") },
        snapshotOpenApi: {},
        deployedOpenApi: {},
      })
    ).toThrow(/channel.ts differs from its source digest/u);
  });
});
