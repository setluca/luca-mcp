import { defineConfig } from "vitest/config";

// Mutation runs exclude the stdio smoke test (spawns a built-dist subprocess
// that never reflects src mutations), the network-gated integration suite, the
// copy of the project Stryker keeps while it runs, and the test that reads the
// source text, which Stryker rewrites in place.
export default defineConfig({
  test: {
    clearMocks: false,
    setupFiles: ["./test/setup.ts"],
    exclude: [
      "**/node_modules/**",
      ".stryker-tmp/**",
      "test/observability-declarations.test.ts",
      "test/stdio-smoke.test.ts",
      "test/integration/**",
    ],
  },
});
