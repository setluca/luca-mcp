import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

const directImport =
  /\b(?:from\s*|import\s*\(|require\s*\()\s*["']zod(?:\/[^"']*)?["']/u;

describe("Effect Schema boundary", () => {
  it("does not add Zod as a direct dependency", () => {
    const pkg = JSON.parse(
      readFileSync(join(root, "package.json"), "utf-8")
    ) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    expect(pkg.dependencies).not.toHaveProperty("zod");
    expect(pkg.devDependencies).not.toHaveProperty("zod");
  });

  it("keeps first-party code free of Zod imports", () => {
    const offenders = ["src", "scripts"].flatMap((directory) =>
      readdirSync(join(root, directory), { recursive: true })
        .map((name) => join(directory, String(name)))
        .filter(
          (name) => name.endsWith(".ts") && !name.startsWith("src/generated/")
        )
        .filter((name) =>
          directImport.test(readFileSync(join(root, name), "utf-8"))
        )
    );

    expect(offenders).toEqual([]);
  });
});
