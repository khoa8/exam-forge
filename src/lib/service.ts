import type {
  AnswerValue,
  ClientQuestion,
  Course,
  Concept,
  GradeResult,
  MasteryState,
  Question,
  ReadinessReport,
  Session,
  SessionKind,
  SessionReviewItem,
  SessionSummary,
} from "./types.ts";
import { db } from "./db.ts";
import { generateDeterministic, NoConceptsError } from "./provider/deterministic.ts";
import { computeMastery } from "./mastery.ts";
import { computeReadiness } from "./readiness.ts";
import { gradeAnswer } from "./grade.ts";
import { clientQuestion, summarize } from "./presentation.ts";
export { clientQuestion, isConceptNameSafe } from "./presentation.ts";
export type { QuestionPresentationContext } from "./presentation.ts";
import { sampleDiagnostic, sampleMock, samplePractice } from "./sampler.ts";
import { validateCourseViability } from "./validate.ts";
import { randomId } from "./util.ts";

/**
 * Service layer: orchestrates deterministic generation, persistence, grading
 * and the adaptive model. API routes stay thin; all learning-loop rules live here.
 */

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/**
 * The supplied material was not sufficient to build a course that can enter the
 * core learning loop. Controlled (not a server fault): nothing is persisted.
 */
export class MaterialNotViableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaterialNotViableError";
  }
}

export interface CreateCourseInput {
  text: string;
  sourceType: Course["sourceType"];
  ingestionWarnings: string[];
  title?: string;
}

export async function createCourse(input: CreateCourseInput): Promise<{ courseId: string; course: Course; conceptCount: number; questionCount: number }> {
  let output;
  try {
    output = generateDeterministic(input.text);
  } catch (err) {
    if (err instanceof NoConceptsError) {
      throw new MaterialNotViableError(err.message);
    }
    throw err;
  }

  // Assessment-viability gate (architecture invariant): reject a course that could
  // not enter the core learning loop BEFORE anything is persisted.
  const viabilityErrors = validateCourseViability(output.questions);
  if (viabilityErrors.length > 0) {
    throw new MaterialNotViableError(
      "The supplied material did not contain enough grounded assessment structure to build a usable course: " +
        `${viabilityErrors.join("; ")}. ` +
        "Try material with headings and clear definition statements (for example 'X is …').",
    );
  }

  const quality = { ...output.quality };
  if (input.ingestionWarnings.length > 0) {
    quality.notes = [...input.ingestionWarnings, ...quality.notes];
  }

  const courseId = randomId("crs_");
  const now = new Date().toISOString();
  const course: Course = {
    id: courseId,
    title: input.title?.trim() || output.title || "Untitled material",
    sourceType: input.sourceType,
    createdAt: now,
    textLength: input.text.length,
    quality,
  };

  db.insertCourse(
    {
      id: courseId,
      title: course.title,
      sourceType: course.sourceType,
      materialText: input.text,
      // Legacy provider metadata columns are kept for schema compatibility;
      // every new course is recorded as deterministic local generation.
      providerUsed: "deterministic",
      providerNotice: null,
      qualityJson: JSON.stringify(quality),
      createdAt: now,
    },
    output.concepts.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      evidenceJson: JSON.stringify(c.evidence),
      importance: c.importance,
    })),
    output.questions.map((q) => ({
      id: q.id,
      conceptId: q.conceptId,
      payloadJson: JSON.stringify(q),
    })),
  );

  return { courseId, course, conceptCount: output.concepts.length, questionCount: output.questions.length };
}

export interface ConceptView extends Concept {
  mastery: MasteryState;
}

export interface SessionListItem {
  id: string;
  kind: SessionKind;
  conceptId: string | null;
  status: "active" | "completed";
  createdAt: string;
  completedAt: string | null;
  totalQuestions: number;
  answered: number;
  score: number | null;
}

export interface CourseOverview {
  course: Course;
  concepts: ConceptView[];
  readiness: ReadinessReport;
  sessions: SessionListItem[];
  /** The newest active session, whatever its kind. */
  activeSession: { id: string; kind: SessionKind } | null;
  /**
   * The course's active (unsubmitted) mock exam, if any — the session to resume.
   *
   * Diagnostic/Practice sessions are intentionally allowed to coexist with an active mock,
   * so `activeSession` (the newest active session) cannot answer "is a mock in progress?":
   * a diagnostic started after the mock would hide it. Mock detection therefore has its own
   * field, derived from every active session rather than from the newest one.
   *
   * A legacy database written before the one-active-mock lifecycle rule can hold more than
   * one active mock; this is the newest of them (the one to resume), and a non-null value
   * always means mock protection is active.
   */
  activeMockSession: { id: string; kind: "mock" } | null;
  questionCount: number;
}

