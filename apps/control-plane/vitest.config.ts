import { defineConfig } from "vitest/config";
import { cloudflarePool } from "@cloudflare/vitest-pool-workers";

// Seam tests run in the cloudflare pool (miniflare: real DO SQLite + emulated
// D1/R2/KV/Queues). These are the ~80% layer (docs/16 §1). Provider unit tests
// that use node-only APIs (child_process) live in *.node.test.ts and run via
// vitest.node.config.ts — `pnpm test` runs both.

export default defineConfig({
  test: {
    pool: cloudflarePool({
      // The Worker entrypoint run in the same isolate as tests (enables SELF + DO access).
      main: "./src/index.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["**/*.node.test.ts", "**/node_modules/**"],
  },
});
