import { expect, test } from "@playwright/test";

/**
 * Production smoke test: the minimum meaningful path against a real production
 * build/start server (started by playwright.prod-smoke.config.ts):
 *   build starts -> health responds -> home loads -> bundled demo enters the
 *   actual learning path (course created, concepts extracted, diagnostic runs)
 *   and hands keyboard focus to the served question.
 * Deterministic local generation; no key and no network.
 */

test("production build: health, home and bundled demo diagnostic", async ({ page }) => {
  test.setTimeout(120_000);

  // 1. Health endpoint responds (server-level readiness is asserted by the
  //    webServer probe; here we verify the payload contract).
  const health = await page.request.get("/api/health");
  expect(health.status()).toBe(200);
  expect(await health.json()).toEqual({ ok: true });

  // 2. Home page loads.
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("adaptive exam coach");

  // 3. Bundled demo material creates a real course.
  await page.getByRole("button", { name: /load bundled demo material/i }).click();
  await page.waitForURL(/\/course\/crs_/);
  await expect(page.getByRole("heading", { name: "Concepts from your material" })).toBeVisible();
  await expect(page.getByText(/\d+ concepts · \d+ questions/)).toBeVisible();

  // 4. The learning path actually starts: a diagnostic question is served.
  await page.getByRole("link", { name: "Diagnostic" }).click();
  await page.getByRole("button", { name: /start diagnostic/i }).click();
  await page.waitForURL(/session=/);
  await expect(page.getByText(/Question 1 of/)).toBeVisible();

  // 5. Starting the session replaces the start control, so focus must land on the
  //    question rather than falling back to <body>. This is asserted against the
  //    production build on purpose: in dev mode React StrictMode re-runs the runner's
  //    focus effect on mount, which masks a regression here.
  await expect(page.locator("body")).not.toBeFocused();
  await expect(page.getByRole("group", { name: "Current question" })).toBeFocused();
});
