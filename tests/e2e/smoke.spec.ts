import { expect, test, type Page } from "@playwright/test";

/**
 * Playwright smoke test: the full no-key user journey in the real UI.
 * Material (bundled sample) -> concepts -> diagnostic (answer + feedback)
 * -> practice -> mock exam -> readiness.
 */

async function answerCurrentQuestion(page: Page) {
  // MCQ and true/false answers are radio groups; the first option works for both.
  const option = page.getByRole("radio").first();
  if (await option.isVisible().catch(() => false)) {
    await option.click();
    return;
  }
  const short = page.getByPlaceholder(/type the term/i);
  if (await short.isVisible().catch(() => false)) {
    await short.fill("memory");
    return;
  }
  const expl = page.getByPlaceholder(/write your explanation/i);
  if (await expl.isVisible().catch(() => false)) {
    await expl.fill("Memory involves encoding, storage and retrieval according to the material.");
  }
}

/** The approved Home privacy disclosure, verbatim. */
const HOME_PRIVACY_NOTE =
  "Privacy note: ExamForge runs entirely on your machine. Concepts, questions and feedback are generated " +
  "locally and deterministically — your material is never sent to an external service.";

test("home shows the approved privacy note and no global footer", async ({ page }) => {
  await page.goto("/");

  // The disclosure stays on the Home page with exactly the approved wording. The whole-text
  // match also guards against re-adding the removed "external AI service" / "no API key is
  // needed" clauses or appending a substitute sentence.
  const privacyNote = page.getByText(/^Privacy note:/);
  await expect(privacyNote).toBeVisible();
  await expect(privacyNote).toHaveText(HOME_PRIVACY_NOTE);

  // The former global footer (privacy + readiness disclaimers) is gone from the root layout.
  await expect(page.locator("footer")).toHaveCount(0);
});

test("bundled demo: material -> diagnostic -> practice -> mock -> readiness", async ({ page }) => {
  test.setTimeout(180_000);

  // 1. Open ExamForge.
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("adaptive exam coach");

  // 2. Load the bundled study material.
  await page.getByRole("button", { name: /load bundled demo material/i }).click();
  await page.waitForURL(/\/course\/crs_/);

  // 3. See grounded extracted concepts.
  await expect(page.getByRole("heading", { name: "Concepts from your material" })).toBeVisible();
  await expect(page.getByText("Encoding", { exact: false }).first()).toBeVisible();
  await expect(page.getByText(/\d+ concepts · \d+ questions/)).toBeVisible();

  // 4. Take the diagnostic quiz with immediate feedback.
  await page.getByRole("link", { name: "Diagnostic" }).click();
  await page.getByRole("button", { name: /start diagnostic/i }).click();
  await page.waitForURL(/session=/);
  await expect(page.getByText(/Question 1 of/)).toBeVisible();

  for (let i = 0; i < 40; i++) {
    const feedback = page.getByText(/^✓ Correct|^✗ Incorrect|^△ Partially/).first();
    if (await feedback.isVisible().catch(() => false)) {
      const next = page.getByRole("button", { name: /next question/i });
      if (await next.isVisible().catch(() => false)) {
        await next.click();
        continue;
      }
      const finishBtn = page.getByRole("button", { name: /finish & see summary/i });
      if (await finishBtn.isVisible().catch(() => false)) {
        await finishBtn.click();
        break;
      }
      continue;
    }
    const check = page.getByRole("button", { name: /check answer/i });
    if (await check.isVisible().catch(() => false)) {
      await answerCurrentQuestion(page);
      await check.click();
      await expect(page.getByText(/^✓ Correct|^✗ Incorrect|^△ Partially/).first()).toBeVisible();
      continue;
    }
    const finishBtn = page.getByRole("button", { name: /finish & see summary/i });
    if (await finishBtn.isVisible().catch(() => false)) {
      await finishBtn.click();
      break;
    }
  }

  // 5. Diagnostic summary.
  await expect(page.getByText("Diagnostic complete")).toBeVisible({ timeout: 20_000 });

  // 6. Practice one weak topic.
  await page.getByRole("link", { name: "Practice", exact: true }).first().click();
  await page.getByRole("button", { name: /start practice/i }).first().click();
  await expect(page.getByText(/Question 1 of/)).toBeVisible({ timeout: 15_000 });

  // 7. Mock exam — no feedback until submit.
  await page.getByRole("link", { name: "Mock Exam" }).click();
  await page.getByRole("button", { name: /start mock exam/i }).click();
  await page.waitForURL(/session=/);
  await expect(page.getByText(/Answer all .* questions to submit/i)).toBeVisible();

  // Answer every mock question via the question navigator, then submit the exam.
  for (let i = 1; i <= 12; i++) {
    const nav = page.getByRole("button", { name: `Go to question ${i}` });
    if (!(await nav.isVisible().catch(() => false))) break;
    await nav.click();
    const saved = await page.getByText(/Answer saved — first answers count/i).isVisible().catch(() => false);
    if (!saved) {
      await answerCurrentQuestion(page);
      await page.getByRole("button", { name: /save answer/i }).click();
      await expect(page.getByText(/Answer saved — first answers count/i)).toBeVisible();
    }
  }
  const submit = page.getByRole("button", { name: /submit exam & see results/i });
  await expect(submit).toBeEnabled({ timeout: 10_000 });
  await submit.click();
  await expect(page.getByText("Mock exam results")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Review every question/)).toBeVisible();

  // 8. Readiness dashboard shows the honest-estimate labelling.
  await page.getByRole("link", { name: "See readiness dashboard →" }).click();
  await expect(page.getByText(/readiness estimate/i).first()).toBeVisible();
  await expect(page.getByText(/not a prediction of your real exam score/i).first()).toBeVisible();
});
