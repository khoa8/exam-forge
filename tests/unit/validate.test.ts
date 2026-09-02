import { describe, expect, it } from "vitest";
import { validateQuestionSet } from "@/lib/validate";
import type { Concept, Question } from "@/lib/types";

const SOURCE = `# Test material
Photosynthesis is the process by which plants convert light energy into chemical energy. Chlorophyll is the green pigment that absorbs light in plant leaves. Cellular respiration is the process by which cells release energy stored in glucose.`;

const concepts: Concept[] = [
  {
    id: "c1",
    name: "Photosynthesis",
    description: "Photosynthesis is the process by which plants convert light energy into chemical energy.",
    evidence: [{ quote: "Photosynthesis is the process by which plants convert light energy into chemical energy." }],
    importance: 1,
  },
  {
    id: "c2",
    name: "Chlorophyll",
    description: "Chlorophyll is the green pigment that absorbs light in plant leaves.",
    evidence: [{ quote: "Chlorophyll is the green pigment that absorbs light in plant leaves." }],
    importance: 0.8,
  },
];

const baseMcq: Question = {
  id: "q_mcq_1",
  conceptId: "c1",
  conceptName: "Photosynthesis",
  type: "mcq",
  prompt: "According to the material, what is Photosynthesis?",
  options: [
    { id: "o1", text: "process by which plants convert light energy into chemical energy" },
    { id: "o2", text: "green pigment that absorbs light in plant leaves" },
    { id: "o3", text: "process by which cells release energy stored in glucose" },
  ],
  correctOptionId: "o1",
  explanation: "The material states: \"Photosynthesis is the process by which plants convert light energy into chemical energy.\"",
  evidence: [{ quote: "Photosynthesis is the process by which plants convert light energy into chemical energy." }],
  difficulty: "easy",
  generator: "test",
};

describe("deterministic question validation", () => {
  it("accepts a valid MCQ", () => {
    const result = validateQuestionSet([baseMcq], SOURCE, concepts);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it("rejects a correct answer that is not among the options", () => {
    const bad: Question = { ...baseMcq, correctOptionId: "o99" };
    const result = validateQuestionSet([bad], SOURCE, concepts);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].errors.join(" ")).toMatch(/correct answer not among options/);
  });

  it("rejects duplicate option ids and texts", () => {
    const badIds: Question = {
      ...baseMcq,
      options: [
        { id: "o1", text: "A" },
        { id: "o1", text: "B" },
        { id: "o3", text: "C" },
      ],
    };
    const badTexts: Question = {
      ...baseMcq,
      options: [
        { id: "o1", text: "Same" },
        { id: "o2", text: "Same" },
        { id: "o3", text: "C" },
      ],
    };
    const r1 = validateQuestionSet([badIds], SOURCE, concepts);
    const r2 = validateQuestionSet([badTexts], SOURCE, concepts);
    expect(r1.rejected[0].errors.join(" ")).toMatch(/duplicate option ids/);
    expect(r2.rejected[0].errors.join(" ")).toMatch(/duplicate option texts/);
  });

  it("rejects evidence that is not grounded in the source", () => {
    const fabricated: Question = {
      ...baseMcq,
      evidence: [{ quote: "Photosynthesis was invented in 1842 by an obscure botanist." }],
    };
    const result = validateQuestionSet([fabricated], SOURCE, concepts);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].errors.join(" ")).toMatch(/not found in source/);
  });

  it("rejects non-empty explanation requirement", () => {
    const noExplanation: Question = { ...baseMcq, explanation: "short" };
    const result = validateQuestionSet([noExplanation], SOURCE, concepts);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].errors.join(" ")).toMatch(/explanation/);
  });

  it("rejects an MCQ whose correct option is nearly identical to a distractor (ambiguity)", () => {
    const ambiguous: Question = {
      ...baseMcq,
      options: [
        { id: "o1", text: "process by which plants convert light energy into chemical energy" },
        { id: "o2", text: "process by which plants convert light energy into chemical fuels" },
        { id: "o3", text: "green pigment that absorbs light in plant leaves" },
      ],
    };
    const result = validateQuestionSet([ambiguous], SOURCE, concepts);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].errors.join(" ")).toMatch(/too similar/);
  });

  it("removes near-duplicate questions for the same concept and type", () => {
    const dup: Question = { ...baseMcq, id: "q_mcq_2", prompt: "According to the material, what is Photosynthesis?" };
    const dup2: Question = { ...baseMcq, id: "q_mcq_3", prompt: "According to the material — what is PHOTOSYNTHESIS?!" };
    const result = validateQuestionSet([baseMcq, dup, dup2], SOURCE, concepts);
    expect(result.accepted).toHaveLength(1);
    expect(result.duplicatesRemoved).toBe(2);
  });

  it("rejects questions with unknown concept ids", () => {
    const orphan: Question = { ...baseMcq, conceptId: "c999" };
    const result = validateQuestionSet([orphan], SOURCE, concepts);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].errors.join(" ")).toMatch(/unknown conceptId/);
  });

  it("enforces unique question ids", () => {
    // Same id but a valid question shape: the second must be rejected as a duplicate id.
    const sameId: Question = { ...baseMcq };
    const result = validateQuestionSet([baseMcq, sameId], SOURCE, concepts);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected[0].errors.join(" ")).toMatch(/duplicate question id/);
  });

  it("requires true statements to be grounded in the source", () => {
    const tf: Question = {
      id: "q_tf_1",
      conceptId: "c1",
      conceptName: "Photosynthesis",
      type: "truefalse",
      prompt: "According to the material, is this statement true or false?",
      statement: "Photosynthesis is the process by which plants convert light energy into chemical energy.",
      correctAnswer: true,
      explanation: "The material states this directly.",
      evidence: [{ quote: "Photosynthesis is the process by which plants convert light energy into chemical energy." }],
      difficulty: "easy",
      generator: "test",
    };
    const fabricated = { ...tf, statement: "Photosynthesis converts light energy into kinetic energy." };
    const okResult = validateQuestionSet([tf], SOURCE, concepts);
    const badResult = validateQuestionSet([fabricated], SOURCE, concepts);
    expect(okResult.accepted).toHaveLength(1);
    expect(badResult.accepted).toHaveLength(0);
    expect(badResult.rejected[0].errors.join(" ")).toMatch(/not grounded/);
  });
});
