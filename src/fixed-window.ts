/** Table bound shared by the local limiters and the key-check cache. */
const MAX_FIXED_WINDOW_KEYS = 10_000;

type Window = { readonly windowStartedAt: number; count: number };

/**
 * Fixed windows per key, held in this isolate and bounded at
 * {@link MAX_FIXED_WINDOW_KEYS}. When the table is full of live windows it
 * refuses a new key rather than evict one, so a flood of fresh keys cannot
 * reset a live window. Keys are hashes or addresses, never raw secrets.
 */
export type FixedWindowTable = {
  /**
   * Counts one hit on `key` and returns the count in its current window,
   * starting a window when none is live. `undefined` means the table is full
   * of live windows and the key was not admitted.
   */
  readonly charge: (key: string, now: number) => number | undefined;
  /** Whether `key` has a window that has not yet expired. */
  readonly isLive: (key: string, now: number) => boolean;
  readonly size: () => number;
  readonly keys: () => readonly string[];
};

export function createFixedWindowTable(windowMs: number): FixedWindowTable {
  // oxlint-disable-next-line effect/avoid-native-object-helpers -- Evicts windows in insertion order; restarting a key moves it to the end.
  const windows = new Map<string, Window>();

  const live = (key: string, now: number) => {
    const window = windows.get(key);

    return window !== undefined && now - window.windowStartedAt < windowMs
      ? window
      : undefined;
  };

  /**
   * Drops expired windows. A window is re-inserted when it restarts, so Map
   * order is start order and the sweep stops at the first live one.
   */
  const sweepExpired = (now: number) => {
    // oxlint-disable-next-line effect/imperative-loops -- stops at the first live entry, which a combinator cannot express
    for (const [key, window] of windows) {
      if (now - window.windowStartedAt < windowMs) {
        return;
      }

      windows.delete(key);
    }
  };

  return {
    charge: (key, now) => {
      const current = live(key, now);

      if (current !== undefined) {
        current.count += 1;

        return current.count;
      }

      windows.delete(key);

      if (windows.size >= MAX_FIXED_WINDOW_KEYS) {
        sweepExpired(now);
      }

      if (windows.size >= MAX_FIXED_WINDOW_KEYS) {
        return undefined;
      }

      windows.set(key, { windowStartedAt: now, count: 1 });

      return 1;
    },
    isLive: (key, now) => live(key, now) !== undefined,
    size: () => windows.size,
    keys: () => [...windows.keys()],
  };
}
