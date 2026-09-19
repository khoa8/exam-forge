import { expect, test, type Locator, type Page } from "@playwright/test";
import { holdAnswerRequests } from "./helpers/in-flight-requests";

/**
 * Accessibility coverage for the core learning loop:
 *  - answers and grading are operable with the keyboard only;
 *  - focus stays in the workflow across the session state transitions (start, grade,
 *    question navigation, finish, mock submit) instead of falling back to <body>;
 *  - dynamic grading feedback is announced (polite live region) exactly once per save;
 *  - mock answers announce save/progress without disclosing correctness before submission;
 *  - errors are announced (role=alert);
 *  - short-answer inputs are labeled;
 *  - the stepper marks the current step;
 *  - custom radio groups expose the keyboard model their role promises.
 * Assessment semantics (grading, answers, timing) are untouched.
 */

const GOOD_TEXT = `# Keyboard Access Notes
Encoding is the process of storing information in memory.
Chunking is grouping information into meaningful units.
Retrieval is the process of getting information back out of memory.
Working memory is the memory system that holds information for active use.
Long-term memory is the relatively permanent store of information.
Recall is retrieving information without strong cues.`;

const FEEDBACK = /^✓ Correct|^✗ Incorrect|^△ Partially/;
const CORRECTNESS = /✓ Correct|✗ Incorrect|△ Partially correct|Model answer/;
const QUESTION_CARD = { role: "group", name: "Current question" } as const;
const NAVIGATOR = { role: "group", name: "Question navigator" } as const;

/**
 * Accessible identity of the focused control, or null when focus fell back to <body>.
 * Used with `expect.poll` so it observes settled focus rather than racing the update.
 */
async function focusedControl(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    return el.getAttribute("aria-label") ?? (el.textContent ?? "").trim();
  });
}

/**
 * Move keyboard focus with Tab until `target` is focused. Bounded, so a control that is
 * not reachable by keyboard fails here instead of silently passing.
 */
async function tabTo(page: Page, target: Locator, maxPresses = 30) {
  for (let i = 0; i <= maxPresses; i++) {
    try {
      await expect(target).toBeFocused({ timeout: 100 });
      return;
    } catch {
      await page.keyboard.press("Tab");
    }
  }
  await expect(target).toBeFocused();
}

/** Answer the current question using only the keyboard. */
async function answerWithKeyboard(page: Page) {
  const option = page.getByRole("radio").first();
  if (await option.isVisible().catch(() => false)) {
    await tabTo(page, option);
    await page.keyboard.press("Space");
    await expect(option).toHaveAttribute("aria-checked", "true");
    return;
  }
  const short = page.getByPlaceholder(/type the term/i);
  if (await short.isVisible().catch(() => false)) {
    await tabTo(page, short);
    await page.keyboard.type("memory");
    return;
  }
  await tabTo(page, page.getByPlaceholder(/write your explanation/i));
  await page.keyboard.type("Memory involves encoding, storage and retrieval according to the material.");
}

async function questionTotal(page: Page): Promise<number> {
  const text = await page.getByText(/Question \d+ of \d+/).first().textContent();
  return Number(text?.match(/of (\d+)/)?.[1] ?? 0);
}

/** Number of saved answers shown in the runner's progress line. */
async function savedCount(page: Page): Promise<number> {
  const text = await page.getByText(/Question \d+ of \d+ · \d+\/\d+ saved/).textContent();
  return Number(text?.match(/· (\d+)\/\d+ saved/)?.[1] ?? -1);
}

/**
 * Answer and grade the current question with the keyboard only, then wait for the
 * refreshed session view (the progress counter) rather than just the immediate grade:
 * the grade and the session refresh are two sequential updates, and the navigation
 * control is derived from the refreshed view.
 */
