import { defineConfig } from "vitest/config";

// Mutation runs exclude the stdio smoke test (spawns a built-dist subprocess
// that never reflects src mutations) and the network-gated integration suite.
export default defineConfig({
  test: {
    clearMocks: false,
    setupFiles: ["./test/setup.ts"],
    exclude: [
      "**/node_modules/**",
      "test/stdio-smoke.test.ts",
      "test/integration/**",
    ],
  },
});
