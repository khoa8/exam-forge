import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * Honest API failure contracts at the request boundary:
 *  - malformed client JSON is a 4xx with a safe error body, never a 500;
 *  - syntactically valid JSON with a wrong root shape or field type is a 400
 *    with a safe error body — never a 500, a misrouted 404 or silent coercion;
 *  - malformed/invalid requests mutate no state (no course/session/attempt);
 *  - domain errors (404/409) and valid flows keep their existing behavior.
 */

const INVALID_ROOTS = [null, [], "text", 42, true] as const;

const SAFE_ERROR_PATTERN = /SyntaxError|position \d+|stack|zod/i;

function postJson(request: APIRequestContext, url: string, body: unknown) {
  return request.post(url, {
    headers: { "Content-Type": "application/json" },
    // JSON.stringify produces the literal JSON text for primitive roots too
    // ("null", "42", "true", …), so these are valid-JSON invalid-shape bodies.
    data: JSON.stringify(body),
  });
}

async function expectSafeBadRequest(res: { status: () => number; json: () => Promise<unknown> }) {
  expect(res.status()).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(typeof body.error).toBe("string");
  expect(body.error.length).toBeGreaterThan(0);
  // No stack traces, parser internals or validator dumps are leaked.
  expect(JSON.stringify(body)).not.toMatch(SAFE_ERROR_PATTERN);
  return body;
}

