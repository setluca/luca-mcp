import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as R from "effect/Record";
import { assert, describe, expect, it } from "vitest";

import { LUCA_OPERATIONS } from "../src/operations.ts";
import {
  allGrantedApiScopes,
  CAPABILITY_LADDER,
  type LucaCapabilityScope,
  lowestCapabilityScopeFor,
  LUCA_OAUTH_SCOPES,
  NON_TIER_OAUTH_SCOPES,
  OAUTH_CAPABILITY_SCOPES,
  OAUTH_DEFAULT_SCOPE,
  oauthScopeForOperation,
  oauthScopeForTool,
  unknownApiScopes,
} from "../src/scopes.ts";
import { sorted } from "./helpers.ts";
import { runWithPlatform } from "./platform.ts";

/** The ladder, weakest first. Every ordering assertion below reads it. */
const LADDER: readonly LucaCapabilityScope[] = [
  "luca:read",
  "luca:draft",
  "luca:queue_ops",
  "luca:full",
];

function tierScopes(scope: LucaCapabilityScope): readonly string[] {
  return OAUTH_CAPABILITY_SCOPES[scope];
}

/** The scopes a tier adds over the one below it. `luca:read` adds all of its own. */
function addedBy(scope: LucaCapabilityScope): string[] {
  const index = LADDER.indexOf(scope);

  const below = index === 0 ? [] : tierScopes(LADDER[index - 1]!);

  return tierScopes(scope).filter((entry) => !Arr.contains(below, entry));
}

describe("LUCA_OAUTH_SCOPES", () => {
  it("pins the six OAuth scopes clients may request", () => {
    // Pinned rather than derived. This list is a published contract: a client
    // that asked for a scope yesterday must still be able to ask for it today,
    // so adding or removing one has to be a deliberate edit here too.
    expect([...LUCA_OAUTH_SCOPES]).toEqual([
      "luca:read",
      "luca:draft",
      "luca:queue_ops",
      "luca:full",
      "luca:full_content",
      "offline_access",
    ]);
  });

  it("lists no scope twice", () => {
    expect(Arr.dedupe(LUCA_OAUTH_SCOPES)).toHaveLength(
      LUCA_OAUTH_SCOPES.length
    );
  });

  it("is partitioned exactly by the tier scopes and the non-tier scopes", () => {
    const tiers: readonly string[] = R.keys(OAUTH_CAPABILITY_SCOPES);
    const nonTiers: readonly string[] = R.keys(NON_TIER_OAUTH_SCOPES);

    // A scope in neither map is advertised and unexplained: a client can ask
    // for it and no table anywhere says what it grants.
    expect(sorted([...tiers, ...nonTiers])).toEqual(sorted(LUCA_OAUTH_SCOPES));
    expect(tiers.filter((scope) => nonTiers.includes(scope))).toEqual([]);
  });
});

describe("OAUTH_DEFAULT_SCOPE", () => {
  it("names only scopes the server advertises", () => {
    Arr.forEach(OAUTH_DEFAULT_SCOPE.split(" "), (scope) => {
      expect(LUCA_OAUTH_SCOPES).toContain(scope);
    });
  });

  it("stays least-privilege: no lead-visible writes and no verbatim content", () => {
    const requested = OAUTH_DEFAULT_SCOPE.split(" ");

    Arr.forEach(
      ["luca:queue_ops", "luca:full", "luca:full_content"],
      (scope) => {
        expect(Arr.contains(requested, scope)).toBe(false);
      }
    );
  });

  it("is space-separated with no stray whitespace, the shape an OAuth scope param takes", () => {
    expect(OAUTH_DEFAULT_SCOPE).toBe(OAUTH_DEFAULT_SCOPE.trim());
    expect(OAUTH_DEFAULT_SCOPE).not.toMatch(/\s{2,}/);
  });
});

