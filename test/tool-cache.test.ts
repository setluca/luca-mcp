import { describe, expect, it, vi } from "vitest";

import { buildCache, clearToolBuildCache } from "../src/tool-cache.ts";

describe("buildCache", () => {
  it("builds once per key and hands the same value back after", () => {
    const cache = buildCache<object, string>();
    const key = {};
    const build = vi.fn(() => "built");
    expect(cache.get(key, build)).toBe("built");
    expect(cache.get(key, build)).toBe("built");
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("keys on the entry's identity, not on anything it holds", () => {
    const cache = buildCache<{ id: string }, string>();
    const build = vi.fn((): string => "built");
    cache.get({ id: "same" }, build);
    cache.get({ id: "same" }, build);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("rebuilds after a clear, which is what a mutation run needs", () => {
    // Without this a definition cached under one version of the code would be
    // handed to a test that runs after the code changed underneath it.
    const cache = buildCache<object, number>();
    const key = {};
    let built = 0;
    const build = () => ++built;
    expect(cache.get(key, build)).toBe(1);
    cache.clear();
    expect(cache.get(key, build)).toBe(2);
  });

  it("empties every registered cache at once", () => {
    const first = buildCache<object, number>();
    const second = buildCache<object, number>();
    const key = {};
    let built = 0;
    const build = () => ++built;
    first.get(key, build);
    second.get(key, build);
    clearToolBuildCache();
    expect(first.get(key, build)).toBe(3);
    expect(second.get(key, build)).toBe(4);
  });
});