async function createSampleCourse(request: APIRequestContext): Promise<string> {
  const res = await request.post("/api/courses", {
    headers: { "Content-Type": "application/json" },
    data: JSON.stringify({ sample: true }),
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { courseId: string };
  return body.courseId;
}

async function startDiagnosticSession(request: APIRequestContext, courseId: string): Promise<string> {
  const res = await request.post(`/api/courses/${courseId}/sessions`, {
    headers: { "Content-Type": "application/json" },
    data: JSON.stringify({ kind: "diagnostic" }),
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { session: { id: string } };
  return body.session.id;
}

async function getCourseSessionIds(request: APIRequestContext, courseId: string): Promise<string[]> {
  const res = await request.get(`/api/courses/${courseId}`);
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { sessions: { id: string }[] };
  return body.sessions.map((s) => s.id);
}

async function getAnsweredCount(request: APIRequestContext, sessionId: string): Promise<number> {
  const res = await request.get(`/api/sessions/${sessionId}`);
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { answeredCount: number };
  return body.answeredCount;
}

test("malformed JSON to POST /api/courses returns 400 without creating a course", async ({ request }) => {
  const before = await request.get("/api/courses");
  const beforeBody = (await before.json()) as { courses: unknown[] };

  const res = await request.post("/api/courses", {
    headers: { "Content-Type": "application/json" },
    data: Buffer.from("{ this is not valid json", "utf-8"),
  });
  expect(res.status()).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error).toMatch(/valid JSON/i);
  // No stack traces or parser internals are leaked.
  expect(JSON.stringify(body)).not.toMatch(SAFE_ERROR_PATTERN);

  const after = await request.get("/api/courses");
  const afterBody = (await after.json()) as { courses: unknown[] };
  expect(afterBody.courses.length).toBe(beforeBody.courses.length);
});

test("malformed JSON to POST /api/sessions/[id]/answer returns 400", async ({ request }) => {
  const res = await request.post("/api/sessions/ses_missing/answer", {
    headers: { "Content-Type": "application/json" },
    data: Buffer.from("not json at all", "utf-8"),
  });
  expect(res.status()).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error).toMatch(/valid JSON/i);
  expect(JSON.stringify(body)).not.toMatch(SAFE_ERROR_PATTERN);
});

test.describe("valid-JSON invalid root shape", () => {
  test("POST /api/courses rejects non-object roots with 400 and creates no course", async ({ request }) => {
    const before = await request.get("/api/courses");
    const beforeBody = (await before.json()) as { courses: unknown[] };

    for (const root of INVALID_ROOTS) {
      const res = await postJson(request, "/api/courses", root);
      const body = await expectSafeBadRequest(res);
      expect(body.error).toMatch(/invalid request body/i);
    }

    const after = await request.get("/api/courses");
    const afterBody = (await after.json()) as { courses: unknown[] };
    expect(afterBody.courses.length).toBe(beforeBody.courses.length);
  });

  test("POST /api/courses/[id]/sessions rejects non-object roots with 400 and creates no session", async ({ request }) => {
    const courseId = await createSampleCourse(request);
    const before = await getCourseSessionIds(request, courseId);

    for (const root of [null, [], 42]) {
      const res = await postJson(request, `/api/courses/${courseId}/sessions`, root);
      const body = await expectSafeBadRequest(res);
      expect(body.error).toMatch(/invalid request body/i);
    }

    expect(await getCourseSessionIds(request, courseId)).toEqual(before);
  });

  test("POST /api/sessions/[id]/answer rejects non-object roots with 400 and records no attempt", async ({ request }) => {
    const courseId = await createSampleCourse(request);
    const sessionId = await startDiagnosticSession(request, courseId);
    expect(await getAnsweredCount(request, sessionId)).toBe(0);

    for (const root of [null, "text", true]) {
      const res = await postJson(request, `/api/sessions/${sessionId}/answer`, root);
      const body = await expectSafeBadRequest(res);
      expect(body.error).toMatch(/invalid request body/i);
    }

    expect(await getAnsweredCount(request, sessionId)).toBe(0);
  });
});

test.describe("wrong request field types", () => {
  test("POST /api/courses rejects wrong field types with 400 and creates no course", async ({ request }) => {
    const before = await request.get("/api/courses");
    const beforeBody = (await before.json()) as { courses: unknown[] };

    // "false" is a truthy string and must not select the bundled sample material.
    await expectSafeBadRequest(await postJson(request, "/api/courses", { sample: "false" }));
    await expectSafeBadRequest(await postJson(request, "/api/courses", { text: ["not", "a", "string"] }));
    await expectSafeBadRequest(await postJson(request, "/api/courses", { title: { bad: true } }));
    await expectSafeBadRequest(await postJson(request, "/api/courses", { text: 12345 }));

    const after = await request.get("/api/courses");
    const afterBody = (await after.json()) as { courses: unknown[] };
    expect(afterBody.courses.length).toBe(beforeBody.courses.length);
  });

  test("POST /api/courses/[id]/sessions rejects wrong field types with 400 and creates no session", async ({ request }) => {
    const courseId = await createSampleCourse(request);
    const before = await getCourseSessionIds(request, courseId);

    await expectSafeBadRequest(await postJson(request, `/api/courses/${courseId}/sessions`, { kind: 123 }));
    await expectSafeBadRequest(await postJson(request, `/api/courses/${courseId}/sessions`, {}));
    await expectSafeBadRequest(
      await postJson(request, `/api/courses/${courseId}/sessions`, { kind: "practice", conceptId: {} }),
    );

    expect(await getCourseSessionIds(request, courseId)).toEqual(before);
  });

  test("POST /api/sessions/[id]/answer rejects wrong field types with 400 and records no attempt", async ({ request }) => {
    const courseId = await createSampleCourse(request);
    const sessionId = await startDiagnosticSession(request, courseId);

    await expectSafeBadRequest(
      await postJson(request, `/api/sessions/${sessionId}/answer`, { questionId: 123, answer: true }),
    );
    await expectSafeBadRequest(
      await postJson(request, `/api/sessions/${sessionId}/answer`, { questionId: "q1" }),
    );
    await expectSafeBadRequest(
      await postJson(request, `/api/sessions/${sessionId}/answer`, {
        questionId: "q1",
        answer: { type: "option", optionId: 123 },
      }),
    );

    expect(await getAnsweredCount(request, sessionId)).toBe(0);
  });
});

test.describe("multipart request handling", () => {
  test("multipart title that is not a string field is rejected with 400", async ({ request }) => {
    const res = await request.post("/api/courses", {
      multipart: {
        // Sent as a file part, so form.get("title") is a File, not a string.
        title: { name: "title.txt", mimeType: "text/plain", buffer: Buffer.from("not a title field") },
        file: { name: "material.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n") },
      },
    });
    const body = await expectSafeBadRequest(res);
    expect(body.error).toMatch(/title/i);
  });

  test("multipart without a file is still rejected with 400 (preserved behavior)", async ({ request }) => {
    const res = await request.post("/api/courses", {
      multipart: { title: "Some title" },
    });
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/No PDF file provided/i);
  });
});

