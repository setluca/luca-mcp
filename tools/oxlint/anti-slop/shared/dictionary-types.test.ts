import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as Schema from "effect/Schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const pluginPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const oxlintPath = fileURLToPath(
  new URL("../../../../node_modules/.bin/oxlint", import.meta.url)
);
const LintOutput = Schema.Struct({
  diagnostics: Schema.Array(Schema.Struct({ message: Schema.String })),
});

let directory: string;
let configPath: string;
let nextFixture = 0;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "luca-dictionary-types-"));
  configPath = join(directory, "oxlint.json");
  await writeFile(
    configPath,
    JSON.stringify({
      categories: { correctness: "off" },
      jsPlugins: [{ name: "anti-slop", specifier: pluginPath }],
      rules: {
        "anti-slop/no-unsafe-dictionary-type": "error",
        "anti-slop/no-known-value-widening": "error",
      },
    })
  );
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function lint(code: string) {
  const fixturePath = join(directory, `fixture-${nextFixture++}.ts`);
  await writeFile(fixturePath, code);
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      oxlintPath,
      [
        "--config",
        configPath,
        "--disable-nested-config",
        "--format",
        "json",
        fixturePath,
      ],
      (error, stdout, stderr) => {
        if (stderr || (error && error.code !== 1)) {
          reject(error ?? new Error(stderr));
          return;
        }
        resolve(stdout);
      }
    );
  });
  return Schema.decodeUnknownSync(LintOutput)(JSON.parse(output)).diagnostics;
}

describe("dictionary type parameter substitution", () => {
  it("keeps an outer parameter distinct from an alias parameter of the same name", async () => {
    expect(
      await lint(`
        type CurrentSchemaExport = { readonly tableName: string };
        type SchemaModuleExports<Export> = Readonly<Record<string, Export>>;
        declare function runtimeSchemaContract<Export>(
          exports: SchemaModuleExports<Export | CurrentSchemaExport>
        ): void;
      `)
    ).toEqual([]);
  });

  it("still reports an unsafe sibling of the unresolved outer parameter", async () => {
    const diagnostics = await lint(`
      type Dictionary<Value> = Readonly<Record<string, Value>>;
      declare function accept<Value>(values: Dictionary<Value | unknown>): void;
    `);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("union value type");
  });

  it("resolves explicit arguments in the caller's scope", async () => {
    expect(
      await lint(`
        type Dictionary<First, Second> = Record<string, Second>;
        declare function accept<First>(values: Dictionary<unknown, First>): void;
      `)
    ).toEqual([]);
  });

  it("does not substitute a caller's parameter into a module alias's own binding", async () => {
    expect(
      await lint(`
        type Value = string;
        type ModuleDictionary = Record<string, Value>;
        type Dictionary<Value> = ModuleDictionary;
        declare const values: Dictionary<unknown>;
      `)
    ).toEqual([]);
  });

  it("resolves defaults after earlier parameters have been bound", async () => {
    const diagnostics = await lint(`
      type Dictionary<First, Second = First> = Record<string, Second>;
      declare const values: Dictionary<unknown>;
    `);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("unknown value type");
  });

  it("expands nested applications of the same alias without losing unsafe leaves", async () => {
    const diagnostics = await lint(`
      type Identity<Value> = Value;
      type Dictionary<Value> = Record<string, Identity<Value>>;
      declare const values: Dictionary<Identity<unknown>>;
    `);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("unknown value type");
  });

  it("retains safe intersections while detecting any intersections", async () => {
    const diagnostics = await lint(`
      type Dictionary<Value> = Record<string, Value>;
      declare function safe<Value>(values: Dictionary<(Value | unknown) & { id: string }>): void;
      declare function unsafe(values: Dictionary<any & { id: string }>): void;
    `);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("any value type");
  });

  it("terminates recursive aliases while retaining their unsafe union arms", async () => {
    const diagnostics = await lint(`
      type Recursive<Value> = Recursive<Value> | unknown;
      type Dictionary<Value> = Record<string, Recursive<Value>>;
      declare const values: Dictionary<string>;
    `);
    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      expect.stringContaining("union value type"),
      expect.stringContaining("union value type"),
    ]);
  });

  it("resolves dictionary-valued substitutions without conflating parameter scopes", async () => {
    expect(
      await lint(`
        type Identity<Value> = Value;
        type Dictionary<Value> = Readonly<Record<string, Value>>;
        declare function accept<Value>(values: Identity<Dictionary<Value | { id: string }>>): void;
      `)
    ).toEqual([]);
  });

  it("retains broad mapped-key detection after a shadowed parameter", async () => {
    const diagnostics = await lint(`
      type Dictionary<Key extends PropertyKey> = { [Name in Key]: string };
      function create<Key extends PropertyKey>() {
        return { name: "Luca" } as Dictionary<Key | string>;
      }
    `);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("generic container type");
  });
});