export function getCourseOverview(courseId: string): CourseOverview {
  const row = db.getCourse(courseId);
  if (!row) throw new NotFoundError("Course");
  const course = courseFromRow(row);

  const concepts: Concept[] = db.getConcepts(courseId).map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    evidence: JSON.parse(c.evidenceJson),
    importance: c.importance,
  }));

  const attempts = db.getEligibleCourseAttempts(courseId, [...activeMockQuestionIds(courseId)]);
  const nowIso = new Date().toISOString();
  const masteryByConcept = new Map<string, MasteryState>();
  for (const concept of concepts) {
    const conceptAttempts = attempts.filter((a) => a.conceptId === concept.id);
    masteryByConcept.set(concept.id, computeMastery(concept.id, conceptAttempts, concept.importance, nowIso));
  }

  const sessions = db.listSessions(courseId);
  const sessionItems: SessionListItem[] = sessions.map((s) => {
    const sessAttempts = db.getSessionAttempts(s.id);
    return {
      id: s.id,
      kind: s.kind as SessionKind,
      conceptId: s.conceptId,
      status: s.status as "active" | "completed",
      createdAt: s.createdAt,
      completedAt: s.completedAt,
      totalQuestions: s.questionIds.length,
      answered: sessAttempts.length,
      score: null,
    };
  });

  const readiness = computeReadiness(
    concepts,
    masteryByConcept,
    {
      hasDiagnostic: sessions.some((s) => s.kind === "diagnostic" && s.status === "completed"),
      hasMock: sessions.some((s) => s.kind === "mock" && s.status === "completed"),
      hasPractice: sessions.some((s) => s.kind === "practice" && s.status === "completed"),
    },
  );

  const active = sessions.find((s) => s.status === "active");
  const activeMock = sessions.find((s) => s.kind === "mock" && s.status === "active");

  return {
    course,
    concepts: concepts.map((c) => ({ ...c, mastery: masteryByConcept.get(c.id)! })),
    readiness: {
      ...readiness,
      concepts: concepts.map((c) => masteryByConcept.get(c.id)!),
      weak: readiness.weak.map((w) => masteryByConcept.get(w.conceptId) ?? w),
      strong: readiness.strong.map((w) => masteryByConcept.get(w.conceptId) ?? w),
      untested: readiness.untested.map((w) => masteryByConcept.get(w.conceptId) ?? w),
    },
    sessions: sessionItems,
    activeSession: active ? { id: active.id, kind: active.kind as SessionKind } : null,
    activeMockSession: activeMock ? { id: activeMock.id, kind: "mock" } : null,
    questionCount: db.getQuestions(courseId).length,
  };
}

function courseFromRow(row: NonNullable<ReturnType<typeof db.getCourse>>): Course {
  return {
    id: row.id,
    title: row.title,
    sourceType: row.sourceType as Course["sourceType"],
    createdAt: row.createdAt,
    textLength: row.materialText.length,
    quality: JSON.parse(row.qualityJson),
  };
}

export function startSession(courseId: string, kind: SessionKind, conceptId?: string): Session {
  const row = db.getCourse(courseId);
  if (!row) throw new NotFoundError("Course");
  const concepts: Concept[] = db.getConcepts(courseId).map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    evidence: JSON.parse(c.evidenceJson),
    importance: c.importance,
  }));
  if (concepts.length === 0) throw new ConflictError("This course has no concepts to study.");

  // At most one active mock exam per course. A second active mock would share the same
  // persisted questions (sampling is deterministic per course), so its protection would
  // withhold the first mock's post-submit review and summary — breaking the deferred-
  // feedback product contract. Diagnostic/Practice may still coexist with a mock; only
  // mock-on-mock is rejected. Nothing is deleted or completed here.
  if (kind === "mock") {
    const activeMock = db.listSessions(courseId).find((s) => s.kind === "mock" && s.status === "active");
    if (activeMock) {
      throw new ConflictError(
        "A mock exam is already in progress for this course. Submit it before starting a new one.",
      );
    }
  }

  const questions: Question[] = db.getQuestions(courseId).map((q) => JSON.parse(q.payloadJson));

  let picked: Question[];
  if (kind === "practice") {
    const target = conceptId ?? weakestConceptId(courseId, concepts);
    if (!concepts.some((c) => c.id === target)) throw new NotFoundError("Concept");
    picked = samplePractice(questions, target, courseId);
    if (picked.length === 0) {
      throw new ConflictError(
        "No practice questions are available for this concept. The material may not contain enough grounded content about it.",
      );
    }
  } else if (kind === "diagnostic") {
    picked = sampleDiagnostic(questions, concepts, courseId);
  } else {
    picked = sampleMock(questions, concepts, courseId);
  }
  if (picked.length === 0) {
    throw new ConflictError(
      "No questions could be generated for this material. It is probably too short or unstructured — try material with headings and clear definitions (for example 'X is …').",
    );
  }

  const session: Session = {
    id: randomId("ses_"),
    courseId,
    kind,
    conceptId: kind === "practice" ? (conceptId ?? weakestConceptId(courseId, concepts)) : null,
    questionIds: picked.map((q) => q.id),
    status: "active",
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
  db.insertSession(session);
  return session;
}

