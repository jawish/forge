import { defineConfig } from "vitest/config";

// Pure-logic unit tests for @forge/domain (~15% layer per docs/16_Testing.md §1).
// domain has zero runtime deps except zod + smol-toml; no miniflare here.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // Pass while the suite is empty (skeleton §1); real tests land in §3.
    passWithNoTests: true,
    environment: "node",
  },
});