test.describe("domain semantics and valid flows", () => {
  test("valid request shape to a missing course/session keeps the 404 contract", async ({ request }) => {
    const sessionRes = await postJson(request, "/api/courses/crs_missing/sessions", { kind: "diagnostic" });
    expect(sessionRes.status()).toBe(404);

    const answerRes = await postJson(request, "/api/sessions/ses_missing/answer", {
      questionId: "q1",
      answer: { type: "boolean", value: true },
    });
    expect(answerRes.status()).toBe(404);
  });

  test("valid bodies still succeed and the first valid answer counts after invalid attempts", async ({ request }) => {
    const courseId = await createSampleCourse(request);
    const sessionId = await startDiagnosticSession(request, courseId);

    const view = (await (await request.get(`/api/sessions/${sessionId}`)).json()) as {
      answeredCount: number;
      questions: { id: string; type: string; options?: { id: string }[] }[];
    };
    expect(view.answeredCount).toBe(0);
    const question = view.questions[0];
    expect(question).toBeTruthy();

    // Invalid attempts must neither consume the question nor count as the first answer.
    await expectSafeBadRequest(await postJson(request, `/api/sessions/${sessionId}/answer`, null));
    await expectSafeBadRequest(
      await postJson(request, `/api/sessions/${sessionId}/answer`, { questionId: 123, answer: true }),
    );
    expect(await getAnsweredCount(request, sessionId)).toBe(0);

    const answer =
      question.type === "mcq"
        ? { type: "option", optionId: question.options![0].id }
        : question.type === "truefalse"
          ? { type: "boolean", value: true }
          : { type: "text", text: "my best attempt" };
    const answerRes = await postJson(request, `/api/sessions/${sessionId}/answer`, {
      questionId: question.id,
      answer,
    });
    expect(answerRes.status()).toBe(200);
    const answerBody = (await answerRes.json()) as { answeredCount: number };
    expect(answerBody.answeredCount).toBe(1);
    expect(await getAnsweredCount(request, sessionId)).toBe(1);
  });
});

