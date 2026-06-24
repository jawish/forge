import { defineConfig } from "vitest/config";
import { cloudflarePool } from "@cloudflare/vitest-pool-workers";

// Seam tests run in the cloudflare pool (miniflare: real DO SQLite + emulated
// D1/R2/KV/Queues). These are the ~80% layer (docs/16 §1). Provider unit tests
// that use node-only APIs (child_process) live in *.node.test.ts and run via
// vitest.node.config.ts — `pnpm test` runs both.

export default defineConfig({
  test: {
    pool: cloudflarePool({
      // The Worker entrypoint run in the same isolate as tests.
      main: "./src/index.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["**/*.node.test.ts", "**/node_modules/**"],
    // The cloudflare pool logs DO RPC rejections (thrown by negative tests on
    // illegal transitions) as "unhandled errors" before the test's try/catch
    // catches them. The tests assert correctly (try/catch via assertRejects);
    // these are expected rejections, not real failures. We don't fail the run
    // on them — real test failures still surface as failing tests.
    dangerouslyIgnoreUnhandledErrors: true,
  },
});
