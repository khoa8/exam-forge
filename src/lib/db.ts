import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { AttemptRecord } from "./mastery";

/**
 * Persistence layer — SQLite via node:sqlite (no native install required).
 * All study material and learner progress stays in a local file: .data/examforge.sqlite
 * (override with EXAMFORGE_DB_PATH). The directory is gitignored.
 *
 * Schema evolution is versioned with `PRAGMA user_version`: new databases apply
 * the ordered migration list once; existing databases migrate forward in
 * per-migration transactions; databases from a newer version of the application
 * are refused instead of mutated blindly.
 */

export interface Migration {
  /** Schema version this migration brings the database to. */
  version: number;
  /** Apply the schema change. Runs inside a transaction, together with the version stamp. */
  up: (db: DatabaseSync) => void;
}

/** Ordered, append-only migration history. Never rewrite an applied entry. */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS courses (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          source_type TEXT NOT NULL,
          material_text TEXT NOT NULL,
          provider_used TEXT NOT NULL,
          provider_notice TEXT,
          quality_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS concepts (
          id TEXT PRIMARY KEY,
          course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          evidence_json TEXT NOT NULL,
          importance REAL NOT NULL,
          ord INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_concepts_course ON concepts(course_id);

        CREATE TABLE IF NOT EXISTS questions (
          id TEXT PRIMARY KEY,
          course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
          concept_id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          ord INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_questions_course ON questions(course_id);

        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          concept_id TEXT,
          question_ids_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL,
          completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_course ON sessions(course_id);

        CREATE TABLE IF NOT EXISTS attempts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          course_id TEXT NOT NULL,
          question_id TEXT NOT NULL,
          concept_id TEXT NOT NULL,
          answer_json TEXT NOT NULL,
          score REAL NOT NULL,
          correct INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(session_id, question_id)
        );
        CREATE INDEX IF NOT EXISTS idx_attempts_course ON attempts(course_id);
      `);
    },
  },
];

/** Highest schema version understood by this build. */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

function getUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number | bigint };
  return Number(row.user_version);
}

/**
 * Refuse databases written by a NEWER version of this application before any
 * persistent database state (e.g. journal_mode) is changed. Purely reads the
 * schema version; performs no mutation.
 */
export function assertSupportedSchema(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): void {
  const version = getUserVersion(db);
  const maxSupported = migrations[migrations.length - 1].version;
  if (version > maxSupported) {
    throw new Error(
      `Database schema version ${version} is newer than this application supports (version ${maxSupported}). ` +
        "Refusing to migrate. Update ExamForge to a newer release, or restore a compatible database.",
    );
  }
}

/**
 * Apply pending migrations in order. Each migration (schema change + version
 * stamp) commits atomically, so a failed migration rolls back completely and
 * the database stays honestly at its previous version.
 */
export function runMigrations(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): void {
  assertSupportedSchema(db, migrations);
  let version = getUserVersion(db);
  for (const migration of migrations) {
    if (migration.version <= version) continue;
    db.exec("BEGIN");
    try {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(
        `Database migration to version ${migration.version} failed and was rolled back: ${(err as Error).message}`,
        { cause: err },
      );
    }
    version = migration.version;
  }
}

function migrate(db: DatabaseSync): void {
  // Compatibility first: refuse a future schema version before any persistent
  // mutation — journal_mode = WAL changes persistent database state.
  assertSupportedSchema(db);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  runMigrations(db);
}

let cached: DatabaseSync | null = null;
let cachedPath: string | null = null;

export function dbFilePath(): string {
  if (process.env.EXAMFORGE_DB_PATH) return process.env.EXAMFORGE_DB_PATH;
  return path.join(process.cwd(), ".data", "examforge.sqlite");
}

/** Test hook: point the db at a scratch file. */
export function setDbPathForTests(p: string): void {
  process.env.EXAMFORGE_DB_PATH = p;
  if (cached) {
    try {
      cached.close();
    } catch {
      /* ignore */
    }
  }
  cached = null;
  cachedPath = null;
}

export function getDb(): DatabaseSync {
  const p = dbFilePath();
  if (cached && cachedPath === p) return cached;
  if (cached) {
    try {
      cached.close();
    } catch {
      /* ignore */
    }
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const db = new DatabaseSync(p);
  migrate(db);
  cached = db;
  cachedPath = p;
  return db;
}

export interface CourseRow {
  id: string;
  title: string;
  sourceType: string;
  materialText: string;
  providerUsed: string;
  providerNotice: string | null;
  qualityJson: string;
  createdAt: string;
}

export const db = {
  insertCourse(row: CourseRow, concepts: { id: string; name: string; description: string; evidenceJson: string; importance: number }[], questions: { id: string; conceptId: string; payloadJson: string }[]): void {
    const dbi = getDb();
    dbi.exec("BEGIN");
    try {
      dbi
        .prepare(
          `INSERT INTO courses (id, title, source_type, material_text, provider_used, provider_notice, quality_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(row.id, row.title, row.sourceType, row.materialText, row.providerUsed, row.providerNotice, row.qualityJson, row.createdAt);
      const cStmt = dbi.prepare(
        `INSERT INTO concepts (id, course_id, name, description, evidence_json, importance, ord)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      concepts.forEach((c, i) => cStmt.run(c.id, row.id, c.name, c.description, c.evidenceJson, c.importance, i));
      const qStmt = dbi.prepare(
        `INSERT INTO questions (id, course_id, concept_id, payload_json, ord) VALUES (?, ?, ?, ?, ?)`,
      );
      questions.forEach((q, i) => qStmt.run(q.id, row.id, q.conceptId, q.payloadJson, i));
      dbi.exec("COMMIT");
    } catch (err) {
      dbi.exec("ROLLBACK");
      throw err;
    }
  },

  getCourse(id: string): CourseRow | null {
    const row = getDb().prepare(`SELECT * FROM courses WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      title: row.title as string,
      sourceType: row.source_type as string,
      materialText: row.material_text as string,
      providerUsed: row.provider_used as string,
      providerNotice: (row.provider_notice as string | null) ?? null,
      qualityJson: row.quality_json as string,
      createdAt: row.created_at as string,
    };
  },

  listCourses(): Omit<CourseRow, "materialText">[] {
    const rows = getDb()
      .prepare(`SELECT id, title, source_type, provider_used, provider_notice, quality_json, created_at FROM courses ORDER BY created_at DESC`)
      .all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      title: row.title as string,
      sourceType: row.source_type as string,
      providerUsed: row.provider_used as string,
      providerNotice: (row.provider_notice as string | null) ?? null,
      qualityJson: row.quality_json as string,
      createdAt: row.created_at as string,
    }));
  },

  deleteCourse(id: string): boolean {
    const res = getDb().prepare(`DELETE FROM courses WHERE id = ?`).run(id);
    return Number(res.changes) > 0;
  },

  getConcepts(courseId: string): { id: string; name: string; description: string; evidenceJson: string; importance: number }[] {
    const rows = getDb()
      .prepare(`SELECT * FROM concepts WHERE course_id = ? ORDER BY ord`)
      .all(courseId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      description: r.description as string,
      evidenceJson: r.evidence_json as string,
      importance: r.importance as number,
    }));
  },

  getQuestions(courseId: string): { id: string; conceptId: string; payloadJson: string }[] {
    const rows = getDb()
      .prepare(`SELECT id, concept_id, payload_json FROM questions WHERE course_id = ? ORDER BY ord`)
      .all(courseId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      conceptId: r.concept_id as string,
      payloadJson: r.payload_json as string,
    }));
  },

  insertSession(s: { id: string; courseId: string; kind: string; conceptId: string | null; questionIds: string[]; createdAt: string }): void {
    getDb()
      .prepare(
        `INSERT INTO sessions (id, course_id, kind, concept_id, question_ids_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`,
      )
      .run(s.id, s.courseId, s.kind, s.conceptId, JSON.stringify(s.questionIds), s.createdAt);
  },

  getSession(id: string): { id: string; courseId: string; kind: string; conceptId: string | null; questionIds: string[]; status: string; createdAt: string; completedAt: string | null } | null {
    const row = getDb().prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      courseId: row.course_id as string,
      kind: row.kind as string,
      conceptId: (row.concept_id as string | null) ?? null,
      questionIds: JSON.parse(row.question_ids_json as string) as string[],
      status: row.status as string,
      createdAt: row.created_at as string,
      completedAt: (row.completed_at as string | null) ?? null,
    };
  },

  listSessions(courseId: string): { id: string; courseId: string; kind: string; conceptId: string | null; questionIds: string[]; status: string; createdAt: string; completedAt: string | null }[] {
    const rows = getDb()
      .prepare(`SELECT * FROM sessions WHERE course_id = ? ORDER BY created_at DESC`)
      .all(courseId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      courseId: r.course_id as string,
      kind: r.kind as string,
      conceptId: (r.concept_id as string | null) ?? null,
      questionIds: JSON.parse(r.question_ids_json as string) as string[],
      status: r.status as string,
      createdAt: r.created_at as string,
      completedAt: (r.completed_at as string | null) ?? null,
    }));
  },

  completeSession(id: string, completedAt: string): void {
    getDb().prepare(`UPDATE sessions SET status = 'completed', completed_at = ? WHERE id = ?`).run(completedAt, id);
  },

  insertAttempt(a: {
    sessionId: string;
    courseId: string;
    questionId: string;
    conceptId: string;
    answerJson: string;
    score: number;
    correct: boolean;
    createdAt: string;
  }): boolean {
    const res = getDb()
      .prepare(
        `INSERT OR IGNORE INTO attempts (session_id, course_id, question_id, concept_id, answer_json, score, correct, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.sessionId, a.courseId, a.questionId, a.conceptId, a.answerJson, a.score, a.correct ? 1 : 0, a.createdAt);
    return Number(res.changes) > 0;
  },

  getAttempt(sessionId: string, questionId: string): { answerJson: string; score: number; correct: boolean } | null {
    const row = getDb()
      .prepare(`SELECT answer_json, score, correct FROM attempts WHERE session_id = ? AND question_id = ?`)
      .get(sessionId, questionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      answerJson: row.answer_json as string,
      score: row.score as number,
      correct: Number(row.correct) === 1,
    };
  },

  getSessionAttempts(sessionId: string): { questionId: string; conceptId: string; answerJson: string; score: number; correct: boolean; createdAt: string }[] {
    const rows = getDb()
      .prepare(`SELECT question_id, concept_id, answer_json, score, correct, created_at FROM attempts WHERE session_id = ? ORDER BY id`)
      .all(sessionId) as Record<string, unknown>[];
    return rows.map((r) => ({
      questionId: r.question_id as string,
      conceptId: r.concept_id as string,
      answerJson: r.answer_json as string,
      score: r.score as number,
      correct: Number(r.correct) === 1,
      createdAt: r.created_at as string,
    }));
  },

  getCourseAttempts(courseId: string): AttemptRecord[] {
    const rows = getDb()
      .prepare(`SELECT concept_id, score, created_at FROM attempts WHERE course_id = ? ORDER BY created_at, id`)
      .all(courseId) as Record<string, unknown>[];
    return rows.map((r) => ({
      conceptId: r.concept_id as string,
      score: r.score as number,
      createdAt: r.created_at as string,
    }));
  },
};
