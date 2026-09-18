import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setDbPathForTests, db } from "@/lib/db";
import {
  answerQuestion,
  ConflictError,
  createCourse,
  finishSession,
  getCourseOverview,
  getSessionView,
  startSession,
  type CourseOverview,
  type SessionView,
} from "@/lib/service";
import { SAMPLE_MATERIAL } from "@/sample/material";
import { ingestText } from "@/lib/ingest";
import type { AnswerValue, Question, Session } from "@/lib/types";

/**
 * Active-mock session isolation.
 *
 * Mock exams defer correctness until submission. That protection belongs to the
 * QUESTION, not to the mock's own response: while a mock is unsubmitted, no other
 * session in the course (a concurrent Diagnostic/Practice session, or a session that
 * already answered the same persisted question) may grade it or disclose its answer key.
 *
 * These tests exercise the failure class rather than one seeded accident: they discover
 * the real overlap produced by the deterministic sampler on the bundled demo material,
 * then assert the cross-session disclosure is closed in both session-creation orderings
 * and for pre-existing conflicting state.
 */

let tmpDir: string;
let dbFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "examforge-mock-isolation-"));
  dbFile = path.join(tmpDir, "test.sqlite");
  setDbPathForTests(dbFile);
});

afterEach(() => {
  setDbPathForTests(path.join(os.tmpdir(), `examforge-mock-isolation-reset-${Date.now()}.sqlite`));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function createDemoCourse(): Promise<{ courseId: string; questions: Question[] }> {
  const ingested = ingestText(SAMPLE_MATERIAL);
  const { courseId } = await createCourse({
    text: ingested.text,
    sourceType: "bundled",
    ingestionWarnings: ingested.warnings,
  });
  const questions: Question[] = db.getQuestions(courseId).map((q) => JSON.parse(q.payloadJson) as Question);
  return { courseId, questions };
}

interface OverlapSetup {
  courseId: string;
  questions: Question[];
  mock: Session;
  /** The immediate-feedback session that shares at least one question with the mock. */
  other: Session;
  overlapping: Question;
}

/**
 * Build a real, reachable setup in which an immediate-feedback session shares a question
 * with an active mock exam. Sampling is seeded on the randomly generated course id, so a
 * course is generated and inspected until the sampler produces the overlap; failing to
 * find one is itself a test failure (it would mean the defect is unreachable).
 */
async function findOverlappingSetup(
  otherKind: "diagnostic" | "practice",
  order: "mock-first" | "other-first",
): Promise<OverlapSetup> {
  for (let attempt = 0; attempt < 25; attempt++) {
    const { courseId, questions } = await createDemoCourse();
    const conceptIds = Array.from(new Set(questions.map((q) => q.conceptId)));
    const mockFirst = order === "mock-first";

    const mock = mockFirst ? startSession(courseId, "mock") : null;
    const others =
      otherKind === "diagnostic"
        ? [startSession(courseId, "diagnostic")]
        : conceptIds.map((conceptId) => startSession(courseId, "practice", conceptId));
    const activeMock = mock ?? startSession(courseId, "mock");

    for (const other of others) {
      const inMock = new Set(activeMock.questionIds);
      const overlap = other.questionIds.filter((id) => inMock.has(id));
      if (overlap.length > 0) {
        return {
          courseId,
          questions,
          mock: activeMock,
          other,
          overlapping: questions.find((q) => q.id === overlap[0])!,
        };
      }
    }
  }
  throw new Error(`No reachable ${otherKind} overlap with an active mock exam was reproduced`);
}

/**
 * Same idea, but the immediate-feedback session is answered and completed *before* the
 * mock starts, which is the normal sequential journey (diagnostic -> mock).
 */
async function findCompletedSessionOverlap(): Promise<OverlapSetup & { beforeMock: SessionView }> {
  for (let attempt = 0; attempt < 25; attempt++) {
    const { courseId, questions } = await createDemoCourse();
    const diagnostic = startSession(courseId, "diagnostic");
    for (const q of getSessionView(diagnostic.id).questions) {
      answerQuestion(diagnostic.id, q.id, anyAnswer(persisted(questions, q.id)));
    }
    finishSession(diagnostic.id);
    const beforeMock = getSessionView(diagnostic.id);

    const mock = startSession(courseId, "mock");
    const inMock = new Set(mock.questionIds);
    const overlap = diagnostic.questionIds.filter((id) => inMock.has(id));
    if (overlap.length > 0) {
      return {
        courseId,
        questions,
        mock,
        other: diagnostic,
        overlapping: persisted(questions, overlap[0]),
        beforeMock,
      };
    }
  }
  throw new Error("No reachable completed-diagnostic overlap with a mock exam was reproduced");
}

const ANSWER_KEY_FIELDS = [
  "correctOptionId",
  "correctAnswer",
  "acceptedAnswers",
  "keyTerms",
  "modelAnswer",
  "explanation",
  "falseProof",
  "evidence",
  "result",
  "conceptId",
];

function collectKeys(value: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      collectKeys(child, into);
    }
  }
  return into;
}

