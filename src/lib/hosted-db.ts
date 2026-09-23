import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AttemptRecord } from "./mastery.ts";
import type { CourseRow } from "./db.ts";

type ConceptRow = { id: string; name: string; description: string; evidenceJson: string; importance: number };
type QuestionRow = { id: string; conceptId: string; payloadJson: string };
export type SessionRow = {
  id: string;
  courseId: string;
  kind: string;
  conceptId: string | null;
  questionIds: string[];
  status: string;
  createdAt: string;
  completedAt: string | null;
};
type AttemptRow = { questionId: string; conceptId: string; answerJson: string; score: number; correct: boolean; createdAt: string };

function required<T>(data: T | null, error: { message: string; code?: string } | null): T {
  if (error) throw new Error(`Hosted database operation failed (${error.code ?? "unknown"}): ${error.message}`);
  if (data === null) throw new Error("Hosted database operation returned no data.");
  return data;
}

function mapCourse(row: Record<string, unknown>): CourseRow {
  return {
    id: row.id as string,
    title: row.title as string,
    sourceType: row.source_type as string,
    materialText: row.material_text as string,
    providerUsed: "deterministic",
    providerNotice: null,
    qualityJson: JSON.stringify(row.quality_json),
    createdAt: row.created_at as string,
  };
}

function mapSession(row: Record<string, unknown>): SessionRow {
  return {
    id: row.id as string,
    courseId: row.course_id as string,
    kind: row.kind as string,
    conceptId: row.concept_id as string | null,
    questionIds: row.question_ids as string[],
    status: row.status as string,
    createdAt: row.created_at as string,
    completedAt: row.completed_at as string | null,
  };
}

async function allRows(client: SupabaseClient, table: string, column: string, value: string) {
  const result: Record<string, unknown>[] = [];
  let lastId: string | number | undefined;
  for (;;) {
    let query = client.from(table).select("*").eq(column, value).order("id").limit(500);
    if (lastId !== undefined) query = query.gt("id", lastId);
    const { data, error } = await query;
    const rows = required(data as Record<string, unknown>[] | null, error);
    result.push(...rows);
    if (rows.length < 500) return result;
    lastId = rows[rows.length - 1].id as string | number;
  }
}

/**
 * Privileged PostgREST access for the hosted Edge Function. Every public-ID
 * path resolves ownership before touching protected rows. The secret key is
 * server-only; browser Data API access has no question/attempt grants.
 */
export class HostedDb {
  private readonly client: SupabaseClient;

