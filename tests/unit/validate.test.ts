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
      explanation:
        'The material states: "Photosynthesis is the process by which plants convert light energy into chemical energy."',
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

describe("answer provenance gates (F-02 class)", () => {
  const groundedQuote = "Photosynthesis is the process by which plants convert light energy into chemical energy.";
  const groundedExplanation = `The material states: "${groundedQuote}"`;

  it("rejects a fabricated suffix evidence quote even though a real prefix exists", () => {
    const q: Question = {
      ...baseMcq,
      evidence: [{ quote: "Photosynthesis is the process by which aliens invented chemistry." }],
    };
    const result = validateQuestionSet([q], SOURCE, concepts);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].errors.join(" ")).toMatch(/not found in source/);
  });

  it("rejects an MCQ whose correct option is not a source span, even with real evidence", () => {
    const fabricated: Question = {
      ...baseMcq,
      options: [
        { id: "o1", text: "process by which aliens invented chemistry" },
        { id: "o2", text: "green pigment that absorbs light in plant leaves" },
        { id: "o3", text: "process by which cells release energy stored in glucose" },
      ],
      correctOptionId: "o1",
    };
    const result = validateQuestionSet([fabricated], SOURCE, concepts);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].errors.join(" ")).toMatch(/correct answer text is not grounded/);
  });

  it("accepts an MCQ whose correct option is a contiguous source span", () => {
    const ok: Question = {
      ...baseMcq,
      options: [
        { id: "o1", text: "green pigment that absorbs light in plant leaves" },
        { id: "o2", text: "process by which cells release energy stored in glucose" },
        { id: "o3", text: "process by which plants convert light energy into chemical energy" },
      ],
      correctOptionId: "o3",
    };
    const result = validateQuestionSet([ok], SOURCE, concepts);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it("rejects a short question with fabricated model/accepted answers", () => {
    const fabricated: Question = {
      id: "q_short_bad",
      conceptId: "c1",
      conceptName: "Photosynthesis",
      type: "short",
      prompt: 'Fill in the blank according to the material:\n\n"______ is the process by which plants convert light energy into chemical energy."',
      modelAnswer: "aliens invented chemistry",
      acceptedAnswers: ["aliens invented chemistry"],
      explanation: groundedExplanation,
      evidence: [{ quote: groundedQuote }],
      difficulty: "medium",
      generator: "test",
    };
    const result = validateQuestionSet([fabricated], SOURCE, concepts);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].errors.join(" ")).toMatch(/model answer is not grounded/);
  });

  it("accepts a short question whose answers are source spans", () => {
    const ok: Question = {
      id: "q_short_ok",
      conceptId: "c2",
      conceptName: "Chlorophyll",
      type: "short",
      prompt: 'Fill in the blank according to the material:\n\n"______ is the green pigment that absorbs light in plant leaves."',
      modelAnswer: "Chlorophyll",
      acceptedAnswers: ["Chlorophyll"],
      explanation: 'The material states: "Chlorophyll is the green pigment that absorbs light in plant leaves."',
      evidence: [{ quote: "Chlorophyll is the green pigment that absorbs light in plant leaves." }],
      difficulty: "medium",
      generator: "test",
    };
    const result = validateQuestionSet([ok], SOURCE, concepts);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it("rejects an explanation question whose model answer is unsupported", () => {
    const fabricated: Question = {
      id: "q_expl_bad",
      conceptId: "c1",
      conceptName: "Photosynthesis",
      type: "explanation",
      prompt: "In your own words, explain what Photosynthesis is, according to the material.",
      modelAnswer: "Photosynthesis was discovered by aliens in 1842 on a distant planet.",
      keyTerms: ["process", "energy"],
      explanation: groundedExplanation,
      evidence: [{ quote: groundedQuote }],
      difficulty: "hard",
      generator: "test",
    };
    const result = validateQuestionSet([fabricated], SOURCE, concepts);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].errors.join(" ")).toMatch(/model answer is not grounded/);
  });

  it("rejects explanation key terms that cannot be derived from the source", () => {
    const unsupportedTerms: Question = {
      id: "q_expl_terms",
      conceptId: "c1",
      conceptName: "Photosynthesis",
      type: "explanation",
      prompt: "In your own words, explain what Photosynthesis is, according to the material.",
      modelAnswer: groundedQuote,
      keyTerms: ["quantum", "neutrino"],
      explanation: groundedExplanation,
      evidence: [{ quote: groundedQuote }],
      difficulty: "hard",
      generator: "test",
    };
    const result = validateQuestionSet([unsupportedTerms], SOURCE, concepts);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].errors.join(" ")).toMatch(/key term not grounded/);
  });

  it("accepts explanation key terms derived from source words (stemmed)", () => {
    const ok: Question = {
      id: "q_expl_ok",
      conceptId: "c1",
      conceptName: "Photosynthesis",
      type: "explanation",
      prompt: "In your own words, explain what Photosynthesis is, according to the material.",
      modelAnswer: groundedQuote,
      keyTerms: ["converting", "energy"],
      explanation: groundedExplanation,
      evidence: [{ quote: groundedQuote }],
      difficulty: "hard",
      generator: "test",
    };
    const result = validateQuestionSet([ok], SOURCE, concepts);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it("rejects learner-facing explanations that never quote the grounded evidence", () => {
    const unanchored: Question = {
      ...baseMcq,
      explanation: "Photosynthesis is very important for plants and also for life on earth in general.",
    };
    const result = validateQuestionSet([unanchored], SOURCE, concepts);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].errors.join(" ")).toMatch(/explanation does not quote grounded source evidence/);
  });

  it("rejects a false-keyed statement that is verbatim in the source (key contradicts material)", () => {
    const contradictory: Question = {
      id: "q_tf_false",
      conceptId: "c1",
      conceptName: "Photosynthesis",
      type: "truefalse",
      prompt: "According to the material, is this statement true or false?",
      statement: groundedQuote,
      correctAnswer: false,
      explanation: groundedExplanation,
      evidence: [{ quote: groundedQuote }],
      difficulty: "medium",
      generator: "test",
    };
    const result = validateQuestionSet([contradictory], SOURCE, concepts);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].errors.join(" ")).toMatch(/verbatim in the source/);
  });
});