test.describe("F-01 assessment integrity: no answer-bearing topic disclosure via active session API", () => {
  test("active diagnostic and mock session payloads withhold topic from term-recall questions until safe", async ({ request }) => {
    const courseId = await createSampleCourse(request);
    const diagSessionId = await startDiagnosticSession(request, courseId);

    // Fetch initial active diagnostic view via GET /api/sessions/[id]
    const diagRes = await request.get(`/api/sessions/${diagSessionId}`);
    expect(diagRes.status()).toBe(200);
    const diagBody = (await diagRes.json()) as {
      conceptNames?: unknown;
      questions: { id: string; type: string; prompt: string; conceptName?: string }[];
    };

    // Redundant conceptNames map must NOT be present in session view
    expect(diagBody.conceptNames).toBeUndefined();

    // Find short question in the active diagnostic
    const shortQ = diagBody.questions.find((q) => q.type === "short");
    expect(shortQ).toBeDefined();

    // An unanswered short term-recall question must NOT disclose conceptName
    expect(shortQ!.conceptName).toBeUndefined();

    // Ensure serialized representation contains no conceptName property for this unanswered short question
    const serializedShort = JSON.stringify(shortQ);
    expect(serializedShort).not.toContain('"conceptName"');

    // F-01A: Unsafe active short question must NOT expose conceptId or any cross-endpoint join identifier
    expect((shortQ as Record<string, unknown>).conceptId).toBeUndefined();
    expect(serializedShort).not.toContain('"conceptId"');

    // Fetch the course overview endpoint
    const courseRes = await request.get(`/api/courses/${courseId}`);
    expect(courseRes.status()).toBe(200);
    const courseBody = (await courseRes.json()) as {
      concepts: { id: string; name: string; description: string }[];
    };
    expect(courseBody.concepts.length).toBeGreaterThan(0);

    // Cross-endpoint join safety: the active short question cannot be joined to course concepts
    const joinedConcept = courseBody.concepts.find((c) => c.id === (shortQ as Record<string, unknown>).conceptId);
    expect(joinedConcept).toBeUndefined();

    // Course overview itself remains complete and intact
    for (const c of courseBody.concepts) {
      expect(typeof c.id).toBe("string");
      expect(typeof c.name).toBe("string");
      expect(c.name.length).toBeGreaterThan(0);
    }

    // Safe question types (e.g. mcq, truefalse) DO retain their conceptName
    const safeQ = diagBody.questions.find((q) => q.type !== "short");
    expect(safeQ).toBeDefined();
    expect(typeof safeQ!.conceptName).toBe("string");
    expect(safeQ!.conceptName!.length).toBeGreaterThan(0);

    // Active Mock session: topic must remain withheld even after answering until completion
    const mockRes = await request.post(`/api/courses/${courseId}/sessions`, {
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify({ kind: "mock" }),
    });
    expect(mockRes.status()).toBe(201);
    const mockSessionId = ((await mockRes.json()) as { session: { id: string } }).session.id;

    const mockViewRes = await request.get(`/api/sessions/${mockSessionId}`);
    const mockBody = (await mockViewRes.json()) as {
      questions: { id: string; type: string; prompt: string; conceptName?: string }[];
    };
    const mockShortQ = mockBody.questions.find((q) => q.type === "short");
    expect(mockShortQ).toBeDefined();
    expect(mockShortQ!.conceptName).toBeUndefined();
    expect((mockShortQ as Record<string, unknown>).conceptId).toBeUndefined();
    expect(JSON.stringify(mockShortQ)).not.toContain('"conceptId"');

    // Submit answer to the short question in active mock
    const answerRes = await postJson(request, `/api/sessions/${mockSessionId}/answer`, {
      questionId: mockShortQ!.id,
      answer: { type: "text", text: "any attempt" },
    });
    expect(answerRes.status()).toBe(200);
    const answerBody = (await answerRes.json()) as { grade: unknown };
    expect(answerBody.grade).toBeNull();

    // View while mock is active: conceptName is STILL withheld
    const activeMockRes = await request.get(`/api/sessions/${mockSessionId}`);
    const activeMockBody = (await activeMockRes.json()) as {
      questions: { id: string; type: string; conceptName?: string }[];
    };
    const activeMockShort = activeMockBody.questions.find((q) => q.id === mockShortQ!.id)!;
    expect(activeMockShort.conceptName).toBeUndefined();

    // Complete the mock: topic context is now revealed
    const finishRes = await request.post(`/api/sessions/${mockSessionId}/finish`);
    expect(finishRes.status()).toBe(200);
    const finishBody = (await finishRes.json()) as {
      questions: { id: string; type: string; conceptName?: string }[];
      review: { question: { id: string; conceptName: string } }[];
    };
    const finishedMockShort = finishBody.questions.find((q) => q.id === mockShortQ!.id)!;
    expect(typeof finishedMockShort.conceptName).toBe("string");
    expect(finishedMockShort.conceptName!.length).toBeGreaterThan(0);
    expect(finishBody.review).toBeDefined();
    const reviewItem = finishBody.review.find((r) => r.question.id === mockShortQ!.id)!;
    expect(reviewItem.question.conceptName).toBe(finishedMockShort.conceptName);
  });
});

test.describe("F-03 material viability error classification", () => {
  test("POST /api/courses with sufficiently long unstructured text returns 422 with an honest message and creates no course", async ({ request }) => {
    const before = await request.get("/api/courses");
    const beforeBody = (await before.json()) as { courses: unknown[] };

    const unstructured =
      "This is an ordinary story about a quiet day in the countryside. The sun was warm and the breeze was pleasant. " +
      "We took a long walk down the path until we reached the old stone bridge near the river bank.";

    const res = await postJson(request, "/api/courses", { text: unstructured });
    expect(res.status()).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Could not identify any concepts/i);
    expect(body.error).toMatch(/headings and clear definitions/i);

    const after = await request.get("/api/courses");
    const afterBody = (await after.json()) as { courses: unknown[] };
    expect(afterBody.courses.length).toBe(beforeBody.courses.length);
  });

  test("POST /api/courses with headings but insufficient assessment structure returns 422", async ({ request }) => {
    const headingsWithoutDefs =
      "# Plant Water Notes\n\n" +
      "## Osmosis\nOsmosis moves water across a semipermeable membrane toward the region of higher solute concentration.\n\n" +
      "## Turgor\nTurgor pressure keeps soft plant stems firm and upright while the plant stays hydrated.\n\n" +
      "## Wilting\nWilting begins when water loss outpaces root uptake and cells lose their rigidity.\n\n" +
      "## Xylem\nXylem conduits lift water from the roots to the leaves through transpiration pull.";

    const res = await postJson(request, "/api/courses", { text: headingsWithoutDefs });
    expect(res.status()).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/enough grounded assessment structure/i);
  });
});

