import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { e2eDbPath } from "./helpers/e2e-env";

/**
 * The dashboard's "Next study action" CTA must execute the action the computed NextAction
 * represents: `diagnostic`/`practice`/`mock` start that session kind, while non-session
 * kinds navigate to the destination the action declares. A `review` action used to be
 * coerced into `mock`, so the button labelled "Review topics" silently started a new mock
 * exam (and returned a 409 when one was already in progress).
 *
 * Reaching a `review` next action requires a completed diagnostic and a completed mock with
 * no weak topics left, i.e. every recorded answer must be correct. Answer keys are stripped
 * from every active-session payload by design, so the fixture reads them from the
 * disposable test database (read-only) and answers through the real HTTP API. All
 * assertions below are browser-visible behaviour.
 */

interface PersistedQuestion {
  id: string;
  type: "mcq" | "truefalse" | "short" | "explanation";
  options?: { id: string; text: string }[];
  correctOptionId?: string;
  correctAnswer?: boolean;
  modelAnswer?: string;
  keyTerms?: string[];
}

type AnswerValue =
  | { type: "option"; optionId: string }
  | { type: "boolean"; value: boolean }
  | { type: "text"; text: string };

interface SessionViewPayload {
  session: { id: string };
  questions: { id: string }[];
}

interface CourseOverviewPayload {
  readiness: { nextAction: { kind: string; message: string; href: string; conceptId?: string } };
  sessions: { id: string; kind: string; status: string }[];
  activeMockSession: { id: string } | null;
}

