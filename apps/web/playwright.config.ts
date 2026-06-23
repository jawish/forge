import { defineConfig, devices } from "@playwright/test";

// Playwright config for the 5 blocking critical paths (docs/16 §4, checklist §5.28):
// login, create session, view session (WS connects), submit prompt, cancel session.
//
// Runs against the fast profile: `pnpm --filter @forge/control-plane dev` +
// `pnpm --filter @forge/web dev`, then `pnpm --filter @forge/web test:e2e`.
// The web app proxies /api + /ws to the control-plane (localhost:8787).
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // critical paths share session state; serialize
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:8788",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // The web dev server (assumes the control-plane is already running on :8787).
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:8788",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
