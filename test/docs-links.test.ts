import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

const pages = [
  "README.md",
  "AGENTS.md",
  ...readdirSync(join(root, "docs"), { recursive: true })
    .map((name) => join("docs", String(name)))
    .filter((name) => name.endsWith(".md")),
];

/** Decision records describe the past, so what they name may be gone by now. */
const currentPages = pages.filter(
  (page) => !page.startsWith(join("docs", "adr"))
);

const markdownLink = /\]\(([^)#]+)(?:#[^)]*)?\)/gu;

/** Every `pattern` capture in the current docs, with where it was found. */
const mentions = (pattern: RegExp) =>
  currentPages.flatMap((page) =>
    readFileSync(join(root, page), "utf-8")
      .split("\n")
      .flatMap((line, index) =>
        [...line.matchAll(pattern)].flatMap((match) =>
          match[1] === undefined
            ? []
            : [{ value: match[1], at: `${page}:${index + 1}` }]
        )
      )
  );

const decodeSurface = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({ tools: Schema.Record(Schema.String, Schema.Unknown) })
  )
);

const decodePackage = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) })
  )
);

const read = (path: string) => readFileSync(join(root, path), "utf-8");

/** What pagination-and-tool-count.md says a single catch-all tool would look like. */
const NOT_TOOLS = new Set(["luca_leads"]);

/** Files in setluca/luca and setluca/website, which the docs point at by path. */
const IN_OTHER_REPOSITORIES = new Set([
  ".github/workflows/mcp-contract-preview.yml",
  ".github/workflows/mcp-contract-sync.yml",
  ".github/workflows/mcp-sweep.yml",
  "scripts/seed-sweep-workspace.ts",
  "src/lib/mcp-metadata.fallback.json",
]);

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

  it("names only tools the server has", () => {
    const { tools } = decodeSurface(read("tool-surface.json"));

    // A trailing underscore or `*` is a prefix, such as `luca_memory_*`, not a name.
    const missing = mentions(/`(luca_[a-z0-9_]*[a-z0-9])`/gu)
      .filter(({ value }) => !(value in tools) && !NOT_TOOLS.has(value))
      .map(({ value, at }) => `${at}: ${value}`);

    expect(missing).toEqual([]);
  });

  it("names only files that exist", () => {
    const missing = mentions(
      /`((?:src|scripts|test|docs|contracts|public|\.github|submission)\/[\w./-]*\w)`/gu
    )
      .filter(
        ({ value }) =>
          !existsSync(join(root, value)) && !IN_OTHER_REPOSITORIES.has(value)
      )
      .map(({ value, at }) => `${at}: ${value}`);

    expect(missing).toEqual([]);
  });

  it("runs only commands package.json has", () => {
    const { scripts } = decodePackage(read("package.json"));

    const missing = mentions(/bun run ([a-z][a-z:-]*)/gu)
      .filter(({ value }) => !(value in scripts))
      .map(({ value, at }) => `${at}: ${value}`);

    expect(missing).toEqual([]);
  });
});
