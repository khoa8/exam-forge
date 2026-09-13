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
} from "./types";
import { db } from "./db";
import { generateDeterministic } from "./provider/deterministic";
import { computeMastery } from "./mastery";
import { computeReadiness } from "./readiness";
import { gradeAnswer } from "./grade";
import { sampleDiagnostic, sampleMock, samplePractice } from "./sampler";
import { validateCourseViability } from "./validate";
import { randomId } from "./util";

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
  const output = generateDeterministic(input.text);

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
  activeSession: { id: string; kind: SessionKind } | null;
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

  const attempts = db.getCourseAttempts(courseId);
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
  const attempts = db.getCourseAttempts(courseId);
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
  /** Concept names for context display. */
  conceptNames: Record<string, string>;
  /** The user's own saved answers (never the answer key). */
  givenAnswers: Record<string, AnswerValue>;
  /** For diagnostic/practice: grades revealed as answered. For mock: hidden until finish. */
  revealed: Record<string, GradeResult>;
  answeredCount: number;
  review: SessionReviewItem[] | null;
  summary: SessionSummary | null;
}

export function getSessionView(sessionId: string): SessionView {
  const session = db.getSession(sessionId);
  if (!session) throw new NotFoundError("Session");
  const allQuestions = db.getQuestions(session.courseId).map((q) => JSON.parse(q.payloadJson) as Question);
  const byId = new Map(allQuestions.map((q) => [q.id, q]));
  const sessionQuestions = session.questionIds.map((id) => byId.get(id)).filter((q): q is Question => Boolean(q));
  const conceptNames: Record<string, string> = {};
  for (const q of sessionQuestions) conceptNames[q.conceptId] = q.conceptName;

  const attempts = db.getSessionAttempts(sessionId);
  const revealed: Record<string, GradeResult> = {};
  const givenAnswers: Record<string, AnswerValue> = {};
  const review: SessionReviewItem[] = [];
  for (const q of sessionQuestions) {
    const at = attempts.find((a) => a.questionId === q.id);
    if (at) {
      const saved = JSON.parse(at.answerJson) as AnswerValue;
      givenAnswers[q.id] = saved;
      const result = gradeAnswer(q, saved);
      revealed[q.id] = result;
      review.push({ question: q, userAnswer: saved, result });
    } else {
      review.push({ question: q, userAnswer: null, result: null });
    }
  }

  const completed = session.status === "completed";
  const isMock = session.kind === "mock";

  return {
    session: {
      id: session.id,
      courseId: session.courseId,
      kind: session.kind as SessionKind,
      conceptId: session.conceptId,
      questionIds: session.questionIds,
      status: session.status as "active" | "completed",
      createdAt: session.createdAt,
      completedAt: session.completedAt,
    },
    questions: sessionQuestions.map(clientQuestion),
    conceptNames,
    givenAnswers,
    // Mock exams hide correctness until submitted.
    revealed: completed || !isMock ? revealed : {},
    answeredCount: attempts.length,
    review: completed ? review : null,
    summary: completed ? summarize(session, sessionQuestions, attempts) : null,
  };
}

export function answerQuestion(sessionId: string, questionId: string, answer: AnswerValue): { grade: GradeResult | null; answeredCount: number; total: number } {
  const session = db.getSession(sessionId);
  if (!session) throw new NotFoundError("Session");
  if (session.status === "completed") throw new ConflictError("This session is already completed.");
  if (!session.questionIds.includes(questionId)) throw new NotFoundError("Question in this session");

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
    db.completeSession(sessionId, new Date().toISOString());
  }
  return getSessionView(sessionId);
}

function summarize(
  session: { id: string; kind: string; courseId: string },
  questions: Question[],
  attempts: { questionId: string; conceptId: string; score: number; correct: boolean }[],
): SessionSummary {
  const perConceptMap = new Map<string, { conceptId: string; conceptName: string; correct: number; attempts: number }>();
  for (const q of questions) {
    const entry = perConceptMap.get(q.conceptId) ?? {
      conceptId: q.conceptId,
      conceptName: q.conceptName,
      correct: 0,
      attempts: 0,
    };
    entry.attempts++;
    const at = attempts.find((a) => a.questionId === q.id);
    if (at && at.correct) entry.correct++;
    perConceptMap.set(q.conceptId, entry);
  }
  const answered = attempts.filter((a) => questions.some((q) => q.id === a.questionId));
  return {
    sessionId: session.id,
    kind: session.kind as SessionKind,
    courseId: session.courseId,
    status: "completed",
    totalQuestions: questions.length,
    answered: answered.length,
    correct: answered.filter((a) => a.correct).length,
    score: answered.length > 0 ? answered.reduce((s, a) => s + a.score, 0) / questions.length : 0,
    perConcept: Array.from(perConceptMap.values()),
  };
}

/** Strip the answer key before sending a question to the client. */
export function clientQuestion(q: Question): ClientQuestion {
  return {
    id: q.id,
    conceptId: q.conceptId,
    conceptName: q.conceptName,
    prompt: q.prompt,
    difficulty: q.difficulty,
    type: q.type,
    ...(q.type === "mcq" ? { options: q.options } : {}),
    ...(q.type === "truefalse" ? { statement: q.statement } : {}),
  };
}