/** No answer-bearing record for this specific question may appear in the view. */
function expectNoDisclosureFor(view: SessionView, q: Question) {
  expect(view.revealed[q.id]).toBeUndefined();
  expect(view.review?.some((item) => item.question.id === q.id) ?? false).toBe(false);
  const clientQ = view.questions.find((item) => item.id === q.id);
  expect(clientQ).toBeDefined();
  const keys = collectKeys(clientQ, new Set<string>());
  for (const field of ANSWER_KEY_FIELDS) {
    expect(keys.has(field)).toBe(false);
  }
}

function anyAnswer(q: Question): AnswerValue {
  if (q.type === "mcq") return { type: "option", optionId: q.options[0].id };
  if (q.type === "truefalse") return { type: "boolean", value: true };
  return { type: "text", text: "an attempt" };
}

function correctAnswer(q: Question): AnswerValue {
  if (q.type === "mcq") return { type: "option", optionId: q.correctOptionId };
  if (q.type === "truefalse") return { type: "boolean", value: q.correctAnswer };
  return { type: "text", text: q.modelAnswer };
}

/** A deterministically wrong answer for every question type (always scores 0). */
function wrongAnswer(q: Question): AnswerValue {
  if (q.type === "mcq") return { type: "option", optionId: q.options.find((o) => o.id !== q.correctOptionId)!.id };
  if (q.type === "truefalse") return { type: "boolean", value: !q.correctAnswer };
  return { type: "text", text: "definitely wrong zzz" };
}

function persisted(questions: Question[], id: string): Question {
  return questions.find((q) => q.id === id)!;
}

/** The correctness-derived fields of a concept's learner-visible mastery state. */
interface Exposure {
  conceptId: string;
  attempts: number;
  correct: number;
  mastery: number;
  confidence: number;
  status: string;
  recentCorrect: number;
  lastSeen: string | null;
}

function exposure(overview: CourseOverview, conceptIds: string[]): Exposure[] {
  return conceptIds.map((conceptId) => {
    const m = overview.concepts.find((c) => c.id === conceptId)!.mastery;
    return {
      conceptId,
      attempts: m.attempts,
      correct: m.correct,
      mastery: m.mastery,
      confidence: m.confidence,
      status: m.status,
      recentCorrect: m.recentCorrect,
      lastSeen: m.lastSeen,
    };
  });
}

interface AggregateProbe {
  courseId: string;
  questions: Question[];
  diagnostic: Session;
  mock: Session;
  /** Concepts whose only pre-mock attempt is for a question the active mock protects. */
  protectedConceptIds: string[];
  /** Course overview captured before the mock started (control). */
  beforeMock: CourseOverview;
  /** How many of the mock's questions belong to each concept. */
  mockQuestionsPerConcept: Map<string, number>;
}

/**
 * Build the reachable setup for the course-level aggregate question: a completed
 * Diagnostic that answered every question either correctly or incorrectly, followed by a
 * mock that protects at least one of those same persisted questions.
 */
