import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect, it } from "vitest";

import { runWithPlatform } from "./platform.ts";

/**
 * The public SetLuca skill lives at `skills/setluca/`, where skills.sh and
 * ClawHub discover it, and again inside the Claude Code plugin, which can't
 * reference files outside its own folder. The copies must not drift.
 */
const skills = await runWithPlatform(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.resolve(import.meta.dirname, "..");

    return {
      published: yield* fs.readFileString(
        path.join(root, "skills/setluca/SKILL.md")
      ),
      plugin: yield* fs.readFileString(
        path.join(root, "plugins/claude/skills/setluca/SKILL.md")
      ),
      internal: yield* fs.readFileString(
        path.join(
          root,
          ".claude/skills/thermo-nuclear-code-quality-review/SKILL.md"
        )
      ),
    };
  })
);

describe("SetLuca skill", () => {
  it("ships the same text in the Claude plugin", () => {
    expect(skills.plugin).toBe(skills.published);
  });

  it("is named setluca in its frontmatter", () => {
    expect(skills.published).toMatch(/^---\nname: setluca\n/);
  });

  it("keeps the internal review skill out of public skill listings", () => {
    const frontmatter = skills.internal.split("\n---")[0] ?? "";

    expect(frontmatter).toContain("metadata:\n  internal: true");
  });
});
