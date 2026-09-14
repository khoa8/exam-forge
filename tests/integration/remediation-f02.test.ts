import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setDbPathForTests, db } from "@/lib/db";
import {
  createCourse,
  startSession,
  getSessionView,
  answerQuestion,
  finishSession,
  getCourseOverview,
} from "@/lib/service";
import { SAMPLE_MATERIAL } from "@/sample/material";
import { ingestText } from "@/lib/ingest";
import type { Question } from "@/lib/types";

let tmpDir: string;
let dbFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "examforge-f02-"));
  dbFile = path.join(tmpDir, "test.sqlite");
  setDbPathForTests(dbFile);
});

afterEach(() => {
  setDbPathForTests(path.join(os.tmpdir(), `examforge-f02-reset-${Date.now()}.sqlite`));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("F-02 remediation: active mock attempts excluded from mastery/readiness signals", () => {
  it("freezes learner-visible derived signals until mock completion and counts attempts exactly once", async () => {
    // 1. Create real course from bundled material.
    const ingested = ingestText(SAMPLE_MATERIAL);
    const { courseId } = await createCourse({
      text: ingested.text,
      sourceType: "bundled",
      ingestionWarnings: ingested.warnings,
    });

    const persistedQuestions: Question[] = db
      .getQuestions(courseId)
      .map((q) => JSON.parse(q.payloadJson));

    // 2. Establish prior diagnostic history to establish a meaningful baseline.
    const diagnostic = startSession(courseId, "diagnostic");
    const diagView = getSessionView(diagnostic.id);
    for (let i = 0; i < diagView.questions.length; i++) {
      const q = diagView.questions[i];
      const persisted = persistedQuestions.find((p) => p.id === q.id)!;
      // Answer half correctly and half incorrectly to get a mix of statuses.
      if (i % 2 === 0) {
        if (persisted.type === "mcq") {
          answerQuestion(diagnostic.id, q.id, { type: "option", optionId: persisted.correctOptionId });
        } else if (persisted.type === "truefalse") {
          answerQuestion(diagnostic.id, q.id, { type: "boolean", value: persisted.correctAnswer });
        } else {
          answerQuestion(diagnostic.id, q.id, { type: "text", text: persisted.modelAnswer });
        }
      } else {
        if (persisted.type === "mcq") {
          const wrong = persisted.options.find((o) => o.id !== persisted.correctOptionId)!;
          answerQuestion(diagnostic.id, q.id, { type: "option", optionId: wrong.id });
        } else if (persisted.type === "truefalse") {
          answerQuestion(diagnostic.id, q.id, { type: "boolean", value: !persisted.correctAnswer });
        } else {
          answerQuestion(diagnostic.id, q.id, { type: "text", text: "completely wrong answer" });
        }
      }
    }
    finishSession(diagnostic.id);

    // 3. Capture full baseline overview state across all concepts and readiness signals.
    const baselineOverview = getCourseOverview(courseId);
    expect(baselineOverview.readiness.coverage).toBeGreaterThan(0);

    const snapshotConcepts = (overview: ReturnType<typeof getCourseOverview>) =>
      overview.concepts.map((c) => ({
        id: c.id,
        attempts: c.mastery.attempts,
        correct: c.mastery.correct,
        mastery: c.mastery.mastery,
        confidence: c.mastery.confidence,
        status: c.mastery.status,
        recentCorrect: c.mastery.recentCorrect,
        lastSeen: c.mastery.lastSeen,
        reviewPriority: c.mastery.reviewPriority,
        nextReviewInDays: c.mastery.nextReviewInDays,
      }));

    const snapshotReadiness = (overview: ReturnType<typeof getCourseOverview>) => ({
      readiness: overview.readiness.readiness,
      overallConfidence: overview.readiness.overallConfidence,
      coverage: overview.readiness.coverage,
      weak: overview.readiness.weak.map((w) => w.conceptId),
      strong: overview.readiness.strong.map((s) => s.conceptId),
      untested: overview.readiness.untested.map((u) => u.conceptId),
      nextActionKind: overview.readiness.nextAction.kind,
      nextActionConcept: overview.readiness.nextAction.conceptId,
    });

    const baselineConceptSnapshots = snapshotConcepts(baselineOverview);
    const baselineReadinessSnapshot = snapshotReadiness(baselineOverview);

    const assertConceptMasteryUnchanged = (
      actual: ReturnType<typeof snapshotConcepts>,
      baseline: ReturnType<typeof snapshotConcepts>,
    ) => {
      expect(actual.length).toBe(baseline.length);
      for (let i = 0; i < actual.length; i++) {
        const a = actual[i];
        const b = baseline[i];
        expect(a.id).toBe(b.id);
        expect(a.attempts).toBe(b.attempts);
        expect(a.correct).toBe(b.correct);
        expect(a.mastery).toBe(b.mastery);
        expect(a.confidence).toBe(b.confidence);
        expect(a.status).toBe(b.status);
        expect(a.recentCorrect).toBe(b.recentCorrect);
        expect(a.lastSeen).toBe(b.lastSeen);
        expect(a.nextReviewInDays).toBe(b.nextReviewInDays);
        // Review priority includes staleness based on timestamp age; allow float micro-differences (< 1e-4).
        expect(a.reviewPriority).toBeCloseTo(b.reviewPriority, 4);
      }
    };

    // 4. Start an active mock session.
    const mock = startSession(courseId, "mock");
    const mockView = getSessionView(mock.id);
    expect(mockView.questions.length).toBeGreaterThanOrEqual(6);

    // Pick first question in mock to answer correctly.
    const q1 = mockView.questions[0];
    const p1 = persistedQuestions.find((p) => p.id === q1.id)!;
    const correctAns1 =
      p1.type === "mcq"
        ? { type: "option" as const, optionId: p1.correctOptionId }
        : p1.type === "truefalse"
          ? { type: "boolean" as const, value: p1.correctAnswer }
          : { type: "text" as const, text: p1.modelAnswer };

    // 5. Submit known-correct mock answer.
    const res1 = answerQuestion(mock.id, q1.id, correctAns1);
    expect(res1.grade).toBeNull();

    // 6. Fetch getCourseOverview() while mock is active.
    // 7. Verify all correctness-derived signals remain frozen at baseline.
    let activeOverview = getCourseOverview(courseId);
    assertConceptMasteryUnchanged(snapshotConcepts(activeOverview), baselineConceptSnapshots);
    expect(snapshotReadiness(activeOverview)).toEqual(baselineReadinessSnapshot);
    // Allowed active session metadata: answered count increments on session list.
    const activeMockListItem = activeOverview.sessions.find((s) => s.id === mock.id)!;
    expect(activeMockListItem.answered).toBe(1);
    expect(activeMockListItem.status).toBe("active");
    expect(activeMockListItem.score).toBeNull();

    // 8. Submit known-incorrect mock answer for question 2.
    const q2 = mockView.questions[1];
    const p2 = persistedQuestions.find((p) => p.id === q2.id)!;
    const wrongAns2 =
      p2.type === "mcq"
        ? { type: "option" as const, optionId: p2.options.find((o) => o.id !== p2.correctOptionId)!.id }
        : p2.type === "truefalse"
          ? { type: "boolean" as const, value: !p2.correctAnswer }
          : { type: "text" as const, text: "wrong answer text" };

    const res2 = answerQuestion(mock.id, q2.id, wrongAns2);
    expect(res2.grade).toBeNull();

    // 9. Verify signals still remain completely frozen at baseline.
    activeOverview = getCourseOverview(courseId);
    assertConceptMasteryUnchanged(snapshotConcepts(activeOverview), baselineConceptSnapshots);
    expect(snapshotReadiness(activeOverview)).toEqual(baselineReadinessSnapshot);

    // 10. Reopen database from disk to confirm attempts are persisted but still excluded.
    setDbPathForTests(dbFile);
    // Raw attempts exist in DB for resume / first-answer semantics.
    expect(db.getSessionAttempts(mock.id)).toHaveLength(2);
    expect(db.getEligibleCourseAttempts(courseId).length).toBe(
      db.getCourseAttempts(courseId).length - 2,
    );
    const reopenedOverview = getCourseOverview(courseId);
    assertConceptMasteryUnchanged(snapshotConcepts(reopenedOverview), baselineConceptSnapshots);
    expect(snapshotReadiness(reopenedOverview)).toEqual(baselineReadinessSnapshot);

    // Answer the rest of the mock questions so it can be completed cleanly.
    for (let i = 2; i < mockView.questions.length; i++) {
      const q = mockView.questions[i];
      const p = persistedQuestions.find((item) => item.id === q.id)!;
      const ans =
        p.type === "mcq"
          ? { type: "option" as const, optionId: p.correctOptionId }
          : p.type === "truefalse"
            ? { type: "boolean" as const, value: p.correctAnswer }
            : { type: "text" as const, text: p.modelAnswer };
      answerQuestion(mock.id, q.id, ans);
    }

    // 11. Finish the mock.
    const finishedMockView = finishSession(mock.id);
    expect(finishedMockView.session.status).toBe("completed");

    // 12. Fetch overview: now mock attempts contribute to mastery/readiness.
    const postMockOverview = getCourseOverview(courseId);
    const postMockConcepts = snapshotConcepts(postMockOverview);
    // At least one concept must have updated attempt count and mastery now that mock is completed.
    const totalBaselineAttempts = baselineConceptSnapshots.reduce((acc, c) => acc + c.attempts, 0);
    const totalPostMockAttempts = postMockConcepts.reduce((acc, c) => acc + c.attempts, 0);
    expect(totalPostMockAttempts).toBe(totalBaselineAttempts + mockView.questions.length);

    // 13. Finish / read again: verify idempotent behavior with no double counting.
    finishSession(mock.id);
    const repeatedOverview = getCourseOverview(courseId);
    assertConceptMasteryUnchanged(snapshotConcepts(repeatedOverview), postMockConcepts);
    expect(snapshotReadiness(repeatedOverview)).toEqual(snapshotReadiness(postMockOverview));
  });
});
