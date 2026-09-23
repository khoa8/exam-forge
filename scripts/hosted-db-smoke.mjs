import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";

const url = process.env.EXAMFORGE_SUPABASE_URL;
const publicKey = process.env.EXAMFORGE_SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.EXAMFORGE_SUPABASE_SECRET_KEY;
if (!url || !publicKey || !secretKey) {
  throw new Error("Set EXAMFORGE_SUPABASE_URL, EXAMFORGE_SUPABASE_PUBLISHABLE_KEY and EXAMFORGE_SUPABASE_SECRET_KEY.");
}

async function request(path, key, { method = "GET", token, body, headers = {} } = {}) {
  const response = await fetch(url + path, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${token ?? key}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

async function anonymousUser(name) {
  const provided = process.env[`EXAMFORGE_TEST_JWT_${name}`];
  if (provided) {
    const result = await request("/auth/v1/user", publicKey, { token: provided });
    assert.equal(result.status, 200, "supplied test JWT must be valid");
    return { id: result.data.id, token: provided, createdForTest: false };
  }
  const result = await request("/auth/v1/signup", publicKey, { method: "POST", body: {} });
  assert.equal(result.status, 200, "anonymous sign-in must work; with CAPTCHA enabled, provide two test JWTs");
  assert.ok(result.data?.access_token);
  assert.ok(result.data?.user?.id);
  return { id: result.data.user.id, token: result.data.access_token, createdForTest: true };
}

const a = await anonymousUser("A");
const b = await anonymousUser("B");
assert.notEqual(a.id, b.id, "test identities must differ");
const id = randomUUID();
const courseId = `crs_${id}`;
const conceptId = `cpt_${id}`;
const questionIds = [0, 1, 2].map((n) => `q_${id}_${n}`);
const course = {
  id: courseId,
  title: "Synthetic migration smoke course",
  source_type: "bundled",
  material_text: "This is synthetic, redistributable test material. ".repeat(5),
  quality_json: { level: "good", notes: [] },
  created_at: new Date().toISOString(),
};
const concepts = [{ id: conceptId, name: "Synthetic concept", description: "A test concept", evidence_json: ["Synthetic concept"], importance: 0.5, ord: 0 }];
const questionPayloads = [
  { type: "mcq", correctOptionId: "a", options: [{ id: "a", text: "Synthetic answer A" }, { id: "b", text: "Synthetic answer B" }] },
  { type: "short", modelAnswer: "synthetic term", acceptedAnswers: ["synthetic term"] },
  { type: "explanation", modelAnswer: "A synthetic explanation for this probe.", keyTerms: ["synthetic", "probe"] },
];
const questions = questionIds.map((questionId, ord) => ({
  id: questionId, concept_id: conceptId, payload_json: { id: questionId, ...questionPayloads[ord] }, ord,
}));

try {
  const created = await request("/rest/v1/rpc/ef_create_course", secretKey, {
    method: "POST", body: { p_owner_id: a.id, p_course: course, p_concepts: concepts, p_questions: questions },
  });
  assert.equal(created.status, 200, "atomic course creation");
  assert.equal(created.data, courseId);

  const direct = (table, token) => request(`/rest/v1/${table}?select=*`, publicKey, { token });
  assert.ok((await direct("ef_courses", a.token)).status >= 400, "learner direct material reads are disabled");
  assert.ok((await direct("ef_courses", b.token)).status >= 400, "other learner direct reads are disabled");
  const unauthenticated = await direct("ef_courses", undefined);
  assert.ok(unauthenticated.status >= 400 || unauthenticated.data.length === 0,
    "unauthenticated requests cannot read it");
  assert.ok((await direct("ef_concepts", a.token)).status >= 400, "learner direct concept reads are disabled");
  assert.ok((await direct("ef_questions", a.token)).status >= 400, "answer keys have no learner grant");
  assert.ok((await direct("ef_attempts", a.token)).status >= 400, "scores have no learner grant");
  const unauthorisedWrite = await request("/rest/v1/ef_courses", publicKey, { method: "POST", token: b.token, body: course });
  assert.ok(unauthorisedWrite.status >= 400, "direct learner writes are denied");

  const badCourse = { ...course, id: `bad_${id}` };
  const badConcept = { ...concepts[0], id: `bad_concept_${id}` };
  const bad = await request("/rest/v1/rpc/ef_create_course", secretKey, {
    method: "POST",
    body: { p_owner_id: a.id, p_course: badCourse, p_concepts: [badConcept],
      p_questions: questions.map((q, ord) => ({ ...q, id: `bad_q_${id}_${ord}`, concept_id: "missing" })) },
  });
  assert.ok(bad.status >= 400, "invalid child data rolls back the whole course");
  const rolledBack = await request(`/rest/v1/ef_courses?id=eq.${badCourse.id}&select=id`, secretKey);
  assert.deepEqual(rolledBack.data, [], "no half-written course remains");

  const start = (sessionId) => request("/rest/v1/rpc/ef_start_session", secretKey, {
    method: "POST",
    body: { p_owner_id: a.id, p_id: sessionId, p_course_id: courseId, p_kind: "mock",
      p_concept_id: null, p_question_ids: questionIds },
  });
  const candidateIds = [`ses_${randomUUID()}`, `ses_${randomUUID()}`];
  const starts = await Promise.all(candidateIds.map(start));
  assert.deepEqual(starts.map((x) => x.status).sort(), [200, 409], "only one concurrent mock start succeeds");
  const sessionId = candidateIds[starts.findIndex((x) => x.status === 200)];

  const invalidAnswers = [
    { type: "text", text: randomBytes(5000).toString("base64url") },
    { type: "option", optionId: "x".repeat(65) },
    { type: "option", optionId: "not-an-option" },
  ];
  for (const invalid of invalidAnswers) {
    const rejected = await request("/rest/v1/rpc/ef_submit_attempt", secretKey, {
      method: "POST", body: { p_session_id: sessionId, p_question_id: questionIds[0],
        p_answer_json: invalid, p_score: 0, p_correct: false },
    });
    assert.ok(rejected.status >= 400, "RPC rejects invalid answer before persistence");
  }
  const noPartialAttempt = await request(`/rest/v1/ef_attempts?session_id=eq.${sessionId}&select=id`, secretKey);
  assert.equal(noPartialAttempt.data.length, 0, "invalid answers create no attempt");

  const answer = () => request("/rest/v1/rpc/ef_submit_attempt", secretKey, {
    method: "POST", body: { p_session_id: sessionId, p_question_id: questionIds[0],
      p_answer_json: { type: "option", optionId: "b" }, p_score: 0, p_correct: false },
  });
  const answers = await Promise.all([answer(), answer()]);
  assert.deepEqual(answers.map((x) => x.data).sort(), [false, true], "first answer wins under concurrency");
  const attempts = await request(`/rest/v1/ef_attempts?session_id=eq.${sessionId}&select=question_id,score`, secretKey);
  assert.equal(attempts.data.length, 1);
  assert.equal(attempts.data[0].score, 0);

  const oversizedDirect = await request("/rest/v1/ef_attempts", secretKey, { method: "POST", body: {
    session_id: sessionId, course_id: courseId, question_id: questionIds[1], concept_id: conceptId,
    answer_json: { type: "text", text: randomBytes(8000).toString("base64url") }, score: 0, correct: false,
  } });
  assert.ok(oversizedDirect.status >= 400, "table size constraint rejects direct oversized answer");

  const finished = await request("/rest/v1/rpc/ef_finish_session", secretKey, {
    method: "POST", body: { p_session_id: sessionId },
  });
  assert.equal(finished.data, true);
  assert.ok((await answer()).status >= 400, "completed sessions reject new answers");
  const diagnosticId = `ses_${randomUUID()}`;
  const diagnostic = await request("/rest/v1/rpc/ef_start_session", secretKey, {
    method: "POST", body: { p_owner_id: a.id, p_id: diagnosticId, p_course_id: courseId,
      p_kind: "diagnostic", p_concept_id: null, p_question_ids: questionIds },
  });
  assert.equal(diagnostic.status, 200);
  for (const questionId of questionIds.slice(1)) {
    const written = await request("/rest/v1/rpc/ef_submit_attempt", secretKey, { method: "POST", body: {
      p_session_id: diagnosticId, p_question_id: questionId,
      p_answer_json: { type: "text", text: "A synthetic explanation of the probe term." },
      p_score: 0.5, p_correct: false,
    } });
    assert.equal(written.status, 200, "legitimate short and explanation answers persist");
  }
  const race = await Promise.all([
    start(`ses_${randomUUID()}`),
    request("/rest/v1/rpc/ef_submit_attempt", secretKey, {
      method: "POST", body: { p_session_id: diagnosticId, p_question_id: questionIds[0],
        p_answer_json: { type: "option", optionId: "a" }, p_score: 1, p_correct: true },
    }),
  ]);
  assert.equal(race[0].status, 200, "mock start succeeds after first mock completes");
  assert.ok([200, 400].includes(race[1].status), "answer either commits before mock start or is rejected");
  const afterStart = await request("/rest/v1/rpc/ef_submit_attempt", secretKey, {
    method: "POST", body: { p_session_id: diagnosticId, p_question_id: questionIds[1],
      p_answer_json: { type: "option", optionId: "a" }, p_score: 1, p_correct: true },
  });
  assert.ok(afterStart.status >= 400, "active mock protects overlapping diagnostic questions");
  const filler = Array.from({ length: 97 }, () => ({
    id: `ses_${randomUUID()}`, course_id: courseId, kind: "practice", concept_id: conceptId,
    question_ids: questionIds,
  }));
  const filled = await request("/rest/v1/ef_sessions", secretKey, { method: "POST", body: filler });
  assert.equal(filled.status, 201, "synthetic sessions reach the documented course limit");
  const quota = await request("/rest/v1/rpc/ef_start_session", secretKey, { method: "POST", body: {
    p_owner_id: a.id, p_id: `ses_${randomUUID()}`, p_course_id: courseId, p_kind: "practice",
    p_concept_id: conceptId, p_question_ids: questionIds,
  } });
  assert.ok(quota.status >= 400, "RPC refuses the 101st session");
  const sessionCount = await request(`/rest/v1/ef_sessions?course_id=eq.${courseId}&select=id`, secretKey);
  assert.equal(sessionCount.data.length, 100, "quota rejection adds no partial session");
  console.log("Hosted DB smoke passed: owner isolation, protected keys, atomicity, concurrency and lifecycle.");
} finally {
  await request(`/rest/v1/ef_courses?id=eq.${courseId}`, secretKey, { method: "DELETE" });
  for (const user of [a, b]) {
    if (user.createdForTest) await request(`/auth/v1/admin/users/${user.id}`, secretKey, { method: "DELETE" });
  }
}
