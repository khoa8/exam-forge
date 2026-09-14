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
import type { Concept, Question, ShortQuestion } from "@/lib/types";
import { isShortAnswerEquivalentToConcept } from "@/lib/grade";
import { extractConcepts } from "@/lib/extract";
import { generateQuestions } from "@/lib/generate";
import { validateQuestionSet } from "@/lib/validate";
import { promptContainsAcceptedShortAnswer } from "@/lib/util";

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
      // F-01A: conceptId is never exposed on client-facing questions
      expect((clientQ as Record<string, unknown>).conceptId).toBeUndefined();

      const persisted = persistedQuestions.find((p) => p.id === clientQ.id)!;
      const serialized = JSON.stringify(clientQ).toLowerCase();
      expect(serialized).not.toContain('"conceptid"');

      if (persisted.type === "short" && isShortAnswerEquivalentToConcept(persisted, persisted.conceptName)) {
        // Must NOT expose conceptName.
        expect(clientQ.conceptName).toBeUndefined();
        expect(serialized).not.toContain('"conceptname"');

        // Serialized representation must not disclose the answer term or concept name.
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
      expect((mockShort as Record<string, unknown>).conceptId).toBeUndefined();

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
      expect((activeAnsweredMockQ as Record<string, unknown>).conceptId).toBeUndefined();
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

  it("drops short questions when the definition subject is repeated in the definition sentence without answer leakage", () => {
    // Synthetic source with a definition sentence where the concept name appears repeatedly.
    // E.g.: "Photosynthesis is the process by which photosynthesis converts light energy into chemical energy."
    const repeatedSource = `# Plant Biology Fundamentals

## Photosynthesis
Photosynthesis is the process by which photosynthesis converts light energy into chemical energy in green plants.

## Cellular Respiration
Cellular respiration is the biochemical process in which cells break down glucose to generate ATP.

## Chlorophyll
Chlorophyll is the green pigment that absorbs light energy within the chloroplasts of leaves.

## Stomata
Stomata are the microscopic pores on leaves that regulate gas exchange and transpiration.
`;

    const { concepts } = extractConcepts(repeatedSource);
    expect(concepts.length).toBeGreaterThanOrEqual(4);

    const photosynthesisConcept = concepts.find((c) => c.name.toLowerCase() === "photosynthesis");
    expect(photosynthesisConcept).toBeDefined();

    const output = generateQuestions(repeatedSource, concepts, "test-seed-repeated");

    // Short question for Photosynthesis must NOT be generated because blanking only the first occurrence
    // leaves the repeated occurrence in the prompt, which would leak the answer.
    const photosynthesisShort = output.questions.find(
      (q) => q.type === "short" && q.conceptId === photosynthesisConcept!.id,
    );
    expect(photosynthesisShort).toBeUndefined();

    // Verify honest accounting: the dropped reason was recorded
    const leakDrop = output.dropped.find((d) =>
      d.reason.includes("could not safely blank subject without answer leakage"),
    );
    expect(leakDrop).toBeDefined();
    expect(leakDrop!.count).toBeGreaterThanOrEqual(1);

    // Verify that other clean concepts (Cellular Respiration, Chlorophyll, etc.) did generate valid short questions
    const cleanShorts = output.questions.filter((q) => q.type === "short");
    expect(cleanShorts.length).toBeGreaterThanOrEqual(1);
    for (const s of cleanShorts) {
      expect(s.type).toBe("short");
      const sq = s as ShortQuestion;
      expect(promptContainsAcceptedShortAnswer(sq.prompt, sq.acceptedAnswers, sq.modelAnswer)).toBe(false);
    }

    // Question set passes canonical validation with no errors
    const validated = validateQuestionSet(output.questions, repeatedSource, concepts);
    expect(validated.accepted.length).toBe(output.questions.length);
    expect(validated.rejected).toHaveLength(0);
  });

  it("never falls back to an unblanked source sentence when subject replacement fails on punctuation-heavy terms", () => {
    // Synthetic source with a subject that cannot be cleanly word-boundary swapped by swapSubject
    // e.g. "C++ is a high-level programming language..." where "C++" contains trailing non-word symbols "+"
    // causing \\bC\\+\\+\\b word-boundary regex to fail.
    const punctSource = `# Computer Science Languages

## C++
C++ is a high-level compiled programming language created by Bjarne Stroustrup as an extension of the C language.

## Python
Python is a dynamically-typed interpreted programming language known for readable syntax.

## JavaScript
JavaScript is a prototype-based programming language primarily used for dynamic web development.

## Rust
Rust is a statically-typed compiled programming language designed for memory safety without garbage collection.
`;

    const { concepts } = extractConcepts(punctSource);
    expect(concepts.length).toBeGreaterThanOrEqual(4);

    const cppConcept = concepts.find((c) => c.name.includes("C++"));
    expect(cppConcept).toBeDefined();

    const output = generateQuestions(punctSource, concepts, "test-seed-punct");

    // UNACCEPTABLE OUTCOME: prompt contains unmodified source sentence with "C++" visible in the prompt.
    // ACCEPTABLE OUTCOME: question is dropped, or safely blanked without leaking "C++".
    const cppShort = output.questions.find(
      (q) => q.type === "short" && q.conceptId === cppConcept!.id,
    );

    if (cppShort) {
      const sq = cppShort as ShortQuestion;
      expect(sq.prompt).toContain("______");
      expect(sq.prompt.toLowerCase()).not.toContain("c++ is a high-level");
      expect(promptContainsAcceptedShortAnswer(sq.prompt, sq.acceptedAnswers, sq.modelAnswer)).toBe(false);
    } else {
      // Safely dropped
      const dropped = output.dropped.find((d) =>
        d.reason.includes("could not safely blank subject without answer leakage"),
      );
      expect(dropped).toBeDefined();
    }

    // All generated questions pass validation
    const validated = validateQuestionSet(output.questions, punctSource, concepts);
    expect(validated.accepted.length).toBe(output.questions.length);
    expect(validated.rejected).toHaveLength(0);

    for (const q of validated.accepted) {
      if (q.type === "short") {
        expect(promptContainsAcceptedShortAnswer(q.prompt, q.acceptedAnswers, q.modelAnswer)).toBe(false);
      }
    }
  });
});