function weakestConceptId(courseId: string, concepts: Concept[]): string {
  const attempts = db.getEligibleCourseAttempts(courseId, [...activeMockQuestionIds(courseId)]);
  const nowIso = new Date().toISOString();
  let worst = concepts[0];
  let worstMastery = 2;
  for (const c of concepts) {
    const m = computeMastery(c.id, attempts.filter((a) => a.conceptId === c.id), c.importance, nowIso);
    const score = m.status === "untested" ? 0.35 : m.mastery;
    if (score < worstMastery) {
      worstMastery = score;
      worst = c;
    }
  }
  return worst.id;
}

export interface SessionView {
  session: Session;
  questions: ClientQuestion[];
  /** The user's own saved answers (never the answer key). */
  givenAnswers: Record<string, AnswerValue>;
  /** For diagnostic/practice: grades revealed as answered. For mock: hidden until finish. */
  revealed: Record<string, GradeResult>;
  /**
   * Questions of this session whose answer-bearing feedback is withheld because they
   * belong to an active (unsubmitted) mock exam in the same course. Answers recorded
   * before that mock started stay stored (first answer counts) and their feedback
   * reappears once the mock is submitted; new answers to these questions are rejected
   * while the mock is active.
   */
  withheldQuestionIds: string[];
  answeredCount: number;
  review: SessionReviewItem[] | null;
  summary: SessionSummary | null;
}

/**
 * Question IDs protected by an active (unsubmitted) mock exam in this course.
 *
 * This is the single definition of mock protection. While a mock is active:
 * - no other session may grade its questions or disclose their correctness, answer key,
 *   explanation or answer-equivalent topic; and
 * - course-level mastery/readiness must not derive correctness from attempts for those
 *   questions, otherwise the aggregate becomes an oracle for the unsubmitted mock.
 *
 * A course normally has at most one active mock (`startSession` enforces it). Databases
 * written before that lifecycle rule can hold more than one, so the sets are unioned —
 * the fail-closed behaviour for that legacy state.
 */
function activeMockQuestionIds(courseId: string): Set<string> {
  const ids = new Set<string>();
  for (const session of db.listSessions(courseId)) {
    if (session.kind === "mock" && session.status === "active") {
      for (const questionId of session.questionIds) ids.add(questionId);
    }
  }
  return ids;
}

/**
 * Questions protected from the point of view of one session. The active mock itself owns
 * its questions (it defers feedback rather than withholding it), so it is unrestricted.
 */
function protectedQuestionIds(
  courseId: string,
  session: { kind: string; status: string },
): Set<string> {
  if (session.kind === "mock" && session.status === "active") return new Set<string>();
  return activeMockQuestionIds(courseId);
}