/** Answer keys of a course's persisted questions, read from the disposable e2e database. */
function readQuestionKeys(courseId: string): Map<string, PersistedQuestion> {
  const db = new DatabaseSync(e2eDbPath(), { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT id, payload_json FROM questions WHERE course_id = ?")
      .all(courseId) as unknown as { id: string; payload_json: string }[];
    return new Map(rows.map((row) => [row.id, JSON.parse(row.payload_json) as PersistedQuestion]));
  } finally {
    db.close();
  }
}

function correctAnswer(question: PersistedQuestion): AnswerValue {
  switch (question.type) {
    case "mcq":
      return { type: "option", optionId: question.correctOptionId! };
    case "truefalse":
      return { type: "boolean", value: question.correctAnswer! };
    default:
      // The model answer plus the grading terms guarantees full key-term coverage.
      return { type: "text", text: [question.modelAnswer ?? "", ...(question.keyTerms ?? [])].join(" ") };
  }
}

function wrongAnswer(question: PersistedQuestion): AnswerValue {
  switch (question.type) {
    case "mcq":
      return { type: "option", optionId: question.options!.find((o) => o.id !== question.correctOptionId)!.id };
    case "truefalse":
      return { type: "boolean", value: !question.correctAnswer };
    default:
      return { type: "text", text: "an unrelated answer that covers none of the ideas" };
  }
}

async function loadDemoCourse(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByRole("button", { name: /load bundled demo material/i }).click();
  await page.waitForURL(/\/course\/crs_/);
  return new URL(page.url()).pathname.split("/")[2];
}

async function overview(request: APIRequestContext, courseId: string): Promise<CourseOverviewPayload> {
  const res = await request.get(`/api/courses/${courseId}`);
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as CourseOverviewPayload;
}

async function startSession(
  request: APIRequestContext,
  courseId: string,
  kind: "diagnostic" | "practice" | "mock",
  conceptId?: string,
): Promise<string> {
  const res = await request.post(`/api/courses/${courseId}/sessions`, { data: { kind, conceptId } });
  expect(res.ok(), `start ${kind} session`).toBeTruthy();
  return ((await res.json()) as { session: { id: string } }).session.id;
}

/** Answer every question of a session through the API, then finish it. */
async function answerAll(
  request: APIRequestContext,
  sessionId: string,
  keys: Map<string, PersistedQuestion>,
  pick: (question: PersistedQuestion) => AnswerValue,
) {
  const viewRes = await request.get(`/api/sessions/${sessionId}`);
  expect(viewRes.ok()).toBeTruthy();
  const view = (await viewRes.json()) as SessionViewPayload;
  for (const question of view.questions) {
    const key = keys.get(question.id);
    expect(key, `answer key for ${question.id}`).toBeDefined();
    const res = await request.post(`/api/sessions/${sessionId}/answer`, {
      data: { questionId: question.id, answer: pick(key!) },
    });
    expect(res.ok(), `answer ${question.id}`).toBeTruthy();
  }
  const finished = await request.post(`/api/sessions/${sessionId}/finish`);
  expect(finished.ok(), `finish ${sessionId}`).toBeTruthy();
}

test("the review next action navigates to readiness instead of starting a mock exam", async ({ page, request }) => {
  test.setTimeout(120_000);
  const courseId = await loadDemoCourse(page);
  const keys = readQuestionKeys(courseId);

  // Fixture: completed diagnostic with every answer correct, so no concept is weak and the
  // computed next action is the mock exam.
  await answerAll(request, await startSession(request, courseId, "diagnostic"), keys, correctAnswer);

  // The mock next action must still start a mock exam, so create it through the CTA.
  await page.goto(`/course/${courseId}`);
  await expect(page.getByText(/take a short mock exam to consolidate/i)).toBeVisible();
  await page.getByRole("button", { name: "Start mock exam" }).click();
  await expect(page).toHaveURL(new RegExp(`/course/${courseId}/mock\\?session=`));
  const mockSessionId = new URL(page.url()).searchParams.get("session")!;

  // Complete the mock correctly: nothing is weak, so the next action becomes `review`.
  await answerAll(request, mockSessionId, keys, correctAnswer);
  const reviewState = await overview(request, courseId);
  expect(reviewState.readiness.nextAction.kind).toBe("review");
  expect(reviewState.readiness.nextAction.href).toBe("readiness");
  expect(reviewState.activeMockSession).toBeNull();
  const mocksBefore = reviewState.sessions.filter((s) => s.kind === "mock").length;

  // The dashboard offers the review action; activating it must perform that action.
  await page.goto(`/course/${courseId}`);
  await expect(page.getByText(reviewState.readiness.nextAction.message)).toBeVisible();
  await page.getByRole("button", { name: "Review topics" }).click();

  await expect(page).toHaveURL(new RegExp(`/course/${courseId}/readiness$`));
  await expect(page.getByRole("heading", { name: /Readiness & next study plan/ })).toBeVisible();

  // It must not have created another mock session.
  const after = await overview(request, courseId);
  expect(after.sessions.filter((s) => s.kind === "mock")).toHaveLength(mocksBefore);
  expect(after.activeMockSession).toBeNull();
});

test("diagnostic and practice next actions still start their session kinds", async ({ page, request }) => {
  test.setTimeout(120_000);
  const courseId = await loadDemoCourse(page);
  const keys = readQuestionKeys(courseId);

  // A fresh course's next action is the diagnostic, and the CTA must start one.
  await expect(page.getByRole("button", { name: "Start diagnostic" })).toBeVisible();
  await page.getByRole("button", { name: "Start diagnostic" }).click();
  await expect(page).toHaveURL(new RegExp(`/course/${courseId}/diagnostic\\?session=`));
  const diagnosticSessionId = new URL(page.url()).searchParams.get("session")!;

  // Deliberately wrong answers leave weak topics, so the next action becomes practice.
  await answerAll(request, diagnosticSessionId, keys, wrongAnswer);
  const practiceState = await overview(request, courseId);
  expect(practiceState.readiness.nextAction.kind).toBe("practice");
  expect(practiceState.readiness.nextAction.conceptId).toBeTruthy();

  await page.goto(`/course/${courseId}`);
  await expect(page.getByRole("button", { name: "Start practice" })).toBeVisible();
  await page.getByRole("button", { name: "Start practice" }).click();
  await expect(page).toHaveURL(new RegExp(`/course/${courseId}/practice\\?session=`));

  // The practice session targets the concept the computed action selected.
  const practiceSessionId = new URL(page.url()).searchParams.get("session")!;
  const sessionRes = await request.get(`/api/sessions/${practiceSessionId}`);
  const session = (await sessionRes.json()) as { session: { kind: string; conceptId: string | null } };
  expect(session.session.kind).toBe("practice");
  expect(session.session.conceptId).toBe(practiceState.readiness.nextAction.conceptId);
});
