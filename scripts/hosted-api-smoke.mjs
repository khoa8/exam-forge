import assert from "node:assert/strict";

const url = process.env.EXAMFORGE_SUPABASE_URL;
const key = process.env.EXAMFORGE_SUPABASE_PUBLISHABLE_KEY;
const a = process.env.EXAMFORGE_TEST_JWT_A;
const b = process.env.EXAMFORGE_TEST_JWT_B;
if (!url || !key || !a || !b) {
  throw new Error("Set the Supabase URL, publishable key, and two disposable test JWTs.");
}
const base = `${url}/functions/v1/examforge`;

async function api(path, token, method = "GET", body) {
  const response = await fetch(base + path, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  return { status: response.status, data };
}

function answerFor(question) {
  if (question.type === "mcq") return { type: "option", optionId: question.options[0].id };
  if (question.type === "truefalse") return { type: "boolean", value: true };
  return { type: "text", text: "synthetic test answer" };
}

function assertNoKey(question) {
  for (const name of ["correctOptionId", "correctAnswer", "acceptedAnswers", "modelAnswer", "keyTerms", "explanation", "evidence", "falseProof"]) {
    assert.equal(Object.hasOwn(question, name), false, `${name} leaked before answer`);
  }
}

const health = await api("/api/health", a);
assert.deepEqual(health, { status: 200, data: { ok: true } });
assert.equal((await api("/api/courses", a, "POST", { text: "x".repeat(500_001) })).status, 413);
const malformed = await fetch(base + "/api/courses", {
  method: "POST", headers: { apikey: key, Authorization: `Bearer ${a}`, "Content-Type": "application/json" },
  body: "{not-json",
});
assert.equal(malformed.status, 400);
assert.equal((await api("/api/courses", b)).status, 200);
const created = await api("/api/courses", a, "POST", { sample: true });
assert.equal(created.status, 201, "bundled course creation");
const courseId = created.data.courseId;
let diagnosticId;
try {
  const listA = await api("/api/courses", a);
  const listB = await api("/api/courses", b);
  assert.ok(listA.data.courses.some((course) => course.id === courseId));
  assert.ok(!listB.data.courses.some((course) => course.id === courseId));
  assert.equal((await api(`/api/courses/${courseId}`, b)).status, 404);
  assert.equal((await api(`/api/courses/${courseId}`, b, "DELETE")).status, 404);
  assert.equal((await api(`/api/courses/${courseId}/sessions`, b, "POST", { kind: "diagnostic" })).status, 404);

  const diagnostic = await api(`/api/courses/${courseId}/sessions`, a, "POST", { kind: "diagnostic" });
  assert.equal(diagnostic.status, 201);
  diagnosticId = diagnostic.data.session.id;
  assert.ok(diagnostic.data.questions.length > 0);
  diagnostic.data.questions.forEach(assertNoKey);
  assert.equal((await api(`/api/sessions/${diagnosticId}`, b)).status, 404);
  assert.equal((await api(`/api/sessions/${diagnosticId}/answer`, b, "POST", {
    questionId: diagnostic.data.questions[0].id,
    answer: answerFor(diagnostic.data.questions[0]),
  })).status, 404);
  assert.equal((await api(`/api/sessions/${diagnosticId}/finish`, b, "POST")).status, 404);

  for (const question of diagnostic.data.questions) {
    const saved = await api(`/api/sessions/${diagnosticId}/answer`, a, "POST", {
      questionId: question.id, answer: answerFor(question),
    });
    assert.equal(saved.status, 200);
    assert.ok(saved.data.grade, "diagnostic feedback is immediate");
  }
  const finishedDiagnostic = await api(`/api/sessions/${diagnosticId}/finish`, a, "POST");
  assert.equal(finishedDiagnostic.status, 200);
  assert.equal(finishedDiagnostic.data.session.status, "completed");

  const practice = await api(`/api/courses/${courseId}/sessions`, a, "POST", { kind: "practice" });
  assert.equal(practice.status, 201);
  assert.ok(practice.data.questions.length > 0);
  const mock = await api(`/api/courses/${courseId}/sessions`, a, "POST", { kind: "mock" });
  assert.equal(mock.status, 201);
  const mockId = mock.data.session.id;
  assert.equal((await api(`/api/courses/${courseId}/sessions`, a, "POST", { kind: "mock" })).status, 409);
  const overview = await api(`/api/courses/${courseId}`, a);
  assert.equal(overview.data.activeMockSession.id, mockId, "active mock resume target");
  assert.equal(mock.data.review, null);
  assert.equal(mock.data.summary, null);
  assert.deepEqual(mock.data.revealed, {});
  mock.data.questions.forEach(assertNoKey);

  const overlap = diagnostic.data.questions.find((q) => mock.data.session.questionIds.includes(q.id));
  if (overlap) {
    const guarded = await api(`/api/sessions/${diagnosticId}`, a);
    assert.ok(guarded.data.withheldQuestionIds.includes(overlap.id));
    assert.equal(guarded.data.summary, null);
    assert.ok(!guarded.data.revealed[overlap.id]);
  }
  for (const question of mock.data.questions) {
    const saved = await api(`/api/sessions/${mockId}/answer`, a, "POST", {
      questionId: question.id, answer: answerFor(question),
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.grade, null, "mock correctness is deferred");
  }
  const activeMock = await api(`/api/sessions/${mockId}`, a);
  assert.deepEqual(activeMock.data.revealed, {});
  assert.equal(activeMock.data.summary, null);
  const finishedMock = await api(`/api/sessions/${mockId}/finish`, a, "POST");
  assert.equal(finishedMock.status, 200);
  assert.equal(finishedMock.data.session.status, "completed");
  assert.ok(finishedMock.data.summary);
  assert.ok(finishedMock.data.review?.length);
  const readiness = await api(`/api/courses/${courseId}`, a);
  assert.equal(readiness.status, 200);
  assert.ok(readiness.data.readiness);
  console.log("Hosted API smoke passed: health, ownership/IDOR, diagnostic, practice, mock isolation and readiness.");
} finally {
  const deleted = await api(`/api/courses/${courseId}`, a, "DELETE");
  assert.equal(deleted.status, 200, "synthetic course cleanup");
  assert.equal((await api(`/api/courses/${courseId}`, a)).status, 404);
  if (diagnosticId) assert.equal((await api(`/api/sessions/${diagnosticId}`, a)).status, 404);
}
