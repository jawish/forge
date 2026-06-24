import { expect, test } from "@playwright/test";

// E2E tests against the DEPLOYED app (https://forge-web-dev.pages.dev).
// These validate the full user experience through a real browser — not just curl.

const WEB = "https://forge-web-dev.pages.dev";

// Slower timeouts for deployed app (network latency).
test.describe.configure({ mode: "serial", timeout: 60_000 });

test.describe("deployed app — full user story validation", () => {
  test("US-0.1: app loads + dashboard renders", async ({ page }) => {
    await page.goto(WEB, { waitUntil: "networkidle" });

    // Title
    await expect(page).toHaveTitle(/Forge/);

    // The "Sessions" heading (the dashboard landing)
    await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();

    // Stat cards should render (even with 0s they show "—")
    await expect(page.getByText("Total", { exact: true })).toBeVisible();

    // The "+ New Session" button
    await expect(page.getByRole("button", { name: /new session/i })).toBeVisible();
  });

  test("US-1.2: create session from web UI", async ({ page }) => {
    await page.goto(WEB, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /new session/i }).click();

    // Composer form appears
    await expect(page.getByRole("heading", { name: "New session" })).toBeVisible();
    await expect(page.getByLabel("Repo")).toBeVisible();
    await expect(page.getByLabel("Prompt")).toBeVisible();

    // Fill the form
    await page.getByLabel("Repo").fill("forge-e2e-browser");
    await page.getByLabel("Prompt").fill("What files are in this repo? List them.");

    // Submit — this should NOT show "Failed to fetch"
    await page.getByRole("button", { name: /start session/i }).click();

    // The session live-stream view should open
    await expect(page.getByRole("heading", { name: "Session" })).toBeVisible({
      timeout: 15_000,
    });
  });

  test("US-1.5: live-stream view shows agent activity", async ({ page }) => {
    await page.goto(WEB, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /new session/i }).click();
    await page.getByLabel("Repo").fill("forge-e2e-stream");
    await page.getByLabel("Prompt").fill("hello, what can you do?");
    await page.getByRole("button", { name: /start session/i }).click();

    // The session view opens
    await expect(page.getByRole("heading", { name: "Session" })).toBeVisible({
      timeout: 15_000,
    });

    // The status indicator should appear (WS connects + sends state_snapshot)
    await expect(page.getByTestId("status")).toBeVisible({ timeout: 20_000 });

    // Wait for status to show something other than "connecting"
    await expect(page.getByTestId("status")).not.toContainText("connecting", { timeout: 20_000 });
  });

  test("US-2.2: code-server link is present", async ({ page }) => {
    await page.goto(WEB, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /new session/i }).click();
    await page.getByLabel("Repo").fill("forge-e2e-code");
    await page.getByLabel("Prompt").fill("test");
    await page.getByRole("button", { name: /start session/i }).click();

    await expect(page.getByRole("heading", { name: "Session" })).toBeVisible({
      timeout: 15_000,
    });

    // The code-server link should be present
    await expect(page.getByRole("link", { name: /code-server/i })).toBeVisible();
  });

  test("US-1.2 cancel: Cancel button works", async ({ page }) => {
    await page.goto(WEB, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /new session/i }).click();
    await page.getByLabel("Repo").fill("forge-e2e-cancel");
    await page.getByLabel("Prompt").fill("test cancel");
    await page.getByRole("button", { name: /start session/i }).click();

    await expect(page.getByRole("heading", { name: "Session" })).toBeVisible({
      timeout: 15_000,
    });

    // Click Cancel
    const cancelBtn = page.getByRole("button", { name: /cancel/i });
    await expect(cancelBtn).toBeVisible();
    await cancelBtn.click();

    // Status should change to cancelled
    await expect(page.getByTestId("status")).toContainText("cancelled", { timeout: 10_000 });
  });

  test("US-5.3: dashboard shows sessions after creating", async ({ page }) => {
    await page.goto(WEB, { waitUntil: "networkidle" });

    // The session table should have rows (we created several sessions above)
    const rows = page.locator("table tbody tr");
    await expect(rows.first()).toBeVisible({ timeout: 10_000 });

    // The stats cards should show numbers
    await expect(page.getByText("Total", { exact: true })).toBeVisible();

    // Click a row → should open the session view
    await rows.first().click();
    await expect(page.getByRole("heading", { name: "Session" })).toBeVisible({
      timeout: 10_000,
    });
  });
});