async function buildAggregateProbe(answerCorrectly: boolean): Promise<AggregateProbe> {
  for (let attempt = 0; attempt < 25; attempt++) {
    const { courseId, questions } = await createDemoCourse();
    const diagnostic = startSession(courseId, "diagnostic");
    for (const q of getSessionView(diagnostic.id).questions) {
      const question = persisted(questions, q.id);
      answerQuestion(diagnostic.id, q.id, answerCorrectly ? correctAnswer(question) : wrongAnswer(question));
    }
    finishSession(diagnostic.id);
    const beforeMock = getCourseOverview(courseId);

    const mock = startSession(courseId, "mock");
    const inMock = new Set(mock.questionIds);
    const overlap = diagnostic.questionIds.filter((id) => inMock.has(id));
    if (overlap.length === 0) continue;

    const mockQuestionsPerConcept = new Map<string, number>();
    for (const id of mock.questionIds) {
      const conceptId = persisted(questions, id).conceptId;
      mockQuestionsPerConcept.set(conceptId, (mockQuestionsPerConcept.get(conceptId) ?? 0) + 1);
    }
    return {
      courseId,
      questions,
      diagnostic,
      mock,
      protectedConceptIds: Array.from(new Set(overlap.map((id) => persisted(questions, id).conceptId))),
      beforeMock,
      mockQuestionsPerConcept,
    };
  }
  throw new Error("No reachable overlap between a completed diagnostic and a mock was reproduced");
}

