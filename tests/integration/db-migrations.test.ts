import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, SCHEMA_VERSION, getDb, runMigrations, setDbPathForTests, db } from "@/lib/db";
import { SAMPLE_MATERIAL } from "@/sample/material";

/**
 * Schema versioning / migration lifecycle over disposable SQLite files:
 * fresh init, baseline upgrade, data survival, cascades, reopen, idempotence,
 * future-version refusal, and per-migration rollback on failure.
 */

let tmpDir: string;
let dbFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "examforge-mig-"));
  dbFile = path.join(tmpDir, "test.sqlite");
});

afterEach(() => {
  setDbPathForTests(path.join(os.tmpdir(), `examforge-mig-reset-${Date.now()}.sqlite`));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function openRaw(file: string): DatabaseSync {
  return new DatabaseSync(file);
}

function getUserVersion(raw: DatabaseSync): number {
  return Number((raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
}

/** Seed a course plus its derived rows directly through the db layer. */
function seedCourseWithProgress(courseId: string): void {
  db.insertCourse(
    {
      id: courseId,
      title: "Migration Test Course",
      sourceType: "paste",
      materialText: SAMPLE_MATERIAL,
      providerUsed: "demo",
      providerNotice: null,
      qualityJson: JSON.stringify({ level: "good", notes: [] }),
      createdAt: new Date().toISOString(),
    },
    [{ id: "con_1", name: "Encoding", description: "Encoding is the process of storing information.", evidenceJson: "[]", importance: 1 }],
    [{ id: "q_1", conceptId: "con_1", payloadJson: "{}" }],
  );
  db.insertSession({
    id: "ses_1",
    courseId,
    kind: "diagnostic",
    conceptId: null,
    questionIds: ["q_1"],
    createdAt: new Date().toISOString(),
  });
  db.insertAttempt({
    sessionId: "ses_1",
    courseId,
    questionId: "q_1",
    conceptId: "con_1",
    answerJson: JSON.stringify({ type: "text", text: "memory" }),
    score: 1,
    correct: true,
    createdAt: new Date().toISOString(),
  });
}

describe("sqlite schema versioning and migrations", () => {
  it("initializes a brand-new database directly at the current schema version", () => {
    setDbPathForTests(dbFile);
    const dbi = getDb();
    expect(getUserVersion(dbi)).toBe(SCHEMA_VERSION);
    // All baseline tables exist.
    for (const table of ["courses", "concepts", "questions", "sessions", "attempts"]) {
      const row = dbi.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
      expect(row).toBeTruthy();
    }
  });

  it("upgrades a pre-versioning baseline database (tables exist, user_version=0) and preserves data", () => {
    // Build a baseline DB the way the pre-versioning app did: schema DDL applied,
    // no user_version stamp, real learner rows already present.
    const raw = openRaw(dbFile);
    raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    MIGRATIONS[0].up(raw);
    raw
      .prepare(
        `INSERT INTO courses (id, title, source_type, material_text, provider_used, provider_notice, quality_json, created_at)
         VALUES ('crs_old', 'Baseline Course', 'paste', 'some material', 'demo', NULL, '{}', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    raw
      .prepare(
        `INSERT INTO concepts (id, course_id, name, description, evidence_json, importance, ord)
         VALUES ('con_old', 'crs_old', 'Encoding', 'Encoding is storing information.', '[]', 1, 0)`,
      )
      .run();
    raw.close();

    // Open through the application: it must migrate forward, not reset.
    setDbPathForTests(dbFile);
    const dbi = getDb();
    expect(getUserVersion(dbi)).toBe(SCHEMA_VERSION);
    const course = db.getCourse("crs_old");
    expect(course?.title).toBe("Baseline Course");
    expect(db.getConcepts("crs_old")).toHaveLength(1);
  });

  it("keeps course/concept/question/session/attempt relationships valid after migration and reopen", () => {
    setDbPathForTests(dbFile);
    seedCourseWithProgress("crs_rel");
    // Reopen from scratch (fresh handle on the same file).
    setDbPathForTests(dbFile);
    const dbi = getDb();
    expect(getUserVersion(dbi)).toBe(SCHEMA_VERSION);
    const session = db.getSession("ses_1");
    expect(session?.questionIds).toEqual(["q_1"]);
    const attempt = db.getAttempt("ses_1", "q_1");
    expect(attempt?.correct).toBe(true);
    expect(db.getCourseAttempts("crs_rel")).toHaveLength(1);
  });

  it("still cascades course deletion through derived data after migration", () => {
    setDbPathForTests(dbFile);
    seedCourseWithProgress("crs_cascade");
    expect(db.deleteCourse("crs_cascade")).toBe(true);
    const dbi = getDb();
    for (const [table, id] of [
      ["concepts", "con_1"],
      ["questions", "q_1"],
      ["sessions", "ses_1"],
    ] as const) {
      const row = dbi.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id);
      expect(row).toBeFalsy();
    }
    expect(db.getSessionAttempts("ses_1")).toHaveLength(0);
  });

  it("is idempotent: repeated openings at the current version do not change anything", () => {
    setDbPathForTests(dbFile);
    seedCourseWithProgress("crs_idem");
    const first = getUserVersion(getDb());
    setDbPathForTests(dbFile);
    const again = getUserVersion(getDb());
    expect(again).toBe(first);
    expect(again).toBe(SCHEMA_VERSION);
    expect(db.getCourse("crs_idem")).not.toBeNull();
    // Re-running the migration list manually at current version is a no-op.
    runMigrations(getDb());
    expect(getUserVersion(getDb())).toBe(SCHEMA_VERSION);
  });

  it("fails clearly on a database written by a newer schema version and leaves it untouched", () => {
    // Prepare a current-version DB, then stamp it as being from the future.
    setDbPathForTests(dbFile);
    seedCourseWithProgress("crs_future");
    const raw = openRaw(dbFile);
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    const before = raw.prepare("SELECT COUNT(*) AS n FROM courses").get() as { n: number };
    raw.close();

    setDbPathForTests(dbFile);
    expect(() => getDb()).toThrow(/newer than this application supports/i);
    // The file must not have been mutated by the refused migration attempt.
    const check = openRaw(dbFile);
    expect(getUserVersion(check)).toBe(SCHEMA_VERSION + 1);
    const after = check.prepare("SELECT COUNT(*) AS n FROM courses").get() as { n: number };
    expect(after.n).toBe(before.n);
    check.close();
  });

  it("rolls back a failed migration completely and stays honestly at the previous version", () => {
    const raw = openRaw(dbFile);
    const applied: number[] = [];
    const migrations = [
      {
        version: 1,
        up: (dbi: DatabaseSync) => {
          dbi.exec("CREATE TABLE marker_one (id INTEGER)");
          applied.push(1);
        },
      },
      {
        version: 2,
        up: (dbi: DatabaseSync) => {
          dbi.exec("CREATE TABLE marker_two (id INTEGER)");
          // Simulate a migration crash mid-schema-change.
          dbi.exec("CREATE TABLE marker_two (id INTEGER)");
        },
      },
    ];
    expect(() => runMigrations(raw, migrations)).toThrow(/migration to version 2 failed and was rolled back/i);
    expect(getUserVersion(raw)).toBe(1);
    // Migration 1 committed (applied honestly); migration 2's partial DDL is gone.
    expect(applied).toEqual([1]);
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='marker_one'").get()).toBeTruthy();
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='marker_two'").get()).toBeFalsy();
    raw.close();
  });
});
