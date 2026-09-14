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
} from "@/lib/service";
import { SAMPLE_MATERIAL } from "@/sample/material";
import { ingestText } from "@/lib/ingest";
import { samplePractice } from "@/lib/sampler";
import type { Question, ShortQuestion } from "@/lib/types";
import { isShortAnswerEquivalentToConcept } from "@/lib/grade";

let tmpDir: string;
let dbFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "examforge-f01-"));
  dbFile = path.join(tmpDir, "test.sqlite");
  setDbPathForTests(dbFile);
});

afterEach(() => {
  setDbPathForTests(path.join(os.tmpdir(), `examforge-f01-reset-${Date.now()}.sqlite`));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("F-01 remediation: short-answer topic disclosure safety", () => {
  it("withholds answer-equivalent topic metadata until safe across session lifecycle", async () => {
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

    // Identify real deterministically generated short questions.
    const shortQuestions = persistedQuestions.filter(
      (q): q is ShortQuestion => q.type === "short",
    );
    expect(shortQuestions.length).toBeGreaterThan(0);

    const termRecallQuestion = shortQuestions.find((q) =>
      isShortAnswerEquivalentToConcept(q, q.conceptName),
    );
    expect(termRecallQuestion).toBeDefined();
    const oracleAnswer = termRecallQuestion!.modelAnswer;
    const oracleConceptName = termRecallQuestion!.conceptName;

    // 2. Start a diagnostic session that contains this question.
    const diagnostic = startSession(courseId, "diagnostic");
    expect(diagnostic.questionIds.length).toBeGreaterThan(0);

    const diagView = getSessionView(diagnostic.id);

    // Verify redundant conceptNames map is completely absent.
    expect((diagView as unknown as Record<string, unknown>).conceptNames).toBeUndefined();

    // Check each question in the active diagnostic before answering.
    for (const clientQ of diagView.questions) {
      const persisted = persistedQuestions.find((p) => p.id === clientQ.id)!;
      if (persisted.type === "short" && isShortAnswerEquivalentToConcept(persisted, persisted.conceptName)) {
        // Must NOT expose conceptName.
        expect(clientQ.conceptName).toBeUndefined();

        // Serialized representation must not disclose the answer term or concept name.
        const serialized = JSON.stringify(clientQ).toLowerCase();
        expect(serialized).not.toContain(persisted.conceptName.toLowerCase());
        for (const accepted of persisted.acceptedAnswers) {
          expect(serialized).not.toContain(accepted.toLowerCase());
        }
      } else {
        // Safe questions (MCQ, True/False, Explanation) retain safe topic context.
        expect(clientQ.conceptName).toBe(persisted.conceptName);
      }
    }

    // Active session reload: fetching view again preserves safety.
    const reloadedDiagView = getSessionView(diagnostic.id);
    for (const clientQ of reloadedDiagView.questions) {
      const persisted = persistedQuestions.find((p) => p.id === clientQ.id)!;
      if (persisted.type === "short" && isShortAnswerEquivalentToConcept(persisted, persisted.conceptName)) {
        expect(clientQ.conceptName).toBeUndefined();
      }
    }

    // 3. Answer a question in diagnostic: immediate feedback becomes available for answered question.
    const targetQ = diagView.questions.find((q) => {
      const p = persistedQuestions.find((pq) => pq.id === q.id)!;
      return p.type === "short" && isShortAnswerEquivalentToConcept(p, p.conceptName);
    });

    if (targetQ) {
      const ansRes = answerQuestion(diagnostic.id, targetQ.id, {
        type: "text",
        text: oracleAnswer,
      });
      expect(ansRes.grade).not.toBeNull();
      expect(ansRes.grade!.correct).toBe(true);

      const postAnswerView = getSessionView(diagnostic.id);
      const answeredClientQ = postAnswerView.questions.find((q) => q.id === targetQ.id)!;
      // Post-answer: conceptName is now safely revealed along with feedback.
      expect(answeredClientQ.conceptName).toBe(oracleConceptName);

      // Other unanswered short questions must still withhold conceptName.
      for (const clientQ of postAnswerView.questions) {
        if (clientQ.id !== targetQ.id) {
          const persisted = persistedQuestions.find((p) => p.id === clientQ.id)!;
          if (persisted.type === "short" && isShortAnswerEquivalentToConcept(persisted, persisted.conceptName)) {
            expect(clientQ.conceptName).toBeUndefined();
          }
        }
      }
    }

    // 4. Active mock exam remains strictly withholding.
    const mock = startSession(courseId, "mock");
    const mockView = getSessionView(mock.id);

    const mockShort = mockView.questions.find((q) => {
      const p = persistedQuestions.find((pq) => pq.id === q.id)!;
      return p.type === "short" && isShortAnswerEquivalentToConcept(p, p.conceptName);
    });

    if (mockShort) {
      const mockShortPersisted = persistedQuestions.find((p) => p.id === mockShort.id)! as ShortQuestion;
      const mockOracleAnswer = mockShortPersisted.modelAnswer;
      const mockOracleConceptName = mockShortPersisted.conceptName;

      expect(mockShort.conceptName).toBeUndefined();

      // Answer the mock short question.
      const mockAnsRes = answerQuestion(mock.id, mockShort.id, {
        type: "text",
        text: mockOracleAnswer,
      });
      // Grade is withheld while mock is active.
      expect(mockAnsRes.grade).toBeNull();

      // View while mock is still active: conceptName MUST NOT be disclosed even though answered.
      const activeMockView = getSessionView(mock.id);
      const activeAnsweredMockQ = activeMockView.questions.find((q) => q.id === mockShort.id)!;
      expect(activeAnsweredMockQ.conceptName).toBeUndefined();
      expect(activeMockView.revealed).toEqual({});

      // Complete the mock.
      const completedMockView = finishSession(mock.id);
      expect(completedMockView.session.status).toBe("completed");
      // Now topic context and full review are revealed.
      const finishedMockQ = completedMockView.questions.find((q) => q.id === mockShort.id)!;
      expect(finishedMockQ.conceptName).toBe(mockOracleConceptName);
      expect(completedMockView.review).not.toBeNull();
      const reviewItem = completedMockView.review!.find((r) => r.question.id === mockShort.id)!;
      expect(reviewItem.question.conceptName).toBe(mockOracleConceptName);
      expect(reviewItem.result).not.toBeNull();
      expect(reviewItem.result!.correct).toBe(true);
    }
  });

  it("excludes answer-equivalent term-recall questions from targeted practice", async () => {
    const ingested = ingestText(SAMPLE_MATERIAL);
    const { courseId } = await createCourse({
      text: ingested.text,
      sourceType: "bundled",
      ingestionWarnings: ingested.warnings,
    });

    const persistedQuestions: Question[] = db
      .getQuestions(courseId)
      .map((q) => JSON.parse(q.payloadJson));

    const concepts = db.getConcepts(courseId);
    expect(concepts.length).toBeGreaterThan(0);

    for (const concept of concepts) {
      const conceptQuestions = persistedQuestions.filter((q) => q.conceptId === concept.id);
      const sampled = samplePractice(conceptQuestions, concept.id, "practice-seed");

      // Sampled questions must never ask for the already-disclosed concept name.
      for (const q of sampled) {
        expect(isShortAnswerEquivalentToConcept(q, concept.name)).toBe(false);
      }

      // Other question types (e.g. MCQ, true/false, explanation) are sampled properly.
      expect(sampled.length).toBeGreaterThan(0);
      expect(sampled.every((q) => q.conceptId === concept.id)).toBe(true);
    }
  });
});