test.describe("diagnostic completion invariant API contract", () => {
  test("POST /api/sessions/[id]/finish rejects incomplete diagnostic session with 409 Conflict", async ({ request }) => {
    const courseId = await createSampleCourse(request);
    const diagSessionId = await startDiagnosticSession(request, courseId);

    // Initial session view: 0 answered
    const diagViewRes = await request.get(`/api/sessions/${diagSessionId}`);
    expect(diagViewRes.status()).toBe(200);
    const diagView = (await diagViewRes.json()) as {
      answeredCount: number;
      session: { status: string; completedAt: string | null };
      questions: { id: string; type: string; options?: { id: string }[] }[];
    };
    expect(diagView.answeredCount).toBe(0);
    expect(diagView.session.status).toBe("active");
    expect(diagView.session.completedAt).toBeNull();
    const questions = diagView.questions;
    expect(questions.length).toBeGreaterThan(1);

    // 1. Attempt to finish with 0 questions answered -> 409 Conflict
    const earlyFinishRes = await request.post(`/api/sessions/${diagSessionId}/finish`);
    expect(earlyFinishRes.status()).toBe(409);
    const earlyFinishBody = (await earlyFinishRes.json()) as { error: string };
    expect(earlyFinishBody.error).toMatch(/Answer all diagnostic questions before finishing/i);
    expect(JSON.stringify(earlyFinishBody)).not.toMatch(SAFE_ERROR_PATTERN);

    // 2. Answer only the first question
    const q1 = questions[0];
    const answer1 =
      q1.type === "mcq"
        ? { type: "option", optionId: q1.options![0].id }
        : q1.type === "truefalse"
          ? { type: "boolean", value: true }
          : { type: "text", text: "sample answer" };
    const ansRes = await postJson(request, `/api/sessions/${diagSessionId}/answer`, {
      questionId: q1.id,
      answer: answer1,
    });
    expect(ansRes.status()).toBe(200);
    expect(await getAnsweredCount(request, diagSessionId)).toBe(1);

    // 3. Attempt to finish with 1 question answered (incomplete) -> 409 Conflict
    const partialFinishRes = await request.post(`/api/sessions/${diagSessionId}/finish`);
    expect(partialFinishRes.status()).toBe(409);
    const partialFinishBody = (await partialFinishRes.json()) as { error: string };
    expect(partialFinishBody.error).toMatch(/Answer all diagnostic questions before finishing/i);
    expect(JSON.stringify(partialFinishBody)).not.toMatch(SAFE_ERROR_PATTERN);

    // Verify session remains active, answeredCount is unchanged, completedAt is null
    const postRejectViewRes = await request.get(`/api/sessions/${diagSessionId}`);
    const postRejectView = (await postRejectViewRes.json()) as {
      answeredCount: number;
      session: { status: string; completedAt: string | null };
    };
    expect(postRejectView.session.status).toBe("active");
    expect(postRejectView.session.completedAt).toBeNull();
    expect(postRejectView.answeredCount).toBe(1);

    // Verify course overview: diagnostic is active, not completed, nextAction remains diagnostic
    const courseRes = await request.get(`/api/courses/${courseId}`);
    const courseBody = (await courseRes.json()) as {
      sessions: { id: string; status: string; completedAt: string | null }[];
      activeSession: { id: string; kind: string } | null;
      readiness: { nextAction: { kind: string } };
    };
    const sessionListItem = courseBody.sessions.find((s) => s.id === diagSessionId)!;
    expect(sessionListItem.status).toBe("active");
    expect(sessionListItem.completedAt).toBeNull();
    expect(courseBody.activeSession).toEqual({ id: diagSessionId, kind: "diagnostic" });
    expect(courseBody.readiness.nextAction.kind).toBe("diagnostic");

    // 4. Answer remaining questions
    for (let i = 1; i < questions.length; i++) {
      const q = questions[i];
      const ans =
        q.type === "mcq"
          ? { type: "option", optionId: q.options![0].id }
          : q.type === "truefalse"
            ? { type: "boolean", value: true }
            : { type: "text", text: "sample answer" };
      await postJson(request, `/api/sessions/${diagSessionId}/answer`, {
        questionId: q.id,
        answer: ans,
      });
    }

    // 5. Finishing all answered questions succeeds with 200 OK
    const successFinishRes = await request.post(`/api/sessions/${diagSessionId}/finish`);
    expect(successFinishRes.status()).toBe(200);
    const successFinishBody = (await successFinishRes.json()) as {
      session: { status: string; completedAt: string | null };
      summary: { status: string; totalQuestions: number; answered: number };
    };
    expect(successFinishBody.session.status).toBe("completed");
    expect(successFinishBody.session.completedAt).not.toBeNull();
    expect(successFinishBody.summary.answered).toBe(questions.length);

    // Course overview now reflects completed diagnostic and advanced nextAction
    const finalCourseRes = await request.get(`/api/courses/${courseId}`);
    const finalCourseBody = (await finalCourseRes.json()) as {
      sessions: { id: string; status: string; completedAt: string | null }[];
      activeSession: { id: string } | null;
      readiness: { nextAction: { kind: string } };
    };
    expect(finalCourseBody.sessions.find((s) => s.id === diagSessionId)!.status).toBe("completed");
    expect(finalCourseBody.activeSession).toBeNull();
    expect(finalCourseBody.readiness.nextAction.kind).toBe("practice");

    // Idempotent finish call: subsequent finish POST returns 200 with completed session
    const repeatFinishRes = await request.post(`/api/sessions/${diagSessionId}/finish`);
    expect(repeatFinishRes.status()).toBe(200);
  });
});

