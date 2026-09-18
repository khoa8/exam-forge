import { expect, test, type Page } from "@playwright/test";

/**
 * Browser-visible behaviour of the active-mock lifecycle rule:
 * - the Mock step must not offer a second active mock exam, and must point the learner
 *   back to the one already in progress;
 * - course-level mastery/readiness pages must say that the active mock's questions are
 *   excluded, instead of silently presenting concepts as untested.
 *
 * Courses are created through the normal UI (like the other browser specs) so this file
 * does not race the API-contract specs' global course-count assertions.
 */

async function loadDemoCourse(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByRole("button", { name: /load bundled demo material/i }).click();
  await page.waitForURL(/\/course\/crs_/);
  return new URL(page.url()).pathname.split("/")[2];
}

async function startMockExam(page: Page): Promise<string> {
  await page.getByRole("link", { name: "Mock Exam" }).click();
  await page.getByRole("button", { name: /start mock exam/i }).click();
  await page.waitForURL(/session=/);
  return new URL(page.url()).searchParams.get("session")!;
}

test("the mock step resumes the active mock instead of starting a second one", async ({ page }) => {
  test.setTimeout(120_000);
  const courseId = await loadDemoCourse(page);
  const sessionId = await startMockExam(page);
  await expect(page.getByText(/Answer all .* questions to submit/i)).toBeVisible();

  // Opening the Mock step without ?session= must not offer a second active mock.
  await page.goto(`/course/${courseId}/mock`);
  await expect(page.getByRole("button", { name: /start mock exam/i })).toBeDisabled();
  const resume = page.getByRole("link", { name: /resume it/i });
  await expect(resume).toBeVisible();

  // The learner is directed back to the exam already in progress.
  await resume.click();
  await expect(page).toHaveURL(new RegExp(`session=${sessionId}`));
  await expect(page.getByText(/Question 1 of/)).toBeVisible();
});

test("course and readiness pages explain the excluded signals while a mock is active", async ({ page }) => {
  test.setTimeout(120_000);
  const courseId = await loadDemoCourse(page);
  await startMockExam(page);
  const notice = /excluded from mastery and readiness/i;

  await page.goto(`/course/${courseId}`);
  await expect(page.getByRole("heading", { name: "Concepts from your material" })).toBeVisible();
  await expect(page.getByText(notice)).toBeVisible();

  await page.goto(`/course/${courseId}/readiness`);
  await expect(page.getByRole("heading", { name: /Concept mastery/i })).toBeVisible();
  await expect(page.getByText(notice)).toBeVisible();
});

test("the active mock is still recognized while a diagnostic session coexists", async ({ page }) => {
  test.setTimeout(120_000);
  const courseId = await loadDemoCourse(page);
  const mockSessionId = await startMockExam(page);

  // A Diagnostic started after the mock is allowed to coexist and becomes the newest
  // active session, so "is a mock in progress?" cannot be read off the newest session.
  await page.goto(`/course/${courseId}`);
  await page.getByRole("link", { name: "Diagnostic" }).click();
  await page.getByRole("button", { name: /start diagnostic/i }).click();
  await page.waitForURL(/session=/);
  const diagnosticSessionId = new URL(page.url()).searchParams.get("session")!;
  await expect(page.getByText(/Question 1 of/)).toBeVisible();

  // The Mock step must still recognize the mock that is actually in progress.
  await page.goto(`/course/${courseId}/mock`);
  await expect(page.getByRole("button", { name: /start mock exam/i })).toBeDisabled();
  const resume = page.getByRole("link", { name: /resume it/i });
  await expect(resume).toBeVisible();
  await resume.click();
  await expect(page).toHaveURL(new RegExp(`session=${mockSessionId}`));
  await expect(page.getByText(/Answer all .* questions to submit/i)).toBeVisible();

  // Course and readiness pages keep explaining that protected questions are excluded.
  const notice = /excluded from mastery and readiness/i;
  await page.goto(`/course/${courseId}`);
  await expect(page.getByRole("heading", { name: "Concepts from your material" })).toBeVisible();
  await expect(page.getByText(notice)).toBeVisible();

  await page.goto(`/course/${courseId}/readiness`);
  await expect(page.getByRole("heading", { name: /Concept mastery/i })).toBeVisible();
  await expect(page.getByText(notice)).toBeVisible();

  // Coexistence is preserved: the diagnostic is still active and resumable.
  await page.goto(`/course/${courseId}/diagnostic?session=${diagnosticSessionId}`);
  await expect(page.getByText(/Question 1 of/)).toBeVisible();
});
