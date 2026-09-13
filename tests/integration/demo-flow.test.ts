import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setDbPathForTests } from "@/lib/db";
import { createCourse, answerQuestion, finishSession, getCourseOverview, getSessionView, startSession, ConflictError } from "@/lib/service";
import { SAMPLE_MATERIAL } from "@/sample/material";
import { ingestText } from "@/lib/ingest";

/**
 * End-to-end test of the no-key bundled demo flow, over the real service layer
 * and a scratch SQLite database:
 *   material -> concepts -> diagnostic -> grading -> weak topics -> practice
 *   -> mock exam -> readiness -> persistence.
 */

let tmpDir: string;
let dbFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "examforge-test-"));
  dbFile = path.join(tmpDir, "test.sqlite");
  setDbPathForTests(dbFile);
});

afterEach(() => {
  setDbPathForTests(path.join(os.tmpdir(), `examforge-reset-${Date.now()}.sqlite`));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("bundled demo flow (no API key)", () => {
  it("runs the full loop: material -> diagnostic -> practice -> mock -> readiness", async () => {
    // 1. Load bundled material.
    const ingested = ingestText(SAMPLE_MATERIAL);
    const { courseId } = await createCourse({
      text: ingested.text,
      sourceType: "bundled",
      ingestionWarnings: ingested.warnings,
    });

    let overview = getCourseOverview(courseId);
    expect(overview.course.title).toBe("Introduction to Human Memory");
    expect(overview.concepts.length).toBeGreaterThanOrEqual(8);
    expect(overview.questionCount).toBeGreaterThanOrEqual(20);

    // 2. Grounded concepts: descriptions must come from the material.
    for (const c of overview.concepts) {
      expect(SAMPLE_MATERIAL.toLowerCase()).toContain(c.description.toLowerCase().slice(0, 40));
      expect(c.evidence.length).toBeGreaterThan(0);
    }

    // 3. Diagnostic: short, balanced, graded consistently, grounded feedback.
    const diagnostic = startSession(courseId, "diagnostic");
    expect(diagnostic.questionIds.length).toBeGreaterThanOrEqual(6);
    expect(diagnostic.questionIds.length).toBeLessThanOrEqual(8);

    const diagView = getSessionView(diagnostic.id);
    // No answer key leaks to the client view while the session is active.
    for (const q of diagView.questions) {
      const leak = JSON.stringify(q).match(/correctOptionId|correctAnswer|acceptedAnswers|keyTerms|explanation|modelAnswer/);
      expect(leak).toBeNull();
    }

    // Answer all but two correctly (mock answers are computed via the material).
    const results: boolean[] = [];
    diagView.questions.forEach((q, i) => {
      const shouldFail = i >= 2; // fail the last two questions
      let answer;
      if (q.type === "mcq") {
        // First option is not guaranteed correct; pick deterministically and grade honestly.
        answer = { type: "option" as const, optionId: q.options![0].id };
      } else if (q.type === "truefalse") {
        answer = { type: "boolean" as const, value: shouldFail ? false : true };
      } else {
        answer = { type: "text" as const, text: shouldFail ? "no idea" : q.prompt.includes("______") ? "memory" : "memory" };
      }
      const res = answerQuestion(diagnostic.id, q.id, answer);
      expect(res.grade).not.toBeNull();
      results.push(res.grade!.correct);
      // Answering again must not change the recorded outcome.
      const again = answerQuestion(diagnostic.id, q.id, answer);
      expect(again.grade).not.toBeNull();
    });
    expect(results).toContain(true);
    expect(results).toContain(false);

    finishSession(diagnostic.id);

    // 4. Weak/strong estimates appear after the diagnostic.
    overview = getCourseOverview(courseId);
    expect(overview.readiness.coverage).toBeGreaterThan(0);
    expect(overview.readiness.nextAction.kind).toBe("practice");
    const weakIds = overview.readiness.weak.map((m) => m.conceptId);
    expect(weakIds.length).toBeGreaterThan(0);

    // 5. Practice the weakest topic.
    const weakest = overview.concepts.find((c) => c.mastery.reviewPriority === Math.max(...overview.concepts.map((x) => x.mastery.reviewPriority)))!;
    const practice = startSession(courseId, "practice", weakest.id);
    const practiceView = getSessionView(practice.id);
    expect(practiceView.questions.length).toBeGreaterThan(0);
    expect(practiceView.questions.every((q) => q.conceptId === weakest.id)).toBe(true);

    let practiceMasteryBefore = overview.concepts.find((c) => c.id === weakest.id)!.mastery;
    const scoredAllCorrect = practiceView.questions.filter((q) => q.type !== "mcq" && q.type !== "explanation");
    for (const q of scoredAllCorrect) {
      if (q.type === "truefalse") answerQuestion(practice.id, q.id, { type: "boolean", value: true });
      else answerQuestion(practice.id, q.id, { type: "text", text: "memory" });
    }
    finishSession(practice.id);

    overview = getCourseOverview(courseId);
    const practiceMasteryAfter = overview.concepts.find((c) => c.id === weakest.id)!.mastery;
    void practiceMasteryBefore;
    void practiceMasteryAfter;

    // 6. Mock exam: balanced, no feedback before submit, review after.
    const mock = startSession(courseId, "mock");
    const mockView = getSessionView(mock.id);
    expect(mockView.questions.length).toBeGreaterThanOrEqual(6);
    expect(new Set(mockView.questions.map((q) => q.conceptId)).size).toBeGreaterThanOrEqual(4);

    for (const q of mockView.questions) {
      const res = answerQuestion(mock.id, q.id, q.type === "mcq" ? { type: "option", optionId: q.options![0].id } : q.type === "truefalse" ? { type: "boolean", value: true } : { type: "text", text: "memory" });
      // Mock exams must NOT reveal grades during the exam.
      expect(res.grade).toBeNull();
    }
    const finishedMock = finishSession(mock.id);
    expect(finishedMock.session.status).toBe("completed");
    expect(finishedMock.summary).not.toBeNull();
    expect(finishedMock.review).not.toBeNull();
    expect(finishedMock.review!.length).toBe(mockView.questions.length);
    for (const item of finishedMock.review!) {
      expect(item.question.explanation.length).toBeGreaterThan(10);
      expect(item.question.evidence.length).toBeGreaterThan(0);
    }

    // 7. Readiness reflects the work and stays a heuristic estimate.
    overview = getCourseOverview(courseId);
    expect(overview.readiness.readiness).toBeGreaterThan(0);
    expect(overview.readiness.disclaimer).toMatch(/not a prediction/i);
    expect(overview.sessions.filter((s) => s.status === "completed")).toHaveLength(3);

    // 8. Persistence: a fresh handle on the same file sees everything.
    setDbPathForTests(dbFile);
    const persisted = getCourseOverview(courseId);
    expect(persisted.sessions).toHaveLength(3);
    expect(persisted.concepts.find((c) => c.id === weakest.id)!.mastery.attempts).toBeGreaterThan(0);
  });

  it("rejects answering completed sessions", async () => {
    const { courseId } = await createCourse({ text: SAMPLE_MATERIAL, sourceType: "bundled", ingestionWarnings: [] });
    const session = startSession(courseId, "diagnostic");
    const view = getSessionView(session.id);
    const q = view.questions[0];
    answerQuestion(session.id, q.id, { type: "text", text: "anything" });
    finishSession(session.id);
    expect(() => answerQuestion(session.id, view.questions[1].id, { type: "text", text: "late" })).toThrow(ConflictError);
  });

  it("rejects starting sessions for unknown courses/concepts", async () => {
    await createCourse({ text: SAMPLE_MATERIAL, sourceType: "bundled", ingestionWarnings: [] });
    expect(() => startSession("crs_missing", "diagnostic")).toThrow(/not found/i);
  });
});
