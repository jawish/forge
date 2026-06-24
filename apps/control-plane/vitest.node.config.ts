import { defineConfig } from "vitest/config";

// Node-pool unit tests for providers that use node-only APIs (child_process).
// These don't need the Workers runtime (docs/16 §1 — pure unit layer).
// Run via `pnpm test` alongside the cloudflare-pool seam tests.

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.node.test.ts"],
  },
});
