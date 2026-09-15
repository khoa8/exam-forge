import { expect, test, type Page } from "@playwright/test";

/**
 * Browser/UI regression test for the diagnostic completion invariant:
 * 1. start diagnostic;
 * 2. skip an earlier question;
 * 3. reach final question;
 * 4. answer it;
 * 5. activate the post-answer navigation action;
 * 6. verify the learner is taken to an unanswered question / remains in active diagnostic;
 * 7. complete the remaining question(s);
 * 8. verify completion succeeds only after all questions are answered.
 */

async function answerCurrentQuestion(page: Page) {
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

test("diagnostic cannot be completed while questions remain unanswered (UI regression)", async ({ page }) => {
  test.setTimeout(120_000);

  // 1. Open home and load bundled demo material.
  await page.goto("/");
  await page.getByRole("button", { name: /load bundled demo material/i }).click();
  await page.waitForURL(/\/course\/crs_/);

  // 2. Start diagnostic session.
  await page.getByRole("link", { name: "Diagnostic" }).click();
  await page.getByRole("button", { name: /start diagnostic/i }).click();
  await page.waitForURL(/session=/);
  await expect(page.getByText(/Question 1 of/)).toBeVisible();

  // Determine total questions in this diagnostic session.
  const progressText = await page.getByText(/Question 1 of \d+/).textContent();
  const match = progressText?.match(/Question 1 of (\d+)/);
  expect(match).not.toBeNull();
  const totalQuestions = parseInt(match![1], 10);
  expect(totalQuestions).toBeGreaterThan(1);

  // 3. Skip Question 1.
  await page.getByRole("button", { name: /skip →/i }).click();
  await expect(page.getByText(/Question 2 of/)).toBeVisible();

  // 4. Reach final question via question navigator.
  const lastNav = page.getByRole("button", { name: `Go to question ${totalQuestions}` });
  await lastNav.click();
  await expect(page.getByText(`Question ${totalQuestions} of ${totalQuestions}`)).toBeVisible();

  // 5. Answer the final question.
  await answerCurrentQuestion(page);
  await page.getByRole("button", { name: /check answer/i }).click();
  await expect(page.getByText(/^✓ Correct|^✗ Incorrect|^△ Partially/).first()).toBeVisible();

  // 6. Verify "Finish" is NOT offered and bottom "Finish & see summary" is NOT visible.
  await expect(page.getByRole("button", { name: /^finish$/i })).not.toBeVisible();
  await expect(page.getByRole("button", { name: /finish & see summary/i })).not.toBeVisible();

  // 7. Verify the navigation action directs the learner to unanswered questions.
  const nextUnansweredBtn = page.getByRole("button", { name: /next unanswered/i });
  await expect(nextUnansweredBtn).toBeVisible();

  // 8. Click "Next unanswered →" and verify return to Question 1 in the active diagnostic.
  await nextUnansweredBtn.click();
  await expect(page.getByText(/Question 1 of/)).toBeVisible();
  await expect(page.getByText("Diagnostic complete")).not.toBeVisible();

  // 9. Answer Question 1.
  await answerCurrentQuestion(page);
  await page.getByRole("button", { name: /check answer/i }).click();
  await expect(page.getByText(/^✓ Correct|^✗ Incorrect|^△ Partially/).first()).toBeVisible();

  // 10. Complete any other remaining unanswered questions.
  for (let step = 0; step < 40; step++) {
    const finishBtn = page.getByRole("button", { name: /^finish$|finish & see summary/i });
    if (await finishBtn.first().isVisible().catch(() => false)) {
      await finishBtn.first().click();
      break;
    }
    const feedback = page.getByText(/^✓ Correct|^✗ Incorrect|^△ Partially/).first();
    if (await feedback.isVisible().catch(() => false)) {
      const next = page.getByRole("button", { name: /next question|next unanswered/i });
      if (await next.isVisible().catch(() => false)) {
        await next.click();
        continue;
      }
    }
    const check = page.getByRole("button", { name: /check answer/i });
    if (await check.isVisible().catch(() => false)) {
      await answerCurrentQuestion(page);
      await check.click();
      await expect(page.getByText(/^✓ Correct|^✗ Incorrect|^△ Partially/).first()).toBeVisible();
      continue;
    }
  }

  // 11. Successful diagnostic completion.
  await expect(page.getByText("Diagnostic complete")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("link", { name: /practice your weakest topic/i })).toBeVisible();
});