interface SessionQuestionView {
  id: string;
  type: string;
  options?: { id: string }[];
  conceptName?: string;
  correctOptionId?: unknown;
  correctAnswer?: unknown;
  modelAnswer?: unknown;
  explanation?: unknown;
}

interface SessionViewBody {
  session: { id: string; status: string };
  questions: SessionQuestionView[];
  revealed: Record<string, unknown>;
  withheldQuestionIds: string[];
  review: { question: { id: string } }[] | null;
  summary: { correct: number } | null;
}

async function startSessionOfKind(
  request: APIRequestContext,
  courseId: string,
  kind: "diagnostic" | "practice" | "mock",
  conceptId?: string,
) {
  const res = await postJson(request, `/api/courses/${courseId}/sessions`, { kind, conceptId });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { session: { id: string; questionIds: string[] } }).session;
}

interface CourseOverviewBody {
  concepts: { id: string; mastery: { attempts: number; correct: number; status: string } }[];
  sessions: { id: string; kind: string; status: string }[];
  activeSession: { id: string; kind: string } | null;
}

async function getCourseOverviewBody(request: APIRequestContext, courseId: string): Promise<CourseOverviewBody> {
  const res = await request.get(`/api/courses/${courseId}`);
  expect(res.status()).toBe(200);
  return (await res.json()) as CourseOverviewBody;
}

async function answerEveryQuestion(request: APIRequestContext, sessionId: string, questions: SessionQuestionView[]) {
  for (const q of questions) {
    const res = await postJson(request, `/api/sessions/${sessionId}/answer`, {
      questionId: q.id,
      answer: answerForQuestion(q),
    });
    expect(res.status()).toBe(200);
  }
}

/**
 * A completed Diagnostic followed by a mock that protects at least one of the same
 * persisted questions — the reachable setup for the course-level aggregate question.
 */
