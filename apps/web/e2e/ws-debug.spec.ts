import { expect, test } from "@playwright/test";

// Debug test: capture console + WS errors to understand why status stays "connecting".
const WEB = "https://forge-web-dev.pages.dev";

test("debug: WS connection + console errors", async ({ page }) => {
  const logs: string[] = [];
  const errors: string[] = [];

  page.on("console", (msg) => {
    logs.push(`[${msg.type()}] ${msg.text()}`);
  });
  page.on("pageerror", (err) => {
    errors.push(`[pageerror] ${err.message}`);
  });

  await page.goto(WEB, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /new session/i }).click();
  await page.getByLabel("Repo").fill("forge-ws-debug");
  await page.getByLabel("Prompt").fill("test");
  await page.getByRole("button", { name: /start session/i }).click();

  await expect(page.getByRole("heading", { name: "Session" })).toBeVisible({ timeout: 15_000 });

  // Wait 10s for WS to connect
  await page.waitForTimeout(10_000);

  // Get the status text
  const statusText = await page.getByTestId("status").textContent();
  const logText = await page.locator("[style*='monospace']").textContent();

  console.log("=== STATUS ===");
  console.log(statusText);
  console.log("=== LOG ===");
  console.log(logText);
  console.log("=== CONSOLE LOGS ===");
  for (const l of logs) console.log(l);
  console.log("=== PAGE ERRORS ===");
  for (const e of errors) console.log(e);
});
