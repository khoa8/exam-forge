import { expect, test, type Page } from "@playwright/test";

/**
 * Accessibility coverage for the core learning loop:
 *  - answers and grading are operable with the keyboard only;
 *  - dynamic grading feedback is announced (polite live region);
 *  - errors are announced (role=alert);
 *  - short-answer inputs are labeled;
 *  - the stepper marks the current step.
 * Assessment semantics (grading, answers, timing) are untouched.
 */

const GOOD_TEXT = `# Keyboard Access Notes
Encoding is the process of storing information in memory.
Chunking is grouping information into meaningful units.
Retrieval is the process of getting information back out of memory.
Working memory is the memory system that holds information for active use.
Long-term memory is the relatively permanent store of information.
Recall is retrieving information without strong cues.`;

async function startDiagnostic(page: Page) {
  await page.goto("/");
  await page.getByLabel("Study material").fill(GOOD_TEXT);
  await page.getByRole("button", { name: "Create course" }).click();
  await page.waitForURL(/\/course\/crs_/);
  await page.getByRole("link", { name: "Diagnostic" }).click();
  await page.getByRole("button", { name: /start diagnostic/i }).click();
  await page.waitForURL(/session=/);
  await expect(page.getByText(/Question 1 of/)).toBeVisible();
}

test("answers can be given with the keyboard and feedback is announced", async ({ page }) => {
  await startDiagnostic(page);

  // Keyboard-only answering: focus the first option and activate it with Space.
  const firstOption = page.getByRole("radio").first();
  await firstOption.focus();
  await page.keyboard.press("Space");
  await expect(firstOption).toHaveAttribute("aria-checked", "true");

  // Activate "Check answer" with Enter — grading feedback must be a live region.
  const check = page.getByRole("button", { name: /check answer/i });
  await check.focus();
  await page.keyboard.press("Enter");
  const feedback = page.getByRole("status").filter({ hasText: /✓ Correct|✗ Incorrect|△ Partially/ });
  await expect(feedback.first()).toBeVisible();
});

test("short-answer input is labeled and navigator buttons are accessible", async ({ page }) => {
  await startDiagnostic(page);

  // Navigate forward using the question navigator until a short question appears.
  const shortInput = page.getByLabel("Your answer");
  const navigator = page.getByRole("group", { name: "Question navigator" });
  for (let i = 1; i <= 8; i++) {
    if (await shortInput.isVisible().catch(() => false)) break;
    await navigator.getByRole("button", { name: `Go to question ${i}` }).click();
  }
  await expect(shortInput).toBeVisible();

  // The stepper marks the current step for screen readers.
  const stepLink = page.locator('nav[aria-label="Study workflow"] a[aria-current="step"]');
  await expect(stepLink).toHaveText(/Diagnostic/);
});

test("session errors are announced via role=alert", async ({ page }) => {
  // A missing session id produces an honest, announced error state.
  await page.goto("/course/x/diagnostic?session=ses_missing");
  const alert = page.getByRole("alert").filter({ hasText: /not found/i });
  await expect(alert).toBeVisible({ timeout: 15_000 });
  await expect(alert).toContainText(/not found/i);
});
