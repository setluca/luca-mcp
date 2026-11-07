import { describe, expect, it } from "vitest";

import {
  changelogGaps,
  changelogNotesSince,
  changesSummary,
  surfaceChanges,
} from "../scripts/check-surface-changelog.ts";

const surface = (
  tools: Record<string, { readonly title: string }>,
  version = "1.0.0"
) => ({
  server: { serverInfo: { version } },
  tools,
});

const base = surface({ luca_leads_list: { title: "List leads" } });

describe("surfaceChanges", () => {
  it("doesn't count a version bump as a change", () => {
    expect(
      surfaceChanges(
        base,
        surface({ luca_leads_list: { title: "List leads" } }, "1.0.1")
      ).paths
    ).toEqual([]);
  });

  it("tells added and removed tools from changed ones", () => {
    const changes = surfaceChanges(
      base,
      surface({
        luca_leads_list: { title: "List every lead" },
        luca_leads_get: { title: "Get a lead" },
      })
    );

    expect(changes.added).toEqual(["luca_leads_get"]);
    expect(changes.removed).toEqual([]);
    expect(changes.paths).toContain("tools > luca_leads_list > title");
  });
});

describe("changelogNotesSince", () => {
  const changelog = (unreleased: string) =>
    `# Changelog\n\n## [Unreleased]\n\n${unreleased}\n\n## [1.0.0] - 2026-01-01\n\n- Old entry\n`;

  it("leaves out headings and older entries", () => {
    expect(
      changelogNotesSince(changelog("### Added\n\n- New tool"), "1.0.0")
    ).toBe("- New tool");
  });

  it("is empty when only headings are there", () => {
    expect(changelogNotesSince(changelog("### Added"), "1.0.0")).toBe("");
  });

  it("still counts entries a release pull request moved under its new version", () => {
    expect(
      changelogNotesSince(
        "## [Unreleased]\n\n## [1.1.0] - 2026-02-01\n\n- New tool\n\n## [1.0.0]\n",
        "1.0.0"
      )
    ).toBe("- New tool");
  });

  it("refuses to guess when a heading is missing", () => {
    expect(() => changelogNotesSince("## [Unreleased]\n", "1.0.0")).toThrow(
      "1.0.0"
    );
  });
});

describe("changelogGaps", () => {
  const added = {
    added: ["luca_new"],
    removed: [],
    paths: ["tools > luca_new > title"],
  };

  it("needs an added tool named, as #38's weren't", () => {
    expect(changelogGaps(added, "- Some other entry")).toEqual([
      "luca_new was added or removed, and the changelog doesn't name it",
    ]);
  });

  it("passes once the tool is named", () => {
    expect(changelogGaps(added, "- Added `luca_new`")).toEqual([]);
  });

  it("needs some entry for any other change", () => {
    const changed = {
      added: [],
      removed: [],
      paths: ["tools > luca_a > title"],
    };

    expect(changelogGaps(changed, "")).toEqual([
      "Clients will see changes, and the changelog has no entry",
    ]);
    expect(changelogGaps(changed, "- Reworded a title")).toEqual([]);
  });

  it("has nothing to ask for when nothing changed", () => {
    expect(changelogGaps({ added: [], removed: [], paths: [] }, "")).toEqual(
      []
    );
  });
});

describe("changesSummary", () => {
  it("lists a new tool once, not once per field", () => {
    expect(
      changesSummary(
        {
          added: ["luca_new"],
          removed: [],
          paths: [
            "tools > luca_new > title",
            "tools > luca_new > description",
            "tools > luca_old > title",
          ],
        },
        "mcp-v1.0.0"
      )
    ).toBe(
      "### Changes for clients since mcp-v1.0.0\n- Added `luca_new`\n- Changed `tools > luca_old > title`"
    );
  });

  it("says when nothing changed", () => {
    expect(
      changesSummary({ added: [], removed: [], paths: [] }, "mcp-v1.0.0")
    ).toBe("Nothing a client sees has changed since mcp-v1.0.0.");
  });
});
