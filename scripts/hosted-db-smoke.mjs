import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

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
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

async function anonymousUser() {
  const result = await request("/auth/v1/signup", publicKey, { method: "POST", body: {} });
  assert.equal(result.status, 200, "anonymous sign-in must work in the isolated test project");
  assert.ok(result.data?.access_token);
  assert.ok(result.data?.user?.id);
  return { id: result.data.user.id, token: result.data.access_token };
}

const a = await anonymousUser();
const b = await anonymousUser();
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
const questions = questionIds.map((questionId, ord) => ({
  id: questionId,
  concept_id: conceptId,
  payload_json: { id: questionId, type: "mcq", correctOptionId: "a" },
  ord,
}));

try {
  const created = await request("/rest/v1/rpc/ef_create_course", secretKey, {
    method: "POST", body: { p_owner_id: a.id, p_course: course, p_concepts: concepts, p_questions: questions },
  });
  assert.equal(created.status, 200, "atomic course creation");
  assert.equal(created.data, courseId);

  const direct = (table, token) => request(`/rest/v1/${table}?select=*`, publicKey, { token });
  assert.equal((await direct("ef_courses", a.token)).data.length, 1, "owner can read their course");
  assert.equal((await direct("ef_courses", b.token)).data.length, 0, "another learner cannot read it");
  const unauthenticated = await direct("ef_courses", undefined);
  assert.ok(unauthenticated.status >= 400 || unauthenticated.data.length === 0,
    "unauthenticated requests cannot read it");
  assert.equal((await direct("ef_concepts", b.token)).data.length, 0, "concepts are owner-scoped");
  assert.ok((await direct("ef_questions", a.token)).status >= 400, "answer keys have no learner grant");
  assert.ok((await direct("ef_attempts", a.token)).status >= 400, "scores have no learner grant");
  const unauthorisedWrite = await request("/rest/v1/ef_courses", publicKey, { method: "POST", token: b.token, body: course });
  assert.ok(unauthorisedWrite.status >= 400, "direct learner writes are denied");

  const badCourse = { ...course, id: `bad_${id}` };
  const bad = await request("/rest/v1/rpc/ef_create_course", secretKey, {
    method: "POST",
    body: { p_owner_id: a.id, p_course: badCourse, p_concepts: concepts,
      p_questions: questions.map((q) => ({ ...q, concept_id: "missing" })) },
  });
  assert.ok(bad.status >= 400, "invalid child data rolls back the whole course");
  const rolledBack = await request(`/rest/v1/ef_courses?id=eq.${badCourse.id}&select=id`, secretKey);
  assert.deepEqual(rolledBack.data, [], "no half-written course remains");

  const start = () => request("/rest/v1/ef_sessions", secretKey, {
    method: "POST", headers: { Prefer: "return=representation" },
    body: { id: `ses_${randomUUID()}`, course_id: courseId, kind: "mock", question_ids: questionIds },
  });
  const starts = await Promise.all([start(), start()]);
  assert.deepEqual(starts.map((x) => x.status).sort(), [201, 409], "only one concurrent mock start succeeds");
  const sessionId = starts.find((x) => x.status === 201).data[0].id;

  const answer = () => request("/rest/v1/rpc/ef_submit_attempt", secretKey, {
    method: "POST", body: { p_session_id: sessionId, p_question_id: questionIds[0],
      p_answer_json: { type: "option", optionId: "b" }, p_score: 0, p_correct: false },
  });
  const answers = await Promise.all([answer(), answer()]);
  assert.deepEqual(answers.map((x) => x.data).sort(), [false, true], "first answer wins under concurrency");
  const attempts = await request(`/rest/v1/ef_attempts?session_id=eq.${sessionId}&select=question_id,score`, secretKey);
  assert.equal(attempts.data.length, 1);
  assert.equal(attempts.data[0].score, 0);

  const finished = await request("/rest/v1/rpc/ef_finish_session", secretKey, {
    method: "POST", body: { p_session_id: sessionId },
  });
  assert.equal(finished.data, true);
  assert.ok((await answer()).status >= 400, "completed sessions reject new answers");
  console.log("Hosted DB smoke passed: owner isolation, protected keys, atomicity, concurrency and lifecycle.");
} finally {
  await request(`/rest/v1/ef_courses?id=eq.${courseId}`, secretKey, { method: "DELETE" });
  for (const user of [a, b]) {
    await request(`/auth/v1/admin/users/${user.id}`, secretKey, { method: "DELETE" });
  }
}
