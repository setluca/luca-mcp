import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

const pages = [
  "README.md",
  "AGENTS.md",
  ...readdirSync(join(root, "docs"), { recursive: true })
    .map((name) => join("docs", String(name)))
    .filter((name) => name.endsWith(".md")),
];

const markdownLink = /\]\(([^)#]+)(?:#[^)]*)?\)/gu;

describe("documentation links", () => {
  it("resolves every local Markdown target", () => {
    const broken = pages.flatMap((page) => {
      const source = readFileSync(join(root, page), "utf-8");

      return [...source.matchAll(markdownLink)].flatMap((match) => {
        const target = match[1];

        return target &&
          !/^[a-z][a-z\d+.-]*:/iu.test(target) &&
          !existsSync(join(root, dirname(page), target))
          ? [`${page}: ${target}`]
          : [];
      });
    });

    expect(broken).toEqual([]);
  });
});