describe("active mock exam protects its questions across sessions", () => {
  it("blocks a diagnostic started after a mock from disclosing the mock's answer key", async () => {
    const { questions, mock, other: diagnostic, overlapping } = await findOverlappingSetup("diagnostic", "mock-first");

    const diagView = getSessionView(diagnostic.id);
    expect(diagView.withheldQuestionIds).toContain(overlapping.id);
    expectNoDisclosureFor(diagView, overlapping);

    // Submitting an answer through the other session is rejected, so no grade — and no
    // attempt from which a grade could later be derived — is created.
    expect(() => answerQuestion(diagnostic.id, overlapping.id, anyAnswer(overlapping))).toThrow(ConflictError);
    expect(() => answerQuestion(diagnostic.id, overlapping.id, anyAnswer(overlapping))).toThrow(/active mock exam/i);
    expect(db.getSessionAttempts(diagnostic.id)).toHaveLength(0);
    expectNoDisclosureFor(getSessionView(diagnostic.id), overlapping);

    // Questions outside the mock keep normal immediate feedback in the same session.
    const free = diagView.questions.find((q) => !mock.questionIds.includes(q.id));
    if (free) {
      const res = answerQuestion(diagnostic.id, free.id, anyAnswer(persisted(questions, free.id)));
      expect(res.grade).not.toBeNull();
    }

    // The mock itself is untouched: still active, still deferring its own feedback.
    const mockView = getSessionView(mock.id);
    expect(mockView.session.status).toBe("active");
    expect(mockView.revealed).toEqual({});
    expect(mockView.withheldQuestionIds).toEqual([]);
    expect(answerQuestion(mock.id, overlapping.id, correctAnswer(overlapping)).grade).toBeNull();
  });

  it("blocks a mock started after a practice session from turning practice into a disclosure channel", async () => {
    const { questions, mock, other: practice, overlapping } = await findOverlappingSetup("practice", "other-first");

    const practiceView = getSessionView(practice.id);
    expect(practiceView.withheldQuestionIds).toContain(overlapping.id);
    expectNoDisclosureFor(practiceView, overlapping);
    expect(() => answerQuestion(practice.id, overlapping.id, anyAnswer(overlapping))).toThrow(ConflictError);
    expect(db.getSessionAttempts(practice.id)).toHaveLength(0);

    // Submitting the mock ends the protection: the question is answerable again with
    // normal immediate feedback.
    for (const q of getSessionView(mock.id).questions) {
      answerQuestion(mock.id, q.id, anyAnswer(persisted(questions, q.id)));
    }
    finishSession(mock.id);

    const afterMock = getSessionView(practice.id);
    expect(afterMock.withheldQuestionIds).toEqual([]);
    expect(answerQuestion(practice.id, overlapping.id, anyAnswer(overlapping)).grade).not.toBeNull();
    expect(getSessionView(practice.id).revealed[overlapping.id]).toBeDefined();
  });

  it("withholds a completed session's review and summary while an overlapping mock is active", async () => {
    const { questions, mock, other: diagnostic, overlapping, beforeMock } = await findCompletedSessionOverlap();

    // The diagnostic is legitimate completed history before the mock exists.
    expect(beforeMock.review).not.toBeNull();
    expect(beforeMock.summary).not.toBeNull();
    expect(beforeMock.withheldQuestionIds).toEqual([]);
    expect(beforeMock.review!.some((item) => item.question.id === overlapping.id)).toBe(true);

    const duringMock = getSessionView(diagnostic.id);
    expect(duringMock.withheldQuestionIds).toContain(overlapping.id);
    expectNoDisclosureFor(duringMock, overlapping);
    // A summary aggregates correctness, so it is withheld too.
    expect(duringMock.summary).toBeNull();
    // Non-overlapping review items stay available.
    const unprotected = beforeMock.review!.filter((item) => item.question.id !== overlapping.id);
    if (unprotected.length > 0) {
      expect(duringMock.review!.length).toBeGreaterThan(0);
    }

    // Submitting the mock restores the completed view completely.
    for (const q of getSessionView(mock.id).questions) {
      answerQuestion(mock.id, q.id, anyAnswer(persisted(questions, q.id)));
    }
    finishSession(mock.id);

    const restored = getSessionView(diagnostic.id);
    expect(restored.withheldQuestionIds).toEqual([]);
    expect(restored.summary).not.toBeNull();
    expect(restored.review!.some((item) => item.question.id === overlapping.id)).toBe(true);
    expect(restored.revealed[overlapping.id]).toBeDefined();
  });

  it("handles pre-existing conflicting state (mock row written outside the service) fail-closed", async () => {
    const { courseId, questions } = await createDemoCourse();

    const diagnostic = startSession(courseId, "diagnostic");
    const target = getSessionView(diagnostic.id).questions[0];

    // Simulate a database written by a pre-fix build: a mock session row that coexists
    // with the active diagnostic and covers one of its questions.
    const legacyMockId = "ses_legacy_mock";
    db.insertSession({
      id: legacyMockId,
      courseId,
      kind: "mock",
      conceptId: null,
      questionIds: [target.id],
      createdAt: new Date().toISOString(),
    });

    const view = getSessionView(diagnostic.id);
    expect(view.withheldQuestionIds).toEqual([target.id]);
    expectNoDisclosureFor(view, persisted(questions, target.id));
    expect(() => answerQuestion(diagnostic.id, target.id, anyAnswer(persisted(questions, target.id)))).toThrow(
      ConflictError,
    );
    expect(db.getSessionAttempts(diagnostic.id)).toHaveLength(0);

    // The legacy mock still works, and submitting it releases the diagnostic.
    expect(answerQuestion(legacyMockId, target.id, anyAnswer(persisted(questions, target.id))).grade).toBeNull();
    expect(getSessionView(legacyMockId).revealed).toEqual({});
    finishSession(legacyMockId);

    expect(getSessionView(diagnostic.id).withheldQuestionIds).toEqual([]);
    expect(answerQuestion(diagnostic.id, target.id, anyAnswer(persisted(questions, target.id))).grade).not.toBeNull();
  });

  it("keeps normal mock behaviour: deferred feedback while active, full review after submit", async () => {
    const { courseId, questions } = await createDemoCourse();
    const mock = startSession(courseId, "mock");
    const view = getSessionView(mock.id);
    expect(view.questions.length).toBeGreaterThan(0);
    expect(view.withheldQuestionIds).toEqual([]);

    for (const q of view.questions) {
      expect(answerQuestion(mock.id, q.id, anyAnswer(persisted(questions, q.id))).grade).toBeNull();
    }
    const activeView = getSessionView(mock.id);
    expect(activeView.revealed).toEqual({});
    expect(activeView.review).toBeNull();
    expect(activeView.summary).toBeNull();

    const finished = finishSession(mock.id);
    expect(finished.session.status).toBe("completed");
    expect(finished.withheldQuestionIds).toEqual([]);
    expect(finished.review).not.toBeNull();
    expect(finished.summary).not.toBeNull();
    for (const item of finished.review!) {
      expect(item.question.explanation.length).toBeGreaterThan(10);
      expect(item.result).not.toBeNull();
    }
  });

  it("keeps normal diagnostic and practice immediate feedback when no mock is active", async () => {
    const { courseId, questions } = await createDemoCourse();

    const diagnostic = startSession(courseId, "diagnostic");
    const diagQ = getSessionView(diagnostic.id).questions[0];
    expect(answerQuestion(diagnostic.id, diagQ.id, anyAnswer(persisted(questions, diagQ.id))).grade).not.toBeNull();
    const diagView = getSessionView(diagnostic.id);
    expect(diagView.withheldQuestionIds).toEqual([]);
    expect(diagView.revealed[diagQ.id]).toBeDefined();

    const conceptId = persisted(questions, diagQ.id).conceptId;
    const practice = startSession(courseId, "practice", conceptId);
    const practiceQ = getSessionView(practice.id).questions[0];
    expect(answerQuestion(practice.id, practiceQ.id, anyAnswer(persisted(questions, practiceQ.id))).grade).not.toBeNull();
    const practiceView = getSessionView(practice.id);
    expect(practiceView.withheldQuestionIds).toEqual([]);
    expect(practiceView.revealed[practiceQ.id]).toBeDefined();
  });

  it("preserves first-answer-counts", async () => {
    const { courseId, questions } = await createDemoCourse();
    const diagnostic = startSession(courseId, "diagnostic");
    const q = getSessionView(diagnostic.id).questions[0];
    const question = persisted(questions, q.id);

    const first = answerQuestion(diagnostic.id, q.id, anyAnswer(question));
    expect(first.grade).not.toBeNull();
    expect(db.getSessionAttempts(diagnostic.id)).toHaveLength(1);

    // A later answer (even the true key) cannot replace the recorded outcome.
    const second = answerQuestion(diagnostic.id, q.id, correctAnswer(question));
    expect(second.grade).toEqual(first.grade);
    expect(db.getSessionAttempts(diagnostic.id)).toHaveLength(1);
  });
});

