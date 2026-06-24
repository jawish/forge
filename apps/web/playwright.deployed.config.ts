import { defineConfig } from "@playwright/test";

// Config for E2E tests against the DEPLOYED app (not local).
export default defineConfig({
  testDir: "./e2e",
  testMatch: ["deployed.spec.ts", "ws-debug.spec.ts"],
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: [["list"]],
  timeout: 60_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: "https://forge-web-dev.pages.dev",
    headless: true,
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    trace: "on-first-retry",
  },
});