async function findCompletedDiagnosticOverlap(request: APIRequestContext) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const courseId = await createSampleCourse(request);
    const diagnostic = await startSessionOfKind(request, courseId, "diagnostic");
    const diagnosticView = await getSessionViewBody(request, diagnostic.id);
    await answerEveryQuestion(request, diagnostic.id, diagnosticView.questions);
    expect((await request.post(`/api/sessions/${diagnostic.id}/finish`)).status()).toBe(200);
    const beforeMock = await getCourseOverviewBody(request, courseId);

    const mock = await startSessionOfKind(request, courseId, "mock");
    const inMock = new Set(mock.questionIds);
    const overlap = diagnostic.questionIds.filter((id) => inMock.has(id));
    if (overlap.length > 0) return { courseId, diagnostic, mock, overlap, beforeMock };
  }
  throw new Error("No reachable completed-diagnostic overlap with a mock exam was reproduced");
}

test.describe("active mock exam lifecycle and course-level signals", () => {
  test("a second active mock for the same course is rejected with 409 and creates no session", async ({ request }) => {
    const courseId = await createSampleCourse(request);
    const mockA = await startSessionOfKind(request, courseId, "mock");

    const second = await postJson(request, `/api/courses/${courseId}/sessions`, { kind: "mock" });
    expect(second.status()).toBe(409);
    const secondBody = (await second.json()) as { error: string };
    expect(secondBody.error).toMatch(/already in progress/i);
    expect(JSON.stringify(secondBody)).not.toMatch(SAFE_ERROR_PATTERN);

    // No second mock row exists, and the first mock is untouched.
    const course = await getCourseOverviewBody(request, courseId);
    expect(course.sessions.filter((s) => s.kind === "mock")).toHaveLength(1);
    expect(course.activeSession).toEqual({ id: mockA.id, kind: "mock" });

    // Diagnostic/Practice may still coexist with the active mock.
    await startSessionOfKind(request, courseId, "diagnostic");

    // The active mock keeps deferred feedback, then a complete post-submit review.
    const mockView = await getSessionViewBody(request, mockA.id);
    const deferred = await postJson(request, `/api/sessions/${mockA.id}/answer`, {
      questionId: mockView.questions[0].id,
      answer: answerForQuestion(mockView.questions[0]),
    });
    expect(deferred.status()).toBe(200);
    expect(((await deferred.json()) as { grade: unknown }).grade).toBeNull();
    await answerEveryQuestion(request, mockA.id, mockView.questions);
    expect((await request.post(`/api/sessions/${mockA.id}/finish`)).status()).toBe(200);
    const finishedA = await getSessionViewBody(request, mockA.id);
    expect(finishedA.session.status).toBe("completed");
    expect(finishedA.withheldQuestionIds).toEqual([]);
    expect(finishedA.review).toHaveLength(mockView.questions.length);
    expect(finishedA.summary).not.toBeNull();

    // A new mock can be started once the previous one is completed.
    const mockB = await startSessionOfKind(request, courseId, "mock");
    expect(mockB.id).not.toBe(mockA.id);
  });

  test("course overview withdraws attempts for protected questions from learner-visible mastery", async ({ request }) => {
    const { courseId, diagnostic, mock, overlap, beforeMock } = await findCompletedDiagnosticOverlap(request);

    // Before the mock: every diagnostic attempt is eligible.
    expect(beforeMock.concepts.reduce((sum, c) => sum + c.mastery.attempts, 0)).toBe(diagnostic.questionIds.length);

    // While the mock is active, the attempts it protects are withdrawn, so the aggregate
    // cannot reveal whether the learner's saved answer for those questions was correct.
    const duringMock = await getCourseOverviewBody(request, courseId);
    expect(duringMock.concepts.reduce((sum, c) => sum + c.mastery.attempts, 0)).toBe(
      diagnostic.questionIds.length - overlap.length,
    );
    expect(duringMock.concepts.some((c) => c.mastery.status === "untested")).toBe(true);

    // Submitting the mock restores the legitimate history plus the mock's own attempts.
    const mockView = await getSessionViewBody(request, mock.id);
    await answerEveryQuestion(request, mock.id, mockView.questions);
    expect((await request.post(`/api/sessions/${mock.id}/finish`)).status()).toBe(200);

    const afterSubmit = await getCourseOverviewBody(request, courseId);
    expect(afterSubmit.concepts.reduce((sum, c) => sum + c.mastery.attempts, 0)).toBe(
      diagnostic.questionIds.length + mock.questionIds.length,
    );
  });
});