describe("the capability tier ladder", () => {
  it.each(LADDER.slice(1).map((scope, index) => [LADDER[index]!, scope]))(
    "%s is a strict subset of %s",
    (lower, higher) => {
      const above = tierScopes(higher);

      Arr.forEach(tierScopes(lower), (scope) => {
        expect(Arr.contains(above, scope)).toBe(true);
      });

      expect(tierScopes(higher).length).toBeGreaterThan(
        tierScopes(lower).length
      );
    }
  );

  it.each(LADDER)("%s grants no scope twice", (scope) => {
    const granted = tierScopes(scope);
    expect(Arr.dedupe(granted)).toHaveLength(granted.length);
  });

  it.each(LADDER)("%s adds its new scopes in alphabetical order", (scope) => {
    // Keeps a new grant from being appended wherever the diff was smallest,
    // which is how a tier's list stops being scannable.
    const added = addedBy(scope);
    expect(added).toEqual(sorted(added));
  });

  it.each(LADDER)("%s grants only well-formed api scopes", (scope) => {
    Arr.forEach(tierScopes(scope), (granted) => {
      expect(granted).toMatch(/^[a-z_]+:(read|write)$/);
    });
  });

  it("grants nothing but reads at the bottom rung", () => {
    Arr.forEach(tierScopes("luca:read"), (scope) => {
      expect(scope.endsWith(":read")).toBe(true);
    });
  });

  /**
   * The two write scopes with no `:read` counterpart anywhere in the API's
   * vocabulary. An insight and a cadence are both written through their own
   * scope and read back through the resource they attach to, so there is no
   * read to grant. Pinned so a third one has to be argued for here.
   */
  const WRITE_ONLY_SCOPES = ["cadences:write", "insights:write"];

  it("never grants a write without the matching read at the same tier", () => {
    // A key that can write a resource it cannot read produces a tool call that
    // succeeds and then cannot show the coach what it did.
    Arr.forEach(LADDER, (scope) => {
      Arr.forEach(tierScopes(scope), (granted) => {
        if (
          !granted.endsWith(":write") ||
          Arr.contains(WRITE_ONLY_SCOPES, granted)
        ) {
          return;
        }

        expect(tierScopes(scope)).toContain(
          granted.replace(/:write$/, ":read")
        );
      });
    });
  });

  it("has no read scope for the write-only resources, which is why they are exempt", () => {
    // Guards the exemption itself. If a read scope is added later, the loop
    // above must start covering it instead of skipping it.
    Arr.forEach(WRITE_ONLY_SCOPES, (granted) => {
      const read = granted.replace(/:write$/, ":read");
      expect(allGrantedApiScopes()).not.toContain(read);
      expect(tierScopes("luca:full")).toContain(granted);
    });
  });

  it("puts the two egress scopes alone at the top", () => {
    expect(addedBy("luca:full")).toEqual([
      "integrations:write",
      "webhooks:write",
    ]);
  });
});

describe("allGrantedApiScopes", () => {
  it("returns everything luca:full grants", () => {
    expect([...allGrantedApiScopes()]).toEqual([...tierScopes("luca:full")]);
  });

  it("covers every scope any tier grants, because the tiers nest", () => {
    const all = allGrantedApiScopes();

    Arr.forEach(LADDER, (scope) => {
      Arr.forEach(tierScopes(scope), (granted) => {
        expect(Arr.contains(all, granted)).toBe(true);
      });
    });
  });
});

