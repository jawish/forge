import { expect, test } from "@playwright/test";

// The 5 blocking critical paths (docs/16 §4, checklist §5.28).
// Run against the fast profile (mock model, local sandbox). These are the paths
// CI enforces before merge (the e2e-blocking.yml runner). Real model/sandbox
// behavior is staging-only (docs/16 §4).
//
// Prerequisite: the control-plane Worker running on :8787 (the web app proxies
// /api + /ws to it). `pnpm --filter @forge/control-plane dev` first.
//
// The landing view is the session list (docs/07 §4.4). Each test clicks
// "+ New Session" to reach the composer, then submits the form.

test.describe("critical paths (docs/16 §4)", () => {
  // Helper: navigate to the new-session composer from the list landing view.
  async function goToNewSession(page: import("@playwright/test").Page) {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
    await page.getByRole("button", { name: /new session/i }).click();
    await expect(page.getByRole("heading", { name: "New session" })).toBeVisible();
  }

  // 1. LOGIN — the web front door is reachable behind CF Access. In the fast
  // profile CF Access is stubbed (the worker returns a dev user), so "login" is
  // "the app loads + the user is authenticated."
  test("login — web loads behind CF Access (fast: stubbed dev user)", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Forge" })).toBeVisible();
    // The session list (the authenticated landing) is visible.
    await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
  });

  // 2. CREATE SESSION — repo + prompt form submits; a session is created.
  test("create session — repo + prompt submits a session", async ({ page }) => {
    await goToNewSession(page);
    await page.getByLabel("Repo").fill("repo_e2e");
    await page.getByLabel("Prompt").fill("fix the e2e test fixture");
    await page.getByRole("button", { name: /start session/i }).click();
    // The session live-stream view opens (the heading appears).
    await expect(page.getByRole("heading", { name: "Session" })).toBeVisible({ timeout: 15_000 });
  });

  // 3. VIEW SESSION — the live-stream view loads + the WS connects.
  test("view session — live-stream view + WS connects", async ({ page }) => {
    await goToNewSession(page);
    await page.getByLabel("Repo").fill("repo_e2e_view");
    await page.getByLabel("Prompt").fill("explore the repo");
    await page.getByRole("button", { name: /start session/i }).click();
    await expect(page.getByRole("heading", { name: "Session" })).toBeVisible({ timeout: 15_000 });
    // The status indicator renders (the WS pushes a state snapshot on connect).
    await expect(page.getByTestId("status")).toBeVisible({ timeout: 15_000 });
  });

  // 4. SUBMIT PROMPT — a prompt can be sent to a running session.
  test("submit prompt — send a prompt to the session", async ({ page }) => {
    await goToNewSession(page);
    await page.getByLabel("Repo").fill("repo_e2e_prompt");
    await page.getByLabel("Prompt").fill("fix it");
    await page.getByRole("button", { name: /start session/i }).click();
    await expect(page.getByRole("heading", { name: "Session" })).toBeVisible({ timeout: 15_000 });
    // Send a follow-up prompt.
    await page.getByPlaceholder("Send a prompt…").fill("add a test for the fix");
    await page.getByRole("button", { name: "Send" }).click();
    // The prompt echo appears in the log ([you] ...).
    await expect(page.getByText(/you.*add a test for the fix/)).toBeVisible({ timeout: 10_000 });
  });

  // 5. CANCEL SESSION — navigating back returns to the session list.
  test("cancel session — back to session list", async ({ page }) => {
    await goToNewSession(page);
    await page.getByLabel("Repo").fill("repo_e2e_cancel");
    await page.getByLabel("Prompt").fill("fix it");
    await page.getByRole("button", { name: /start session/i }).click();
    await expect(page.getByRole("heading", { name: "Session" })).toBeVisible({ timeout: 15_000 });
    // The "← Back" affordance returns to the session list landing.
    await expect(page.getByRole("button", { name: /back/i })).toBeVisible();
    await page.getByRole("button", { name: /back/i }).click();
    await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
  });
});