async function getSessionViewBody(request: APIRequestContext, sessionId: string): Promise<SessionViewBody> {
  const res = await request.get(`/api/sessions/${sessionId}`);
  expect(res.status()).toBe(200);
  return (await res.json()) as SessionViewBody;
}

function answerForQuestion(q: SessionQuestionView) {
  if (q.type === "mcq") return { type: "option", optionId: q.options![0].id };
  if (q.type === "truefalse") return { type: "boolean", value: true };
  return { type: "text", text: "sample answer" };
}

/**
 * Find a real course whose deterministic sampling gives a mock and a diagnostic a shared
 * question (sampling is seeded on the randomly generated course id, so this is bounded
 * but not guaranteed on the first attempt).
 */
async function findOverlappingMockAndDiagnostic(request: APIRequestContext) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const courseId = await createSampleCourse(request);
    const mock = await startSessionOfKind(request, courseId, "mock");
    const diagnostic = await startSessionOfKind(request, courseId, "diagnostic");
    const inMock = new Set(mock.questionIds);
    const overlap = diagnostic.questionIds.filter((id) => inMock.has(id));
    if (overlap.length > 0) return { courseId, mock, diagnostic, overlappingId: overlap[0] };
  }
  throw new Error("No reachable mock/diagnostic question overlap was reproduced");
}

test.describe("active mock exam isolation API contract", () => {
  test("a concurrent session cannot disclose an active mock exam's answer key", async ({ request }) => {
    const { mock, diagnostic, overlappingId } = await findOverlappingMockAndDiagnostic(request);

    // The other session's view withholds the shared question rather than shipping its key.
    const diagView = await getSessionViewBody(request, diagnostic.id);
    expect(diagView.withheldQuestionIds).toContain(overlappingId);
    expect(diagView.revealed[overlappingId]).toBeUndefined();
    expect(diagView.review).toBeNull();
    const clientQ = diagView.questions.find((q) => q.id === overlappingId)!;
    expect(clientQ).toBeDefined();
    for (const field of ["correctOptionId", "correctAnswer", "modelAnswer", "explanation", "acceptedAnswers", "keyTerms"]) {
      expect(Object.keys(clientQ as Record<string, unknown>)).not.toContain(field);
    }

    // Answering it through the other session is an honest, safe 409 — and records nothing.
    const rejected = await postJson(request, `/api/sessions/${diagnostic.id}/answer`, {
      questionId: overlappingId,
      answer: answerForQuestion(clientQ),
    });
    expect(rejected.status()).toBe(409);
    const rejectedBody = (await rejected.json()) as { error: string };
    expect(rejectedBody.error).toMatch(/active mock exam/i);
    expect(JSON.stringify(rejectedBody)).not.toMatch(SAFE_ERROR_PATTERN);
    expect((await getSessionViewBody(request, diagnostic.id)).revealed[overlappingId]).toBeUndefined();

    // The mock itself still defers feedback and protects its own questions.
    const mockView = await getSessionViewBody(request, mock.id);
    expect(mockView.withheldQuestionIds).toEqual([]);
    expect(mockView.revealed).toEqual({});
    const mockAnswer = await postJson(request, `/api/sessions/${mock.id}/answer`, {
      questionId: overlappingId,
      answer: answerForQuestion(mockView.questions.find((q) => q.id === overlappingId)!),
    });
    expect(mockAnswer.status()).toBe(200);
    expect(((await mockAnswer.json()) as { grade: unknown }).grade).toBeNull();

    // Submitting the mock releases the protection: the question is answerable again.
    for (const q of mockView.questions) {
      await postJson(request, `/api/sessions/${mock.id}/answer`, {
        questionId: q.id,
        answer: answerForQuestion(q),
      });
    }
    expect((await request.post(`/api/sessions/${mock.id}/finish`)).status()).toBe(200);

    const released = await getSessionViewBody(request, diagnostic.id);
    expect(released.withheldQuestionIds).toEqual([]);
    const accepted = await postJson(request, `/api/sessions/${diagnostic.id}/answer`, {
      questionId: overlappingId,
      answer: answerForQuestion(clientQ),
    });
    expect(accepted.status()).toBe(200);
    expect(((await accepted.json()) as { grade: unknown }).grade).not.toBeNull();
  });
});
