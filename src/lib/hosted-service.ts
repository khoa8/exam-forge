import type { AnswerValue, Concept, Course, GradeResult, MasteryState, Question, Session, SessionKind } from "./types.ts";
import type { CreateCourseInput, CourseOverview, SessionListItem, SessionView } from "./service.ts";
import { HostedDb, type SessionRow } from "./hosted-db.ts";
import { generateDeterministic, NoConceptsError } from "./provider/deterministic.ts";
import { computeMastery } from "./mastery.ts";
import { computeReadiness } from "./readiness.ts";
import { gradeAnswer } from "./grade.ts";
import { sampleDiagnostic, sampleMock, samplePractice } from "./sampler.ts";
import { validateCourseViability } from "./validate.ts";
import { randomId } from "./util.ts";
import { clientQuestion, summarize } from "./presentation.ts";

export class HostedNotFoundError extends Error {
  constructor(what: string) { super(`${what} not found`); this.name = "NotFoundError"; }
}
export class HostedConflictError extends Error {
  constructor(message: string) { super(message); this.name = "ConflictError"; }
}
export class HostedMaterialNotViableError extends Error {
  constructor(message: string) { super(message); this.name = "MaterialNotViableError"; }
}

/** The hosted service uses the same generation, validation, grading and
 * readiness modules as the local service. Persistence is asynchronous and
 * scoped to the verified anonymous user in HostedDb. */
export class HostedService {
  constructor(private readonly db: HostedDb) {}

  async createCourse(input: CreateCourseInput): Promise<{ courseId: string; course: Course; conceptCount: number; questionCount: number }> {
    if (!(await this.db.takeGenerationSlot())) {
      throw new HostedConflictError("This beta allows five course-generation attempts per hour for each browser identity. Try again later.");
    }
    let output;
    try {
      output = generateDeterministic(input.text);
    } catch (error) {
      if (error instanceof NoConceptsError) throw new HostedMaterialNotViableError(error.message);
      throw error;
    }
    const viabilityErrors = validateCourseViability(output.questions);
    if (viabilityErrors.length > 0) {
      throw new HostedMaterialNotViableError(
        "The supplied material did not contain enough grounded assessment structure to build a usable course: " +
        `${viabilityErrors.join("; ")}. Try material with headings and clear definition statements (for example 'X is …').`,
      );
    }
    const quality = { ...output.quality, notes: [...input.ingestionWarnings, ...output.quality.notes] };
    const courseId = randomId("crs_");
    const now = new Date().toISOString();
    const course: Course = {
      id: courseId, title: input.title?.trim() || output.title || "Untitled material",
      sourceType: input.sourceType, createdAt: now, textLength: input.text.length, quality,
    };
    await this.db.insertCourse(
      {
        id: courseId, title: course.title, sourceType: course.sourceType, materialText: input.text,
        providerUsed: "deterministic", providerNotice: null,
        qualityJson: JSON.stringify(quality), createdAt: now,
      },
      output.concepts.map((c) => ({ id: c.id, name: c.name, description: c.description,
        evidenceJson: JSON.stringify(c.evidence), importance: c.importance })),
      output.questions.map((q) => ({ id: q.id, conceptId: q.conceptId, payloadJson: JSON.stringify(q) })),
    );
    return { courseId, course, conceptCount: output.concepts.length, questionCount: output.questions.length };
  }

  async listCourses() {
    return (await this.db.listCourses()).map((c) => ({
      id: c.id, title: c.title, sourceType: c.sourceType,
      createdAt: c.createdAt, quality: JSON.parse(c.qualityJson),
    }));
  }

  async deleteCourse(courseId: string): Promise<boolean> {
    return this.db.deleteCourse(courseId);
  }

  private async concepts(courseId: string): Promise<Concept[]> {
    return (await this.db.getConcepts(courseId)).map((c) => ({
      id: c.id, name: c.name, description: c.description,
      evidence: JSON.parse(c.evidenceJson), importance: c.importance,
    }));
  }

  private async questions(courseId: string): Promise<Question[]> {
    return (await this.db.getQuestions(courseId)).map((q) => JSON.parse(q.payloadJson) as Question);
  }

