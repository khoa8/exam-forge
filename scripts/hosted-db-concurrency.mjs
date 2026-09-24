// Runs the hosted migrations and lock races against a disposable local Postgres
// container. Never accepts a database URL or touches a configured Supabase project.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const container = `examforge-lock-test-${process.pid}`;
const owner = "00000000-0000-4000-8000-000000000001";
const otherOwner = "00000000-0000-4000-8000-000000000002";
const psqlArgs = ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-X", "-v", "ON_ERROR_STOP=1", "-At"];

function sql(query, { fails = false } = {}) {
  try {
    const output = execFileSync("docker", psqlArgs, { input: query, encoding: "utf8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    if (fails) throw new Error(`Expected SQL failure: ${query}`);
    return output;
  } catch (error) {
    if (fails && error.stderr) return error.stderr.toString();
    throw error;
  }
}

function hold(query) {
  const child = spawn("docker", psqlArgs, { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  child.stdout.on("data", (data) => { output += data.toString(); });
  child.stderr.on("data", (data) => { errors += data.toString(); });
  child.stdin.end(`begin; set local statement_timeout = '8s'; ${query}; select 'HELD'; select pg_sleep(1.5); commit;`);
  const ready = new Promise((resolveReady, rejectReady) => {
    const poll = setInterval(() => {
      if (output.includes("HELD")) { clearInterval(poll); resolveReady(); }
      else if (child.exitCode !== null) { clearInterval(poll); rejectReady(new Error(errors || output)); }
    }, 10);
  });
  const done = new Promise((resolveDone, rejectDone) => {
    child.on("close", (code) => code === 0 ? resolveDone() : rejectDone(new Error(errors || output)));
  });
  return { ready, done };
}

function practice(id, expected) {
  return `select public.ef_start_practice_session('${owner}', '${id}', 'course', 'concept', array['q1'], ${expected === null ? "null" : `'${expected}'`})`;
}

function attempt(session, score = 0) {
  return `select public.ef_submit_attempt('${session}', 'q1', '{"type":"option","optionId":"a"}', ${score}, ${score === 1})`;
}

try {
  execFileSync("docker", ["run", "--rm", "-d", "--name", container, "-e", "POSTGRES_PASSWORD=test-only", "postgres:16"], { stdio: "ignore" });
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try {
      const logs = execFileSync("docker", ["logs", container], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      if (logs.includes("PostgreSQL init process complete") && sql("select 1") === "1") { ready = true; break; }
    }
    catch { /* server is still initializing */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  assert.ok(ready, "disposable Postgres started");
  sql(`create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;`);
  const migrations = readdirSync(resolve("supabase/migrations")).filter((file) => file.endsWith(".sql")).sort();
  for (const name of migrations.slice(0, -1)) {
    sql(readFileSync(resolve("supabase/migrations", name), "utf8"));
  }
  assert.match(migrations.at(-1), /mock_transition_lock_order\.sql$/);
  sql(`insert into auth.users values ('${owner}'), ('${otherOwner}');
    insert into public.ef_courses(id, owner_id, title, source_type, material_text, quality_json)
    values ('course', '${owner}', 'Synthetic', 'bundled', repeat('synthetic ', 10), '{}');
    insert into public.ef_concepts(id, course_id, name, description, evidence_json, importance, ord)
    values ('concept', 'course', 'Synthetic', 'Synthetic', '[]', 0.5, 0);
    insert into public.ef_questions(id, course_id, concept_id, payload_json, ord)
    values ('q1', 'course', 'concept', '{"type":"mcq","options":[{"id":"a"},{"id":"b"}]}', 0);`);

  // Negative control: the previously deployed finish RPC only holds the mock
  // row lock. Practice can validate that still-visible active row and commit.
  assert.equal(sql(`select public.ef_start_session('${owner}', 'old-mock', 'course', 'mock', null, array['q1'])`), "t");
  const oldFinishing = hold("select public.ef_finish_session('old-mock')");
  await oldFinishing.ready;
  assert.equal(sql(practice("old-stale", "old-mock")), "t");
  await oldFinishing.done;
  assert.equal(sql("select status from public.ef_sessions where id = 'old-mock'"), "completed");
  assert.equal(sql("select count(*) from public.ef_sessions where id = 'old-stale'"), "1");

  sql(readFileSync(resolve("supabase/migrations", migrations.at(-1)), "utf8"));

  assert.match(sql(`select public.ef_start_session('${otherOwner}', 'wrong-owner', 'course', 'mock', null, array['q1'])`, { fails: true }), /Course not found/);
  const starting = hold(`select public.ef_start_session('${owner}', 'mock', 'course', 'mock', null, array['q1'])`);
  await starting.ready;
  assert.match(sql(`set statement_timeout = '8s'; ${practice("stale-start", null)}`, { fails: true }), /COURSE_STATE_CHANGED/);
  await starting.done;
  assert.equal(sql("select count(*) from public.ef_sessions where id = 'stale-start'"), "0");
  assert.match(sql(`select public.ef_start_session('${owner}', 'second-mock', 'course', 'mock', null, array['q1'])`, { fails: true }), /duplicate key/);
  assert.equal(sql(practice("matching", "mock")), "t");
  assert.match(sql(attempt("matching"), { fails: true }), /protected by an active mock/);

  const finishing = hold("select public.ef_finish_session('mock')");
  await finishing.ready;
  assert.match(sql(`set statement_timeout = '8s'; ${practice("stale-finish", "mock")}`, { fails: true }), /COURSE_STATE_CHANGED/);
  await finishing.done;
  assert.equal(sql("select count(*) from public.ef_sessions where id = 'stale-finish'"), "0");
  assert.equal(sql(practice("after-finish", null)), "t");

  const answering = hold(attempt("after-finish", 1));
  await answering.ready;
  assert.equal(sql("set statement_timeout = '8s'; select public.ef_finish_session('after-finish')"), "SET\nt");
  await answering.done;
  assert.equal(sql("select count(*), max(score) from public.ef_attempts where session_id = 'after-finish'"), "1|1");
  assert.match(sql(attempt("after-finish"), { fails: true }), /Session is completed/);
  assert.equal(sql("select public.ef_finish_session('after-finish')"), "f");
  assert.match(sql(`select public.ef_start_session('${owner}', 'diagnostic', 'course', 'diagnostic', null, array['q1']); select public.ef_finish_session('diagnostic')`, { fails: true }), /Answer all diagnostic questions/);
  console.log("Hosted lock concurrency passed: reproduced old completion race; verified mock start/finish, stale practice rollback, answer/finish, ownership and completion after migration.");
} finally {
  try { execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" }); } catch { /* container may not exist */ }
}