async function gradeWithKeyboard(page: Page) {
  const total = await questionTotal(page);
  const before = await savedCount(page);
  await answerWithKeyboard(page);
  const check = page.getByRole("button", { name: /^Check answer$/i });
  await tabTo(page, check);
  await page.keyboard.press("Enter");
  await expect(page.getByText(FEEDBACK).first()).toBeVisible();
  await expect(page.getByText(`${before + 1}/${total} saved`)).toBeVisible();
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

/** Native enabled state (aria-disabled is a separate, semantic signal). */
function nativelyDisabled(page: Page, target: Locator): Promise<boolean> {
  return target.evaluate((el) => (el as HTMLButtonElement).disabled);
}

/** The current question's answer control, whatever its type (radio group or text entry). */
function answerControl(page: Page): Locator {
  return page.getByRole("radio").first().or(page.getByRole("textbox").first());
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
  const feedback = page.getByRole("status").filter({ hasText: FEEDBACK });
  await expect(feedback.first()).toBeVisible();
});

test("short-answer input is labeled and navigator buttons are accessible", async ({ page }) => {
  await startDiagnostic(page);

  // Navigate forward using the question navigator until a short question appears.
  const shortInput = page.getByLabel("Your answer");
  const navigator = page.getByRole(NAVIGATOR.role, { name: NAVIGATOR.name });
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

test("focus stays in the session across start, grading and question navigation", async ({ page }) => {
  await startDiagnostic(page);

  // Starting the session replaces the start control, so focus must land on the question.
  const card = page.getByRole(QUESTION_CARD.role, { name: QUESTION_CARD.name });
  await expect(card).toBeFocused();
  await expect(page.locator("body")).not.toBeFocused();

  // Answer and grade with the keyboard only.
  await answerWithKeyboard(page);
  const check = page.getByRole("button", { name: /^Check answer$/i });
  await tabTo(page, check);
  await page.keyboard.press("Enter");
  await expect(page.getByText(FEEDBACK).first()).toBeVisible();

  // Grading replaces the activated control with the next-question control in place, so
  // focus is retained on the control the learner would use next.
  const advance = page.getByRole("button", { name: /^Next question →$|^Next unanswered →$/ });
  await expect(advance).toBeFocused();

  // Advancing returns focus to the (new) question card.
  await page.keyboard.press("Enter");
  await expect(card).toBeFocused();

  // The navigator is keyboard operable; jumping away and back to a still-unanswered
  // question keeps focus on the question card.
  const total = await questionTotal(page);
  expect(total).toBeGreaterThan(2);
  const navigator = page.getByRole(NAVIGATOR.role, { name: NAVIGATOR.name });
  await tabTo(page, navigator.getByRole("button", { name: `Go to question ${total}` }));
  await page.keyboard.press("Enter");
  await expect(page.getByText(`Question ${total} of ${total}`)).toBeVisible();
  await expect(card).toBeFocused();

  await tabTo(page, navigator.getByRole("button", { name: "Go to question 2" }));
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Question 2 of/)).toBeVisible();
  await expect(card).toBeFocused();
});

