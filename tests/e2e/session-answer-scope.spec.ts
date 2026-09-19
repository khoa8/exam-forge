import { expect, test, type Page } from "@playwright/test";
import { holdAnswerRequests } from "./helpers/in-flight-requests";

/**
 * Delayed answer responses must stay associated with the question that produced them.
 *
 * The runner keeps the question navigator usable while an answer save is in flight (only
 * Back/Skip and the answer control are disabled), so a response can land after the learner
 * has moved to another question. Question-specific transient state — grading feedback,
 * evidence, model answer, the saved-answer notice, the post-save focus hand-off — belongs to
 * the answered question and must never be rendered or applied to the question now on screen.
 *
 * Every test below holds the real answer-save request open instead of sleeping, so the
 * interleaving is deterministic rather than timing-dependent.
 */

const GOOD_TEXT = `# Delayed Response Notes
Encoding is the process of storing information in memory.
Chunking is grouping information into meaningful units.
Retrieval is the process of getting information back out of memory.
Working memory is the memory system that holds information for active use.
Long-term memory is the relatively permanent store of information.
Recall is retrieving information without strong cues.`;

const FEEDBACK = /^✓ Correct|^✗ Incorrect|^△ Partially/;
const CORRECTNESS = /✓ Correct|✗ Incorrect|△ Partially correct|Model answer/;
const SAVED_NOTICE = /Answer saved — first answers count/;
const QUESTION_CARD = { role: "group", name: "Current question" } as const;

async function questionTotal(page: Page): Promise<number> {
  const text = await page.getByText(/Question \d+ of \d+/).first().textContent();
  return Number(text?.match(/of (\d+)/)?.[1] ?? 0);
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
  await page.getByPlaceholder(/write your explanation/i).fill(
    "Memory involves encoding, storage and retrieval according to the material.",
  );
}

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

test("a delayed diagnostic answer is not shown as the feedback of another question", async ({ page }) => {
  await startDiagnostic(page);
  const total = await questionTotal(page);
  expect(total).toBeGreaterThan(1);

  // Answer question 1 and hold its save in flight.
  await answerCurrentQuestion(page);
  const held = await holdAnswerRequests(page);
  await page.getByRole("button", { name: /^Check answer$/i }).click();
  await held.reached;

  // The navigator stays usable, so the learner can move to question 2 while the save is pending.
  await page.getByRole("button", { name: "Go to question 2" }).click();
  await expect(page.getByText(/Question 2 of/)).toBeVisible();

  held.release();

  // The refreshed view (progress counter) arrives — but question 1's grade, evidence and
  // model answer must not surface under question 2.
  await expect(page.getByText(`${1}/${total} saved`)).toBeVisible();
  await expect(page.getByText(FEEDBACK)).toHaveCount(0);
  await expect(page.getByText(/Model answer/)).toHaveCount(0);
  await expect(page.getByText(SAVED_NOTICE)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Check answer$/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Next question →$|^Next unanswered →$/ })).toHaveCount(0);

  // Returning to question 1 shows its own saved answer and grading feedback.
  await page.getByRole("button", { name: "Go to question 1" }).click();
  await expect(page.getByText(/Question 1 of/)).toBeVisible();
  await expect(page.getByText(FEEDBACK).first()).toBeVisible();
  await expect(page.getByText(SAVED_NOTICE)).toBeVisible();

  // First-answer-counts: exactly one answer was submitted for question 1.
  expect(held.posts()).toBe(1);
});

test("a delayed mock answer does not move focus off the question on screen", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await page.getByRole("button", { name: /load bundled demo material/i }).click();
  await page.waitForURL(/\/course\/crs_/);
  await page.getByRole("link", { name: "Mock Exam" }).click();
  await page.getByRole("button", { name: /start mock exam/i }).click();
  await page.waitForURL(/session=/);
  await expect(page.getByText(/Question 1 of/)).toBeVisible();
  const total = await questionTotal(page);
  expect(total).toBeGreaterThan(1);

  const card = page.getByRole(QUESTION_CARD.role, { name: QUESTION_CARD.name });

  // Save question 1 and hold the request in flight.
  await answerCurrentQuestion(page);
  const held = await holdAnswerRequests(page);
  await page.getByRole("button", { name: /^Save answer$/i }).click();
  await held.reached;

  // Navigate to question 2 while the save is pending; the learner is now reading question 2.
  await page.getByRole("button", { name: "Go to question 2" }).click();
  await expect(page.getByText(/Question 2 of/)).toBeVisible();
  await expect(card).toBeFocused();

  held.release();
  await expect(page.getByText(`${1}/${total} saved`)).toBeVisible();

  // Deferred correctness stays hidden, the save happened exactly once, and the response must
  // not yank focus away from the question the learner navigated to.
  await expect(page.getByText(CORRECTNESS)).toHaveCount(0);
  await expect(card).toBeFocused();
  expect(held.posts()).toBe(1);

  // Question 1 kept its own saved state.
  await page.getByRole("button", { name: "Go to question 1" }).click();
  await expect(page.getByText(/Question 1 of/)).toBeVisible();
  await expect(page.getByText(SAVED_NOTICE)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Saved/ })).toBeVisible();
  await expect(page.getByText(CORRECTNESS)).toHaveCount(0);
});
