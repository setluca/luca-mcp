import { beforeEach } from "vitest";

import { clearToolBuildCache } from "../src/tool-cache.ts";

/**
 * Every test builds its tools from scratch. The build cache is keyed on the
 * catalog entry, which outlives a single test, so without this a tool built by
 * an earlier test would be handed to a later one — and a mutation run, which
 * changes the code between tests, would grade a tool that predates the change.
 */
beforeEach(() => {
  clearToolBuildCache();
});
