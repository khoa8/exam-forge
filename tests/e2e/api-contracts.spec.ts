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
