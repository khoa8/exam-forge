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
 *
 * Answering performs two sequential UI updates: the immediate grade, then the refreshed
 * session view that the progress counter and the navigation control are derived from.
 * The grade alone is therefore not a settled state — a control probed at that moment can
 * change identity before the click lands. Every step below waits for the refreshed counter
 * ("n/N saved") before it acts again, so each click targets the settled control.
 */

const FEEDBACK = /^✓ Correct|^✗ Incorrect|^△ Partially/;
const PROGRESS = /Question \d+ of \d+ · \d+\/\d+ saved/;

interface Progress {
  index: number;
  total: number;
  saved: number;
}

async function progress(page: Page): Promise<Progress> {
  const text = await page.getByText(PROGRESS).textContent();
  const match = text?.match(/Question (\d+) of (\d+) · (\d+)\/(\d+) saved/);
  expect(match).not.toBeNull();
  return { index: Number(match![1]), total: Number(match![2]), saved: Number(match![3]) };
}

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

/**
 * Submit the current question and wait for the refreshed session view — not just for the
 * grade. `saved` is the answer count before this submission.
 */
async function submitAnswer(page: Page, saved: number, total: number) {
  await answerCurrentQuestion(page);
  await page.getByRole("button", { name: /^check answer$/i }).click();
  await expect(page.getByText(FEEDBACK).first()).toBeVisible();
  await expect(page.getByText(`${saved + 1}/${total} saved`)).toBeVisible();
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
  const start = await progress(page);
  const total = start.total;
  expect(start.index).toBe(1);
  expect(start.saved).toBe(0);
  expect(total).toBeGreaterThan(1);

  // 3. Skip Question 1.
  await page.getByRole("button", { name: /skip →/i }).click();
  await expect(page.getByText(/Question 2 of/)).toBeVisible();

  // 4. Reach final question via question navigator.
  const lastNav = page.getByRole("button", { name: `Go to question ${total}` });
  await lastNav.click();
  await expect(page.getByText(`Question ${total} of ${total}`)).toBeVisible();

  // 5. Answer the final question.
  await submitAnswer(page, 0, total);

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
  await submitAnswer(page, 1, total);

  // 10. Complete the remaining unanswered questions (2 … total-1) through the navigator,
  // which is always present and identifies its question by a stable accessible name.
  for (let index = 2; index < total; index++) {
    await page.getByRole("button", { name: `Go to question ${index}` }).click();
    await expect(page.getByText(`Question ${index} of ${total}`)).toBeVisible();
    await submitAnswer(page, index, total);
  }

  // 11. Every question is answered, so completion is now offered and succeeds.
  const finishBtn = page.getByRole("button", { name: /^finish$/i });
  await expect(finishBtn).toBeVisible();
  await expect(page.getByRole("button", { name: /finish & see summary/i })).toBeVisible();
  await finishBtn.click();
  await expect(page.getByText("Diagnostic complete")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("link", { name: /practice your weakest topic/i })).toBeVisible();
});