describe("lowestCapabilityScopeFor", () => {
  it.each([
    ["leads:read", "luca:read"],
    ["voice:read", "luca:read"],
    ["leads:write", "luca:draft"],
    ["call_events:write", "luca:draft"],
    ["conversations:write", "luca:queue_ops"],
    ["bookings:write", "luca:queue_ops"],
    ["webhooks:write", "luca:full"],
    ["integrations:write", "luca:full"],
  ])("maps %s to %s", (apiScope, expected) => {
    expect(lowestCapabilityScopeFor(apiScope)).toBe(expected);
  });

  // The scope list is read inside the test rather than at collection, so a
  // broken `allGrantedApiScopes` fails an assertion instead of taking the whole
  // file down before a single case runs.
  it("answers with the lowest tier that grants each scope", () => {
    Arr.forEach(allGrantedApiScopes(), (apiScope) => {
      const answer = lowestCapabilityScopeFor(apiScope);
      expect(answer).toBeDefined();

      // SAFETY: The value comes from this module's own contract, so its shape matches the assertion.
      const index = LADDER.indexOf(answer as LucaCapabilityScope);
      expect(tierScopes(LADDER[index]!)).toContain(apiScope);

      Arr.forEach(LADDER.slice(0, index), (lower) => {
        expect(tierScopes(lower)).not.toContain(apiScope);
      });
    });
  });

  it.each([
    ["a scope no tier grants", "coach:write"],
    ["a verb that does not exist", "leads:delete"],
    ["a capability scope passed by mistake", "luca:read"],
    ["the empty string", ""],
    ["a prefix of a real scope", "leads"],
    ["a real scope with trailing space", "leads:read "],
  ])("returns undefined for %s", (_name, apiScope) => {
    expect(lowestCapabilityScopeFor(apiScope)).toBeUndefined();
  });
});

describe("unknownApiScopes", () => {
  it("reports nothing for the shipped operations", () => {
    // The gate that matters. A non-empty result means an OAuth client cannot
    // reach those tools at any scope, and docs:generate refuses to publish a
    // scope table with that hole in it.
    expect(unknownApiScopes(LUCA_OPERATIONS)).toEqual([]);
  });

  it("reports nothing for no operations at all", () => {
    expect(unknownApiScopes([])).toEqual([]);
  });

  it("reports nothing for an operation that needs no scope", () => {
    expect(unknownApiScopes([{ scopes: [] }])).toEqual([]);
  });

  it("reports the ungranted scope and ignores the granted one beside it", () => {
    expect(
      unknownApiScopes([{ scopes: ["leads:read", "coach:write"] }])
    ).toEqual(["coach:write"]);
  });

  it("reports one entry for a scope several operations need", () => {
    expect(
      unknownApiScopes([
        { scopes: ["coach:write"] },
        { scopes: ["coach:write"] },
        { scopes: ["coach:write", "leads:read"] },
      ])
    ).toEqual(["coach:write"]);
  });

  it("dedupes a scope an operation repeats within its own list", () => {
    expect(
      unknownApiScopes([{ scopes: ["coach:write", "coach:write"] }])
    ).toEqual(["coach:write"]);
  });

  it("sorts the result, so a failure message reads the same on every run", () => {
    expect(
      unknownApiScopes([{ scopes: ["zzz:write", "aaa:write", "mmm:write"] }])
    ).toEqual(["aaa:write", "mmm:write", "zzz:write"]);
  });

  it("collects across operations, not just within one", () => {
    expect(
      unknownApiScopes([{ scopes: ["zzz:write"] }, { scopes: ["aaa:write"] }])
    ).toEqual(["aaa:write", "zzz:write"]);
  });
});

describe("NON_TIER_OAUTH_SCOPES", () => {
  it("covers exactly the two scopes that grant no api scope", () => {
    expect(sorted(R.keys(NON_TIER_OAUTH_SCOPES))).toEqual([
      "luca:full_content",
      "offline_access",
    ]);
  });

  it.each(R.toEntries(NON_TIER_OAUTH_SCOPES))(
    "explains %s in the scope table",
    (_scope, description) => {
      // These two are the scopes a reader is most likely to mistake for a
      // higher tier, so an empty or placeholder description is a real gap.
      expect(description.length).toBeGreaterThan(40);
      expect(description.trim()).toBe(description);
    }
  );

  it("grants no api scope through the tier map", () => {
    Arr.forEach(R.keys(NON_TIER_OAUTH_SCOPES), (scope) => {
      expect(R.keys(OAUTH_CAPABILITY_SCOPES)).not.toContain(scope);
    });
  });
});

/**
 * src/scopes.ts is a hand-written copy. The package builds with plain `tsc`
 * and ships as a self-contained tarball, so it cannot import @luca/schemas or
 * apps/api. Its own comment says to update all three together; nothing checked
 * that until here. These read the other two off disk, which a test can do
 * even though the build cannot.
 */