  private async activeMockQuestionIds(courseId: string): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const session of await this.db.listSessions(courseId)) {
      if (session.kind === "mock" && session.status === "active") {
        for (const id of session.questionIds) ids.add(id);
      }
    }
    return ids;
  }

  private async protectedQuestionIds(session: SessionRow): Promise<Set<string>> {
    if (session.kind === "mock" && session.status === "active") return new Set();
    return this.activeMockQuestionIds(session.courseId);
  }

  private async weakestConceptId(courseId: string, concepts: Concept[]): Promise<string> {
    const attempts = await this.db.getEligibleCourseAttempts(courseId, [...await this.activeMockQuestionIds(courseId)]);
    const now = new Date().toISOString();
    let worst = concepts[0];
    let worstMastery = 2;
    for (const concept of concepts) {
      const mastery = computeMastery(concept.id, attempts.filter((a) => a.conceptId === concept.id), concept.importance, now);
      const score = mastery.status === "untested" ? 0.35 : mastery.mastery;
      if (score < worstMastery) { worstMastery = score; worst = concept; }
    }
    return worst.id;
  }

  async getCourseOverview(courseId: string): Promise<CourseOverview> {
    const row = await this.db.getCourse(courseId);
    if (!row) throw new HostedNotFoundError("Course");
    const course: Course = {
      id: row.id, title: row.title, sourceType: row.sourceType as Course["sourceType"],
      createdAt: row.createdAt, textLength: row.materialText.length, quality: JSON.parse(row.qualityJson),
    };
    const concepts = await this.concepts(courseId);
    const attempts = await this.db.getEligibleCourseAttempts(courseId, [...await this.activeMockQuestionIds(courseId)]);
    const now = new Date().toISOString();
    const masteryByConcept = new Map<string, MasteryState>();
    for (const concept of concepts) {
      masteryByConcept.set(concept.id, computeMastery(concept.id,
        attempts.filter((a) => a.conceptId === concept.id), concept.importance, now));
    }
    const [sessions, attemptCounts] = await Promise.all([
      this.db.listSessions(courseId), this.db.getSessionAttemptCounts(courseId),
    ]);
    const sessionItems: SessionListItem[] = sessions.map((session) => ({
      id: session.id, kind: session.kind as SessionKind, conceptId: session.conceptId,
      status: session.status as "active" | "completed", createdAt: session.createdAt,
      completedAt: session.completedAt, totalQuestions: session.questionIds.length,
      answered: attemptCounts.get(session.id) ?? 0, score: null,
    }));
    const readiness = computeReadiness(concepts, masteryByConcept, {
      hasDiagnostic: sessions.some((s) => s.kind === "diagnostic" && s.status === "completed"),
      hasMock: sessions.some((s) => s.kind === "mock" && s.status === "completed"),
      hasPractice: sessions.some((s) => s.kind === "practice" && s.status === "completed"),
    });
    const active = sessions.find((s) => s.status === "active");
    const activeMock = sessions.find((s) => s.kind === "mock" && s.status === "active");
    return {
      course,
      concepts: concepts.map((c) => ({ ...c, mastery: masteryByConcept.get(c.id)! })),
      readiness: {
        ...readiness,
        concepts: concepts.map((c) => masteryByConcept.get(c.id)!),
        weak: readiness.weak.map((m) => masteryByConcept.get(m.conceptId) ?? m),
        strong: readiness.strong.map((m) => masteryByConcept.get(m.conceptId) ?? m),
        untested: readiness.untested.map((m) => masteryByConcept.get(m.conceptId) ?? m),
      },
      sessions: sessionItems,
      activeSession: active ? { id: active.id, kind: active.kind as SessionKind } : null,
      activeMockSession: activeMock ? { id: activeMock.id, kind: "mock" } : null,
      questionCount: (await this.questions(courseId)).length,
    };
  }

  async startSession(courseId: string, kind: SessionKind, conceptId?: string): Promise<Session> {
    if (!(await this.db.getCourse(courseId))) throw new HostedNotFoundError("Course");
    const concepts = await this.concepts(courseId);
    if (concepts.length === 0) throw new HostedConflictError("This course has no concepts to study.");
    if (kind === "mock" && (await this.db.listSessions(courseId)).some((s) => s.kind === "mock" && s.status === "active")) {
      throw new HostedConflictError("A mock exam is already in progress for this course. Submit it before starting a new one.");
    }
    const questions = await this.questions(courseId);
    let picked: Question[];
    let target: string | null = null;
    if (kind === "practice") {
      target = conceptId ?? await this.weakestConceptId(courseId, concepts);
      if (!concepts.some((c) => c.id === target)) throw new HostedNotFoundError("Concept");
      picked = samplePractice(questions, target, courseId);
      if (picked.length === 0) throw new HostedConflictError(
        "No practice questions are available for this concept. The material may not contain enough grounded content about it.");
    } else if (kind === "diagnostic") {
      picked = sampleDiagnostic(questions, concepts, courseId);
    } else {
      picked = sampleMock(questions, concepts, courseId);
    }
    if (picked.length === 0) throw new HostedConflictError(
      "No questions could be generated for this material. It is probably too short or unstructured — try material with headings and clear definitions (for example 'X is …').");
    const session: Session = {
      id: randomId("ses_"), courseId, kind, conceptId: target,
      questionIds: picked.map((q) => q.id), status: "active", createdAt: new Date().toISOString(), completedAt: null,
    };
    try {
      await this.db.insertSession(session);
    } catch (error) {
      if ((error as Error).message === "ACTIVE_MOCK_CONFLICT") throw new HostedConflictError(
        "A mock exam is already in progress for this course. Submit it before starting a new one.");
      throw error;
    }
    return session;
  }

  async getSessionView(sessionId: string): Promise<SessionView> {
    const session = await this.db.getSession(sessionId);
    if (!session) throw new HostedNotFoundError("Session");
    const allQuestions = await this.questions(session.courseId);
    const byId = new Map(allQuestions.map((q) => [q.id, q]));
    const sessionQuestions = session.questionIds.map((id) => byId.get(id)).filter((q): q is Question => Boolean(q));
    const protectedIds = await this.protectedQuestionIds(session);
    const withheldQuestionIds = sessionQuestions.filter((q) => protectedIds.has(q.id)).map((q) => q.id);
    const attempts = await this.db.getSessionAttempts(sessionId);
    const revealed: Record<string, GradeResult> = {};
    const givenAnswers: Record<string, AnswerValue> = {};
    const review: NonNullable<SessionView["review"]> = [];
    for (const question of sessionQuestions) {
      const attempt = attempts.find((a) => a.questionId === question.id);
      if (attempt) {
        const saved = JSON.parse(attempt.answerJson) as AnswerValue;
        givenAnswers[question.id] = saved;
        if (protectedIds.has(question.id)) continue;
        const result = gradeAnswer(question, saved);
        revealed[question.id] = result;
        review.push({ question, userAnswer: saved, result });
      } else if (!protectedIds.has(question.id)) {
        review.push({ question, userAnswer: null, result: null });
      }
    }
    const completed = session.status === "completed";
    const isMock = session.kind === "mock";
    return {
      session: {
        id: session.id, courseId: session.courseId, kind: session.kind as SessionKind,
        conceptId: session.conceptId, questionIds: session.questionIds,
        status: session.status as "active" | "completed", createdAt: session.createdAt, completedAt: session.completedAt,
      },
      questions: sessionQuestions.map((q) => clientQuestion(q, {
        sessionKind: session.kind as SessionKind,
        sessionStatus: session.status as "active" | "completed",
        isAnswered: attempts.some((a) => a.questionId === q.id), answerProtected: protectedIds.has(q.id),
      })),
      givenAnswers, revealed: completed || !isMock ? revealed : {},
      withheldQuestionIds, answeredCount: attempts.length,
      review: completed ? review : null,
      summary: completed && withheldQuestionIds.length === 0 ? summarize(session, sessionQuestions, attempts) : null,
    };
  }

  async answerQuestion(sessionId: string, questionId: string, answer: AnswerValue): Promise<{ grade: GradeResult | null; answeredCount: number; total: number }> {
    const session = await this.db.getSession(sessionId);
    if (!session) throw new HostedNotFoundError("Session");
    if (session.status === "completed") throw new HostedConflictError("This session is already completed.");
    if (!session.questionIds.includes(questionId)) throw new HostedNotFoundError("Question in this session");
    if ((await this.protectedQuestionIds(session)).has(questionId)) throw new HostedConflictError(
      "This question is part of an active mock exam. Submit the mock exam before answering it in another session.");
    const question = (await this.questions(session.courseId)).find((q) => q.id === questionId);
    if (!question) throw new HostedNotFoundError("Question");
    const existing = await this.db.getAttempt(sessionId, questionId);
    if (existing) {
      return {
        grade: session.kind === "mock" ? null : gradeAnswer(question, JSON.parse(existing.answerJson) as AnswerValue),
        answeredCount: (await this.db.getSessionAttempts(sessionId)).length, total: session.questionIds.length,
      };
    }
    const result = gradeAnswer(question, answer);
    try {
      const inserted = await this.db.insertAttempt({
        sessionId, courseId: session.courseId, questionId, conceptId: question.conceptId,
        answerJson: JSON.stringify(answer), score: result.score, correct: result.correct,
        createdAt: new Date().toISOString(),
      });
      if (!inserted) {
        const first = await this.db.getAttempt(sessionId, questionId);
        if (!first) throw new Error("First attempt was not found after a duplicate answer.");
        return {
          grade: session.kind === "mock" ? null : gradeAnswer(question, JSON.parse(first.answerJson) as AnswerValue),
          answeredCount: (await this.db.getSessionAttempts(sessionId)).length, total: session.questionIds.length,
        };
      }
    } catch (error) {
      if (/completed|protected by an active mock/i.test((error as Error).message)) throw new HostedConflictError((error as Error).message);
      throw error;
    }
    return {
      grade: session.kind === "mock" ? null : result,
      answeredCount: (await this.db.getSessionAttempts(sessionId)).length, total: session.questionIds.length,
    };
  }

  async finishSession(sessionId: string): Promise<SessionView> {
    const session = await this.db.getSession(sessionId);
    if (!session) throw new HostedNotFoundError("Session");
    if (session.status !== "completed") {
      try {
        await this.db.completeSession(sessionId);
      } catch (error) {
        if (/Answer all diagnostic questions/i.test((error as Error).message)) throw new HostedConflictError(
          "Answer all diagnostic questions before finishing.");
        throw error;
      }
    }
    return this.getSessionView(sessionId);
  }
}
