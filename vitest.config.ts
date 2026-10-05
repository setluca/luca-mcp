import { defineConfig } from "vitest/config";

const coverageDefaults = {
  provider: "v8" as const,
  reporter: ["text", "json-summary", "json", "html"],
  reportsDirectory: "coverage",
  reportOnFailure: true,
  exclude: [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/.wrangler/**",
    "**/*.d.ts",
    "**/*.config.*",
    "**/test/**",
    "**/*.test.*",
  ],
};

export default defineConfig({
  test: {
    clearMocks: false,
    setupFiles: ["./test/setup.ts"],
    server: {
      deps: {
        // Inlined so its `vitest` import resolves through this package, not
        // the copy Bun links it against. With two vitest instances,
        // `it.effect` registers suites the runner never sees.
        inline: ["@effect/vitest"],
      },
    },
    coverage: {
      ...coverageDefaults,
      // `lcov` on top of the shared reporters: it is what external coverage
      // viewers read, and this is the one package published outside the repo.
      reporter: [...coverageDefaults.reporter, "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        ...coverageDefaults.exclude,
        // Generated from apps/api/openapi.json, not hand-written.
        "src/generated/**",
        // The stdio entrypoint: process wiring with no branch to exercise.
        "src/index.ts",
      ],
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 85,
      },
    },
  },
});
