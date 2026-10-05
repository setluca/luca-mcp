import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    "CHANGELOG.md",
    "contracts/**",
    "src/generated/**",
    "tools/oxlint/anti-slop/**",
  ],
  proseWrap: "preserve",
  sortTailwindcss: false,
});
