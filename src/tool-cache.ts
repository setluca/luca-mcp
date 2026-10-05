import * as Arr from "effect/Array";

/**
 * The build cache behind the tool pipeline, and the one seam that empties it.
 *
 * A tool definition is derived from a catalog entry that never changes, and
 * nothing in the derivation varies by caller. The `LucaApi` requirement stays
 * open, so no layer is captured. The Worker builds a fresh server per request,
 * though, so without a cache every request pays for the same derivation again.
 * Measured on the full surface: about 2ms of a 16ms build. The remaining 14ms
 * is the SDK's own `registerTool`, which cannot be cached because the
 * `McpServer` is per-request.
 *
 * Keyed on the catalog entry's identity, in a `WeakMap`, so a miss takes exactly
 * the path every call took before the cache existed and a discarded catalog is
 * collectable.
 *
 * This lives apart from `tool.ts` so {@link clearToolBuildCache} reads as what
 * it is. Nothing in the server calls it, because an isolate wants its cache
 * warm for its whole life, and inside the pipeline it looked like a dead
 * export.
 */
type Cache<K extends WeakKey, V> = {
  /** The value for this key, built on the first ask and reused after. */
  readonly get: (key: K, build: () => V) => V;
  readonly clear: () => void;
};

function cache<K extends WeakKey, V>(): Cache<K, V> {
  let entries = new WeakMap<K, V>();

  return {
    get: (key, build) => {
      const cached = entries.get(key);

      if (cached !== undefined) {
        return cached;
      }

      const built = build();
      entries.set(key, built);

      return built;
    },
    clear: () => {
      entries = new WeakMap();
    },
  };
}

/**
 * Only the reset of each cache is registered, not the cache itself: a list of
 * caches would have to name a key and value type the entries do not share, and
 * the only thing this module needs from them all is the same nullary call.
 */
const resets: (() => void)[] = [];

/** A cache that {@link clearToolBuildCache} knows how to empty. */
export function buildCache<K extends WeakKey, V>(): Cache<K, V> {
  const created = cache<K, V>();
  resets.push(created.clear);

  return created;
}

/**
 * Drops every build the caches hold. Only tests call this: a definition cached
 * under one version of the code would otherwise be reused after the code
 * changed underneath it, which is exactly what a mutation run does.
 */
export function clearToolBuildCache() {
  Arr.forEach(resets, (reset) => {
    reset();
  });
}