test("keyboard-only: a full diagnostic can be answered and finished without a pointer", async ({ page }) => {
  test.setTimeout(180_000);
  await startDiagnostic(page);
  const card = page.getByRole(QUESTION_CARD.role, { name: QUESTION_CARD.name });

  // Answer every question with the keyboard, following the control that is offered next.
  for (let guard = 0; guard < 12; guard++) {
    if (await page.getByRole("button", { name: /^Finish$/i }).isVisible().catch(() => false)) break;

    if (!(await page.getByText(FEEDBACK).first().isVisible().catch(() => false))) {
      await gradeWithKeyboard(page);
    }
    // Answering the final question replaces the navigation control with "Finish".
    if (await page.getByRole("button", { name: /^Finish$/i }).isVisible().catch(() => false)) break;

    const advance = page.getByRole("button", { name: /^Next question →$|^Next unanswered →$/ });
    await tabTo(page, advance);
    await page.keyboard.press("Enter");
    await expect(card).toBeFocused();
  }

  const finish = page.getByRole("button", { name: /^Finish$/i });
  await tabTo(page, finish);
  await page.keyboard.press("Enter");

  // Finishing replaces the runner, so focus moves to the results heading.
  await expect(page.getByText("Diagnostic complete")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Diagnostic complete" })).toBeFocused();
  await expect(page.locator("body")).not.toBeFocused();

  // The next step is reachable from there with the keyboard alone.
  const nextStep = page.getByRole("link", { name: /practice your weakest topic/i });
  await tabTo(page, nextStep);
  await expect(nextStep).toBeFocused();
});

test("keyboard-only: mock answers save without disclosing correctness, then submit reveals results", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await page.getByRole("button", { name: /load bundled demo material/i }).click();
  await page.waitForURL(/\/course\/crs_/);
  await page.getByRole("link", { name: "Mock Exam" }).click();
  const start = page.getByRole("button", { name: /start mock exam/i });
  await start.focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(/session=/);
  await expect(page.getByText(/Question 1 of/)).toBeVisible();

  const card = page.getByRole(QUESTION_CARD.role, { name: QUESTION_CARD.name });
  await expect(card).toBeFocused();

  // Answer every mock question with the keyboard. Saving locks the question, so focus is
  // handed to the next unanswered question instead of falling back to <body>.
  for (let guard = 0; guard < 12; guard++) {
    const submit = page.getByRole("button", { name: /submit exam & see results/i });
    if (await submit.isEnabled().catch(() => false)) break;

    // The runner starts on the first question; after each save it hands focus to the
    // navigator button of the next unanswered question. Activating that with Enter moves
    // focus onto the question card.
    if ((await focusedControl(page))?.startsWith("Go to question")) {
      await page.keyboard.press("Enter");
    }
    await expect(card).toBeFocused();

    await answerWithKeyboard(page);
    const save = page.getByRole("button", { name: /^Save answer$/i });
    await tabTo(page, save);
    await page.keyboard.press("Enter");
    await expect(page.getByText(/Answer saved — first answers count/i)).toBeVisible();

    // Saving is announced once, and no correctness, answer key or explanation is disclosed.
    await expect(page.getByRole("status")).toHaveCount(1);
    await expect(page.getByText(CORRECTNESS)).toHaveCount(0);
    await expect(page.getByText(/Review every question/)).toHaveCount(0);
    await expect
      .poll(() => focusedControl(page))
      .toMatch(/^Go to question \d+$|^Submit exam & see results$/);
  }

  // Nothing about correctness exists in the document before submission.
  await expect(page.getByText(CORRECTNESS)).toHaveCount(0);

  const submit = page.getByRole("button", { name: /submit exam & see results/i });
  await tabTo(page, submit);
  await page.keyboard.press("Enter");

  // Submitting replaces the runner, so focus moves to the results heading, and only now
  // does the deferred feedback become available.
  await expect(page.getByText("Mock exam results")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Mock exam results" })).toBeFocused();
  await expect(page.locator("body")).not.toBeFocused();
  await expect(page.getByText(/Review every question/)).toBeVisible();
  await expect(page.getByText(FEEDBACK).first()).toBeVisible();
});

test("immediate grading feedback is announced once, not through competing live regions", async ({ page }) => {
  await startDiagnostic(page);
  await answerWithKeyboard(page);
  const check = page.getByRole("button", { name: /^Check answer$/i });
  await tabTo(page, check);
  await page.keyboard.press("Enter");
  await expect(page.getByText(FEEDBACK).first()).toBeVisible();

  // One save produces exactly one polite announcement: the grading feedback.
  const statuses = page.getByRole("status");
  await expect(statuses).toHaveCount(1);
  await expect(statuses.first()).toHaveText(FEEDBACK);
  await expect(page.getByText(/Answer saved — first answers count/i)).toBeVisible();
});

test("an in-flight diagnostic save keeps focus and reports that it is unavailable", async ({ page }) => {
  await startDiagnostic(page);
  await answerWithKeyboard(page);

  const check = page.getByRole("button", { name: /^Check answer$/i });
  await tabTo(page, check);
  await expect(check).toHaveAttribute("aria-disabled", "false");
  expect(await nativelyDisabled(page, check)).toBe(false);

  const held = await holdAnswerRequests(page);
  await page.keyboard.press("Enter");
  await held.reached;
  // `busy` is rendered: the answer control is disabled while the request is in flight.
  await expect(answerControl(page)).toBeDisabled();

  // The activated control keeps focus and stays natively enabled, so removing the
  // in-flight disabling does not reintroduce the focus-loss regression...
  await expect(check).toBeFocused();
  expect(await nativelyDisabled(page, check)).toBe(false);
  // ...but it no longer advertises itself as actionable while activation is ignored.
  await expect(check).toHaveAttribute("aria-disabled", "true");

  // A repeated keyboard activation reaches the control and is ignored: no second POST.
  await page.keyboard.press("Enter");
  await expect.poll(() => held.posts()).toBe(1);

  held.release();
  await expect(page.getByText(FEEDBACK).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /^Next question →$|^Next unanswered →$/ })).toBeFocused();
  expect(held.posts()).toBe(1);
});

