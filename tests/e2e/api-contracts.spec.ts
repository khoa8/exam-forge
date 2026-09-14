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