  constructor(url: string, secretKey: string, readonly ownerId: string) {
    this.client = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async takeGenerationSlot(): Promise<boolean> {
    const { data, error } = await this.client.rpc("ef_take_generation_slot", { p_owner_id: this.ownerId });
    return required(data as boolean | null, error);
  }

  async insertCourse(row: CourseRow, concepts: ConceptRow[], questions: QuestionRow[]): Promise<void> {
    const { error } = await this.client.rpc("ef_create_course", {
      p_owner_id: this.ownerId,
      p_course: {
        id: row.id, title: row.title, source_type: row.sourceType,
        material_text: row.materialText, quality_json: JSON.parse(row.qualityJson), created_at: row.createdAt,
      },
      p_concepts: concepts.map((c, ord) => ({
        id: c.id, name: c.name, description: c.description,
        evidence_json: JSON.parse(c.evidenceJson), importance: c.importance, ord,
      })),
      p_questions: questions.map((q, ord) => ({
        id: q.id, concept_id: q.conceptId, payload_json: JSON.parse(q.payloadJson), ord,
      })),
    });
    required(true, error);
  }

  async getCourse(id: string): Promise<CourseRow | null> {
    const { data, error } = await this.client.from("ef_courses").select("*")
      .eq("id", id).eq("owner_id", this.ownerId).maybeSingle();
    required(true, error);
    return data ? mapCourse(data as Record<string, unknown>) : null;
  }

  async listCourses(): Promise<Omit<CourseRow, "materialText">[]> {
    const { data, error } = await this.client.from("ef_courses")
      .select("id,title,source_type,quality_json,created_at")
      .eq("owner_id", this.ownerId).order("created_at", { ascending: false }).order("id", { ascending: false });
    return required(data, error).map((row) => ({
      id: row.id, title: row.title, sourceType: row.source_type,
      providerUsed: "deterministic", providerNotice: null,
      qualityJson: JSON.stringify(row.quality_json), createdAt: row.created_at,
    }));
  }

  async deleteCourse(id: string): Promise<boolean> {
    const { data, error } = await this.client.from("ef_courses").delete()
      .eq("id", id).eq("owner_id", this.ownerId).select("id");
    return required(data, error).length > 0;
  }

  private async ownsCourse(courseId: string): Promise<boolean> {
    return (await this.getCourse(courseId)) !== null;
  }

  async getConcepts(courseId: string): Promise<ConceptRow[]> {
    if (!(await this.ownsCourse(courseId))) return [];
    const rows = await allRows(this.client, "ef_concepts", "course_id", courseId);
    return rows.sort((a, b) => Number(a.ord) - Number(b.ord)).map((c) => ({
      id: c.id as string, name: c.name as string, description: c.description as string,
      evidenceJson: JSON.stringify(c.evidence_json), importance: c.importance as number,
    }));
  }

  async getQuestions(courseId: string): Promise<QuestionRow[]> {
    if (!(await this.ownsCourse(courseId))) return [];
    const rows = await allRows(this.client, "ef_questions", "course_id", courseId);
    return rows.sort((a, b) => Number(a.ord) - Number(b.ord)).map((q) => ({
      id: q.id as string, conceptId: q.concept_id as string, payloadJson: JSON.stringify(q.payload_json),
    }));
  }

  async insertSession(session: {
    id: string; courseId: string; kind: string; conceptId: string | null;
    questionIds: string[]; createdAt: string;
  }): Promise<void> {
    if (!(await this.ownsCourse(session.courseId))) throw new Error("Course not found");
    const { error } = await this.client.rpc("ef_start_session", {
      p_owner_id: this.ownerId, p_id: session.id, p_course_id: session.courseId,
      p_kind: session.kind, p_concept_id: session.conceptId,
      p_question_ids: session.questionIds,
    });
    if (error?.code === "23505") throw new Error("ACTIVE_MOCK_CONFLICT");
    required(true, error);
  }

  async getSession(id: string): Promise<SessionRow | null> {
    const { data, error } = await this.client.from("ef_sessions").select("*").eq("id", id).maybeSingle();
    required(true, error);
    if (!data || !(await this.ownsCourse(data.course_id))) return null;
    if (error?.message.includes("SESSION_LIMIT_REACHED")) throw new Error("SESSION_LIMIT_REACHED");
    return mapSession(data as Record<string, unknown>);
  }

  async listSessions(courseId: string): Promise<SessionRow[]> {
    if (!(await this.ownsCourse(courseId))) return [];
    const rows = await allRows(this.client, "ef_sessions", "course_id", courseId);
    return rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) ||
      Number(b.created_seq) - Number(a.created_seq)).map(mapSession);
  }

  async getSessionAttemptCounts(courseId: string): Promise<Map<string, number>> {
    if (!(await this.ownsCourse(courseId))) return new Map();
    const rows = await allRows(this.client, "ef_attempts", "course_id", courseId);
    const counts = new Map<string, number>();
    for (const row of rows) {
      const sessionId = row.session_id as string;
      counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
    }
    return counts;
  }

  async completeSession(id: string): Promise<void> {
    if (!(await this.getSession(id))) throw new Error("Session not found");
    const { error } = await this.client.rpc("ef_finish_session", { p_session_id: id });
    required(true, error);
  }

  async insertAttempt(attempt: {
    sessionId: string; courseId: string; questionId: string; conceptId: string;
    answerJson: string; score: number; correct: boolean; createdAt: string;
  }): Promise<boolean> {
    const session = await this.getSession(attempt.sessionId);
    if (!session || session.courseId !== attempt.courseId) throw new Error("Session not found");
    const { data, error } = await this.client.rpc("ef_submit_attempt", {
      p_session_id: attempt.sessionId, p_question_id: attempt.questionId,
      p_answer_json: JSON.parse(attempt.answerJson), p_score: attempt.score, p_correct: attempt.correct,
    });
    return required(data as boolean | null, error);
  }

  async getAttempt(sessionId: string, questionId: string): Promise<{ answerJson: string; score: number; correct: boolean } | null> {
    if (!(await this.getSession(sessionId))) return null;
    const { data, error } = await this.client.from("ef_attempts")
      .select("answer_json,score,correct").eq("session_id", sessionId).eq("question_id", questionId).maybeSingle();
    required(true, error);
    return data ? { answerJson: JSON.stringify(data.answer_json), score: data.score, correct: data.correct } : null;
  }

  async getSessionAttempts(sessionId: string): Promise<AttemptRow[]> {
    if (!(await this.getSession(sessionId))) return [];
    const rows = await allRows(this.client, "ef_attempts", "session_id", sessionId);
    return rows.sort((a, b) => Number(a.id) - Number(b.id)).map((row) => ({
      questionId: row.question_id as string, conceptId: row.concept_id as string,
      answerJson: JSON.stringify(row.answer_json), score: row.score as number,
      correct: row.correct as boolean, createdAt: row.created_at as string,
    }));
  }

  async getEligibleCourseAttempts(courseId: string, excludedQuestionIds: readonly string[] = []): Promise<AttemptRecord[]> {
    if (!(await this.ownsCourse(courseId))) return [];
    const [attempts, sessions] = await Promise.all([
      allRows(this.client, "ef_attempts", "course_id", courseId), this.listSessions(courseId),
    ]);
    const activeMockSessions = new Set(sessions.filter((s) => s.kind === "mock" && s.status === "active").map((s) => s.id));
    const excluded = new Set(excludedQuestionIds);
    return attempts
      .filter((a) => !activeMockSessions.has(a.session_id as string) && !excluded.has(a.question_id as string))
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || Number(a.id) - Number(b.id))
      .map((a) => ({ conceptId: a.concept_id as string, score: a.score as number, createdAt: a.created_at as string }));
  }
}