export function getSessionView(sessionId: string): SessionView {
  const session = db.getSession(sessionId);
  if (!session) throw new NotFoundError("Session");
  const allQuestions = db.getQuestions(session.courseId).map((q) => JSON.parse(q.payloadJson) as Question);
  const byId = new Map(allQuestions.map((q) => [q.id, q]));
  const sessionQuestions = session.questionIds.map((id) => byId.get(id)).filter((q): q is Question => Boolean(q));

  const protectedIds = protectedQuestionIds(session.courseId, session);
  const withheldQuestionIds = sessionQuestions.filter((q) => protectedIds.has(q.id)).map((q) => q.id);

  const attempts = db.getSessionAttempts(sessionId);
  const revealed: Record<string, GradeResult> = {};
  const givenAnswers: Record<string, AnswerValue> = {};
  const review: SessionReviewItem[] = [];
  for (const q of sessionQuestions) {
    const at = attempts.find((a) => a.questionId === q.id);
    if (at) {
      // The learner's own answer is never the answer key, so it stays visible even
      // while the question's feedback is withheld.
      const saved = JSON.parse(at.answerJson) as AnswerValue;
      givenAnswers[q.id] = saved;
      if (protectedIds.has(q.id)) continue;
      const result = gradeAnswer(q, saved);
      revealed[q.id] = result;
      review.push({ question: q, userAnswer: saved, result });
    } else if (!protectedIds.has(q.id)) {
      // Review items embed the persisted question, so withheld questions are omitted
      // entirely rather than shipped with a stripped result.
      review.push({ question: q, userAnswer: null, result: null });
    }
  }

  const completed = session.status === "completed";
  const isMock = session.kind === "mock";
  const sessionKind = session.kind as SessionKind;
  const sessionStatus = session.status as "active" | "completed";

  const clientQuestions = sessionQuestions.map((q) => {
    const isAnswered = attempts.some((a) => a.questionId === q.id);
    return clientQuestion(q, {
      sessionKind,
      sessionStatus,
      isAnswered,
      answerProtected: protectedIds.has(q.id),
    });
  });

  return {
    session: {
      id: session.id,
      courseId: session.courseId,
      kind: sessionKind,
      conceptId: session.conceptId,
      questionIds: session.questionIds,
      status: sessionStatus,
      createdAt: session.createdAt,
      completedAt: session.completedAt,
    },
    questions: clientQuestions,
    givenAnswers,
    // Mock exams hide correctness until submitted.
    revealed: completed || !isMock ? revealed : {},
    withheldQuestionIds,
    answeredCount: attempts.length,
    review: completed ? review : null,
    // A summary aggregates correctness across the whole session, so it is withheld
    // while any of its questions is protected by an active mock exam.
    summary: completed && withheldQuestionIds.length === 0 ? summarize(session, sessionQuestions, attempts) : null,
  };
}

export function answerQuestion(sessionId: string, questionId: string, answer: AnswerValue): { grade: GradeResult | null; answeredCount: number; total: number } {
  const session = db.getSession(sessionId);
  if (!session) throw new NotFoundError("Session");
  if (session.status === "completed") throw new ConflictError("This session is already completed.");
  if (!session.questionIds.includes(questionId)) throw new NotFoundError("Question in this session");

  // Cross-session mock protection: a question that belongs to an active mock exam is
  // graded only by that mock. Rejecting the write keeps the failure honest and prevents
  // this session from recording an answer whose feedback would reveal the mock's key.
  if (protectedQuestionIds(session.courseId, session).has(questionId)) {
    throw new ConflictError(
      "This question is part of an active mock exam. Submit the mock exam before answering it in another session.",
    );
  }

  const allQuestions = db.getQuestions(session.courseId).map((q) => JSON.parse(q.payloadJson) as Question);
  const question = allQuestions.find((q) => q.id === questionId);
  if (!question) throw new NotFoundError("Question");

  const existing = db.getAttempt(sessionId, questionId);
  if (existing) {
    // First answer counts — no retry until the score improves. Reveal the stored
    // grade again for immediate-feedback sessions.
    const stored = gradeAnswer(question, JSON.parse(existing.answerJson) as AnswerValue);
    return {
      grade: session.kind === "mock" ? null : stored,
      answeredCount: db.getSessionAttempts(sessionId).length,
      total: session.questionIds.length,
    };
  }

  const result = gradeAnswer(question, answer);
  db.insertAttempt({
    sessionId,
    courseId: session.courseId,
    questionId,
    conceptId: question.conceptId,
    answerJson: JSON.stringify(answer),
    score: result.score,
    correct: result.correct,
    createdAt: new Date().toISOString(),
  });

  const isMock = session.kind === "mock";
  return {
    grade: isMock ? null : result,
    answeredCount: db.getSessionAttempts(sessionId).length,
    total: session.questionIds.length,
  };
}

export function finishSession(sessionId: string): SessionView {
  const session = db.getSession(sessionId);
  if (!session) throw new NotFoundError("Session");
  if (session.status !== "completed") {
    if (session.kind === "diagnostic") {
      const attempts = db.getSessionAttempts(sessionId);
      const answeredQuestionIds = new Set(attempts.map((a) => a.questionId));
      const hasUnanswered = session.questionIds.some((qId) => !answeredQuestionIds.has(qId));
      if (hasUnanswered) {
        throw new ConflictError("Answer all diagnostic questions before finishing.");
      }
    }
    db.completeSession(sessionId, new Date().toISOString());
  }
  return getSessionView(sessionId);
}