const mirrors = await runWithPlatform(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repo = path.resolve(import.meta.dirname, "..");

    return {
      schemas: yield* fs.readFileString(
        path.join(repo, "contracts/agent-scope.ts")
      ),
      policy: yield* fs.readFileString(
        path.join(repo, "contracts/public-route-policy.ts")
      ),
    };
  })
);

describe("the hand-copied mirrors", () => {
  /** Every quoted string inside the first `[ ... ]` after `const <name>`. */
  function arrayLiteral(source: string, name: string): string[] {
    const start = source.indexOf(`const ${name}`);

    assert(start !== -1, `${name} not found — the mirror check needs updating`);

    const open = source.indexOf("[", start);
    const close = source.indexOf("\n]", open);
    const body = source.slice(open, close);

    // SAFETY: The value comes from this module's own contract, so its shape matches the assertion.
    return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);
  }

  /** The tier's full grant, resolving the `...LOWER_TIER_SCOPES` spread by hand. */
  function tierFrom(source: string, scope: LucaCapabilityScope): string[] {
    const names: Record<LucaCapabilityScope, string> = {
      "luca:read": "READ_TIER_SCOPES",
      "luca:draft": "DRAFT_TIER_SCOPES",
      "luca:queue_ops": "QUEUE_OPS_TIER_SCOPES",
      "luca:full": "FULL_TIER_SCOPES",
    };

    const index = LADDER.indexOf(scope);
    const own = arrayLiteral(source, names[scope]);

    return index === 0
      ? own
      : [...tierFrom(source, LADDER[index - 1]!), ...own];
  }

  it("advertises the same oauth scopes as @luca/schemas", () => {
    // Compared as a set: the two files list them in a different order, and the
    // order is not part of the contract.
    const mirrored = arrayLiteral(mirrors.schemas, "LUCA_OAUTH_SCOPES");

    expect(sorted(mirrored)).toEqual(sorted(LUCA_OAUTH_SCOPES));
  });

  it("uses the same least-privilege default as @luca/schemas", () => {
    const match = mirrors.schemas.match(/OAUTH_DEFAULT_SCOPE = "([^"]+)"/);

    expect(match?.[1]).toBe(OAUTH_DEFAULT_SCOPE);
  });

  it.each(LADDER)("grants the same api scopes as apps/api for %s", (scope) => {
    expect(sorted(tierScopes(scope))).toEqual(
      sorted(tierFrom(mirrors.policy, scope))
    );
  });
});

describe("CAPABILITY_LADDER", () => {
  it("lists the capability scopes weakest first", () => {
    expect(CAPABILITY_LADDER).toEqual(LADDER);
  });
});

describe("oauthScopeForOperation", () => {
  it("takes the lowest tier granting any one of the route's scopes", () => {
    expect(
      oauthScopeForOperation({
        scopes: ["leads:read", "webhooks:write"],
        requiredScope: { capability: "read" },
      })
    ).toBe("luca:read");
  });

  it("raises the answer to the operation's capability tier", () => {
    expect(
      oauthScopeForOperation({
        scopes: ["leads:read"],
        requiredScope: { capability: "queue_ops" },
      })
    ).toBe("luca:queue_ops");
  });

  it("falls back to luca:full for a scope no tier grants", () => {
    expect(
      oauthScopeForOperation({
        scopes: ["unknown:write"],
        requiredScope: { capability: "read" },
      })
    ).toBe("luca:full");
  });
});

describe("oauthScopeForTool", () => {
  it("needs the highest scope among the operations it composes", () => {
    expect(
      oauthScopeForTool([
        { scopes: ["leads:read"], requiredScope: { capability: "read" } },
        { scopes: ["bookings:write"], requiredScope: { capability: "draft" } },
        { scopes: ["leads:write"], requiredScope: { capability: "draft" } },
      ])
    ).toBe("luca:queue_ops");
  });

  it("needs only luca:read when it composes nothing", () => {
    expect(oauthScopeForTool([])).toBe("luca:read");
  });
});