describe("course-level signals do not reveal protected mock answers", () => {
  it("cannot distinguish a correct from an incorrect prior answer while the mock is active", async () => {
    for (const answeredCorrectly of [true, false]) {
      const probe = await buildAggregateProbe(answeredCorrectly);
      expect(probe.protectedConceptIds.length).toBeGreaterThan(0);

      // Control: with no active mock the aggregate is genuinely sensitive to the answer,
      // so the assertions below are not vacuously true.
      const control = exposure(probe.beforeMock, probe.protectedConceptIds);
      expect(control.every((e) => e.attempts === 1)).toBe(true);
      expect(control.every((e) => e.correct === (answeredCorrectly ? 1 : 0))).toBe(true);

      // While the mock is active, every correctness-derived signal for those concepts
      // collapses to the neutral untested state — identical for a correct and an
      // incorrect prior answer, so the protected question's key cannot be inferred.
      const during = exposure(getCourseOverview(probe.courseId), probe.protectedConceptIds);
      for (const e of during) {
        expect(e).toEqual({
          conceptId: e.conceptId,
          attempts: 0,
          correct: 0,
          mastery: 0,
          confidence: 0,
          status: "untested",
          recentCorrect: 0,
          lastSeen: null,
        });
      }

      // The learner's own history is preserved, and the plan treats it as untested
      // rather than as a wrong answer (which would itself be a correctness signal).
      expect(db.getSessionAttempts(probe.diagnostic.id)).toHaveLength(probe.diagnostic.questionIds.length);
      const overview = getCourseOverview(probe.courseId);
      for (const conceptId of probe.protectedConceptIds) {
        expect(overview.readiness.untested.map((u) => u.conceptId)).toContain(conceptId);
        expect(overview.readiness.weak.map((w) => w.conceptId)).not.toContain(conceptId);
        expect(overview.readiness.strong.map((s) => s.conceptId)).not.toContain(conceptId);
      }

      // Submitting the mock releases the legitimate history: the diagnostic attempt
      // counts again, plus the mock's own (deliberately wrong) attempt.
      for (const q of getSessionView(probe.mock.id).questions) {
        answerQuestion(probe.mock.id, q.id, wrongAnswer(persisted(probe.questions, q.id)));
      }
      finishSession(probe.mock.id);

      const released = exposure(getCourseOverview(probe.courseId), probe.protectedConceptIds);
      for (const e of released) {
        expect(e.attempts).toBe(1 + (probe.mockQuestionsPerConcept.get(e.conceptId) ?? 0));
        expect(e.correct).toBe(answeredCorrectly ? 1 : 0);
      }
    }
  });

  it("keeps active mock attempts out of learner-visible signals until submission", async () => {
    const { courseId, questions } = await createDemoCourse();
    const mock = startSession(courseId, "mock");
    const before = getCourseOverview(courseId);

    for (const q of getSessionView(mock.id).questions) {
      expect(answerQuestion(mock.id, q.id, correctAnswer(persisted(questions, q.id))).grade).toBeNull();
    }
    const during = getCourseOverview(courseId);
    expect(during.readiness.readiness).toBe(before.readiness.readiness);
    expect(during.concepts.map((c) => c.mastery.attempts)).toEqual(before.concepts.map((c) => c.mastery.attempts));

    finishSession(mock.id);
    const after = getCourseOverview(courseId);
    expect(after.concepts.reduce((sum, c) => sum + c.mastery.attempts, 0)).toBe(
      before.concepts.reduce((sum, c) => sum + c.mastery.attempts, 0) + mock.questionIds.length,
    );
  });
});