test("an in-flight mock save keeps focus, reports unavailable and still hides correctness", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /load bundled demo material/i }).click();
  await page.waitForURL(/\/course\/crs_/);
  await page.getByRole("link", { name: "Mock Exam" }).click();
  await page.getByRole("button", { name: /start mock exam/i }).click();
  await page.waitForURL(/session=/);
  await expect(page.getByText(/Question 1 of/)).toBeVisible();
  await answerWithKeyboard(page);

  const save = page.getByRole("button", { name: /^Save answer$/i });
  await tabTo(page, save);
  await expect(save).toHaveAttribute("aria-disabled", "false");

  const held = await holdAnswerRequests(page);
  await page.keyboard.press("Enter");
  await held.reached;
  await expect(answerControl(page)).toBeDisabled();

  await expect(save).toBeFocused();
  expect(await nativelyDisabled(page, save)).toBe(false);
  await expect(save).toHaveAttribute("aria-disabled", "true");

  await page.keyboard.press("Enter");
  await expect.poll(() => held.posts()).toBe(1);
  // Deferred feedback stays deferred while the save is in flight.
  await expect(page.getByText(CORRECTNESS)).toHaveCount(0);

  held.release();
  await expect(page.getByText(/Answer saved — first answers count/i)).toBeVisible();
  await expect(page.getByText(CORRECTNESS)).toHaveCount(0);
  expect(held.posts()).toBe(1);
  // Focus continues to the next unanswered question, as the runner intends after a save.
  await expect.poll(() => focusedControl(page)).toMatch(/^Go to question \d+$|^Submit exam & see results$/);
});

test("a failed answer save restores the control and announces the error", async ({ page }) => {
  await startDiagnostic(page);
  await answerWithKeyboard(page);

  const check = page.getByRole("button", { name: /^Check answer$/i });
  await tabTo(page, check);

  await page.route("**/api/sessions/*/answer", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Simulated answer failure" }),
    }),
  );
  await page.keyboard.press("Enter");

  // The failure is announced, and the control becomes actionable again for a retry.
  await expect(page.getByRole("alert").filter({ hasText: /Simulated answer failure/ })).toBeVisible();
  await expect(check).toBeFocused();
  await expect(check).toHaveAttribute("aria-disabled", "false");
  expect(await nativelyDisabled(page, check)).toBe(false);
});

test("custom radio groups expose the keyboard model their role promises", async ({ page }) => {
  await startDiagnostic(page);

  const options = page.getByRole("radio");
  const count = await options.count();
  expect(count).toBeGreaterThan(1);

  // Roving tabindex: only one option is in the tab order.
  const tabIndexes = await options.evaluateAll((els) => els.map((el) => el.getAttribute("tabindex")));
  expect(tabIndexes.filter((t) => t === "0")).toHaveLength(1);
  expect(tabIndexes.filter((t) => t === "-1")).toHaveLength(count - 1);

  // Arrow keys move focus and selection within the group, as a radio group should.
  await options.first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(options.nth(1)).toBeFocused();
  await expect(options.nth(1)).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("ArrowUp");
  await expect(options.first()).toBeFocused();
  await expect(options.first()).toHaveAttribute("aria-checked", "true");

  // The selection indicator is decorative: the accessible name is the option text.
  await expect(options.first()).toHaveAccessibleName(/^[A-Za-z]/);
  await expect(options.first()).not.toHaveAccessibleName(/[○●]/);
});