describe("session listing order", () => {
  it("lists sessions newest first when several share the same millisecond timestamp", async () => {
    const { courseId } = await createDemoCourse();

    // `created_at` has millisecond precision, so rows written back-to-back can share it.
    // The overview's "newest active session" is only meaningful if listing is deterministic.
    const createdAt = new Date().toISOString();
    const ids = ["ses_same_ms_a", "ses_same_ms_b", "ses_same_ms_c"];
    for (const id of ids) {
      db.insertSession({ id, courseId, kind: "diagnostic", conceptId: null, questionIds: [], createdAt });
    }

    expect(db.listSessions(courseId).map((s) => s.id)).toEqual([...ids].reverse());
    expect(getCourseOverview(courseId).activeSession).toEqual({ id: ids[ids.length - 1], kind: "diagnostic" });
  });
});

describe("an active mock stays identifiable while a later session coexists", () => {
  it("reports the active mock independently of whichever active session is newest", async () => {
    const { courseId, questions } = await createDemoCourse();

    const mockA = startSession(courseId, "mock");
    const onlyMock = getCourseOverview(courseId);
    expect(onlyMock.activeSession).toEqual({ id: mockA.id, kind: "mock" });
    expect(onlyMock.activeMockSession).toEqual({ id: mockA.id, kind: "mock" });

    // A Diagnostic started after the mock is allowed to coexist and becomes the newest
    // active session, so the singular `activeSession` no longer names the mock.
    const diagnostic = startSession(courseId, "diagnostic");
    const withDiagnostic = getCourseOverview(courseId);
    expect(withDiagnostic.activeSession).toEqual({ id: diagnostic.id, kind: "diagnostic" });
    expect(withDiagnostic.sessions.find((s) => s.id === mockA.id)!.status).toBe("active");
    expect(withDiagnostic.sessions.find((s) => s.id === diagnostic.id)!.status).toBe("active");

    // The mock is still identifiable, so the UI can keep offering the resume path and keep
    // explaining that the mock's questions are excluded from mastery/readiness.
    expect(withDiagnostic.activeMockSession).toEqual({ id: mockA.id, kind: "mock" });

    // Practice as the later session behaves the same way.
    const practiceConceptId = persisted(questions, mockA.questionIds[0]).conceptId;
    const practice = startSession(courseId, "practice", practiceConceptId);
    const withPractice = getCourseOverview(courseId);
    expect(withPractice.activeSession).toEqual({ id: practice.id, kind: "practice" });
    expect(withPractice.activeMockSession).toEqual({ id: mockA.id, kind: "mock" });

    // Submitting the mock clears the signal instead of leaving a stale "in progress" state.
    for (const q of getSessionView(mockA.id).questions) {
      answerQuestion(mockA.id, q.id, anyAnswer(persisted(questions, q.id)));
    }
    finishSession(mockA.id);
    expect(getCourseOverview(courseId).activeMockSession).toBeNull();
  });

  it("reports no active mock when only diagnostic/practice sessions are active", async () => {
    const { courseId, questions } = await createDemoCourse();

    const diagnostic = startSession(courseId, "diagnostic");
    const conceptId = persisted(questions, getSessionView(diagnostic.id).questions[0].id).conceptId;
    startSession(courseId, "practice", conceptId);

    const overview = getCourseOverview(courseId);
    expect(overview.activeSession?.kind).toBe("practice");
    expect(overview.activeMockSession).toBeNull();
  });
});

describe("at most one active mock exam per course", () => {
  it("rejects a second active mock and keeps the first mock's lifecycle intact", async () => {
    const { courseId, questions } = await createDemoCourse();

    const mockA = startSession(courseId, "mock");
    expect(() => startSession(courseId, "mock")).toThrow(ConflictError);
    expect(() => startSession(courseId, "mock")).toThrow(/already in progress/i);

    // The rejected start created no second session row.
    const mockSessions = db.listSessions(courseId).filter((s) => s.kind === "mock");
    expect(mockSessions).toHaveLength(1);
    expect(mockSessions[0].id).toBe(mockA.id);
    expect(mockSessions[0].status).toBe("active");

    // Diagnostic and Practice may still coexist with the active mock.
    const diagnostic = startSession(courseId, "diagnostic");
    expect(diagnostic.status).toBe("active");
    const practiceConceptId = persisted(questions, mockA.questionIds[0]).conceptId;
    expect(startSession(courseId, "practice", practiceConceptId).status).toBe("active");

    // The first mock keeps deferred feedback, then a complete post-submit review.
    const viewA = getSessionView(mockA.id);
    expect(viewA.withheldQuestionIds).toEqual([]);
    for (const q of viewA.questions) {
      expect(answerQuestion(mockA.id, q.id, anyAnswer(persisted(questions, q.id))).grade).toBeNull();
    }
    const finishedA = finishSession(mockA.id);
    expect(finishedA.session.status).toBe("completed");
    expect(finishedA.withheldQuestionIds).toEqual([]);
    expect(finishedA.summary).not.toBeNull();
    expect(finishedA.review).toHaveLength(viewA.questions.length);

    // A new mock can be started once the previous one is completed.
    const mockB = startSession(courseId, "mock");
    expect(mockB.id).not.toBe(mockA.id);
    expect(getSessionView(mockB.id).session.status).toBe("active");
  });

  it("keeps legacy databases with two active mocks fail-closed and recovers on submission", async () => {
    // A completed diagnostic whose history covers at least one question the mock protects.
    // Sampling is seeded on the random course id, so this is discovered, not assumed.
    const { courseId, questions, mock: mockA, other: diagnostic } = await findCompletedSessionOverlap();
    const overlap = diagnostic.questionIds.filter((id) => mockA.questionIds.includes(id));

    // Simulate a database written before the one-active-mock lifecycle rule existed.
    const legacyMockId = "ses_legacy_mock";
    db.insertSession({
      id: legacyMockId,
      courseId,
      kind: "mock",
      conceptId: null,
      questionIds: [...mockA.questionIds],
      createdAt: new Date().toISOString(),
    });

    const protectedConceptIds = Array.from(new Set(overlap.map((id) => persisted(questions, id).conceptId)));

    // The union of both active mocks still protects the shared questions, including
    // against the course-level aggregate.
    const overview = getCourseOverview(courseId);
    for (const e of exposure(overview, protectedConceptIds)) {
      expect(e).toEqual({
        conceptId: e.conceptId,
        attempts: 0,
        correct: 0,
        mastery: 0,
        confidence: 0,
        status: "untested",
        recentCorrect: 0,
        lastSeen: null,
      });
    }
    expect(() => answerQuestion(diagnostic.id, overlap[0], anyAnswer(persisted(questions, overlap[0])))).toThrow(
      ConflictError,
    );

    // Documented compatibility limitation: submitting one of the legacy duplicates keeps
    // its review withheld while the other still protects the same questions. It is
    // fail-closed (no answer key is disclosed) and resolves without data loss.
    for (const q of getSessionView(mockA.id).questions) {
      answerQuestion(mockA.id, q.id, anyAnswer(persisted(questions, q.id)));
    }
    const finishedA = finishSession(mockA.id);
    expect(finishedA.session.status).toBe("completed");
    expect(finishedA.withheldQuestionIds).toEqual(expect.arrayContaining(mockA.questionIds));
    expect(finishedA.summary).toBeNull();

    // Submitting the remaining legacy mock releases everything; no attempt was deleted.
    finishSession(legacyMockId);
    const released = getSessionView(mockA.id);
    expect(released.withheldQuestionIds).toEqual([]);
    expect(released.summary).not.toBeNull();
    expect(released.review).toHaveLength(mockA.questionIds.length);
    expect(db.getSessionAttempts(diagnostic.id)).toHaveLength(diagnostic.questionIds.length);
    expect(db.getSessionAttempts(mockA.id)).toHaveLength(mockA.questionIds.length);
  });
});
