import { describe, expect, it } from "vitest";
import { gradeAnswer } from "@/lib/grade";
import type { AnswerValue, ExplanationQuestion, McqQuestion, ShortQuestion, TrueFalseQuestion } from "@/lib/types";

const mcq: McqQuestion = {
  id: "q1",
  conceptId: "c1",
  conceptName: "Photosynthesis",
  type: "mcq",
  prompt: "What is photosynthesis?",
  options: [
    { id: "o1", text: "process of converting light energy into chemical energy" },
    { id: "o2", text: "process of releasing energy from glucose" },
    { id: "o3", text: "green pigment in leaves" },
  ],
  correctOptionId: "o1",
  explanation: "The material defines photosynthesis as converting light energy into chemical energy.",
  evidence: [{ quote: "Photosynthesis is the process of converting light energy into chemical energy." }],
  difficulty: "easy",
  generator: "test",
};

const tf: TrueFalseQuestion = {
  ...mcq,
  id: "q2",
  type: "truefalse",
  statement: "Chlorophyll is the green pigment that absorbs light.",
  correctAnswer: true,
};

const short: ShortQuestion = {
  ...mcq,
  id: "q3",
  type: "short",
  prompt: "Fill the blank",
  modelAnswer: "chlorophyll",
  acceptedAnswers: ["chlorophyll"],
};

const explanation: ExplanationQuestion = {
  ...mcq,
  id: "q4",
  type: "explanation",
  prompt: "Explain photosynthesis",
  modelAnswer: "Photosynthesis is the process of converting light energy into chemical energy in plants.",
  keyTerms: ["process", "converting", "light", "energy", "chemical"],
};

describe("grading engine consistency", () => {
  it("grades mcq exactly and deterministically", () => {
    const right = gradeAnswer(mcq, { type: "option", optionId: "o1" });
    const wrong = gradeAnswer(mcq, { type: "option", optionId: "o2" });
    expect(right.correct).toBe(true);
    expect(right.score).toBe(1);
    expect(wrong.correct).toBe(false);
    expect(wrong.score).toBe(0);
    // Same input always produces the same output.
    expect(gradeAnswer(mcq, { type: "option", optionId: "o1" })).toEqual(right);
  });

  it("explains wrong mcq answers instead of bare 'incorrect'", () => {
    const wrong = gradeAnswer(mcq, { type: "option", optionId: "o2" });
    expect(wrong.feedback).toContain(mcq.options[1].text);
    expect(wrong.feedback).toContain("light energy");
    expect(wrong.modelAnswer).toContain("converting light energy");
  });

  it("rejects answers to a different option id space", () => {
    const result = gradeAnswer(mcq, { type: "option", optionId: "nope" });
    expect(result.correct).toBe(false);
  });

  it("grades true/false", () => {
    expect(gradeAnswer(tf, { type: "boolean", value: true }).correct).toBe(true);
    const wrong = gradeAnswer(tf, { type: "boolean", value: false });
    expect(wrong.correct).toBe(false);
    expect(wrong.feedback).toContain("False");
  });

  it("grades short answers with normalization and typo tolerance", () => {
    expect(gradeAnswer(short, { type: "text", text: "  Chlorophyll.  " }).correct).toBe(true);
    expect(gradeAnswer(short, { type: "text", text: "chlorophyl" }).correct).toBe(true); // 1-char typo
    expect(gradeAnswer(short, { type: "text", text: "mitochondria" }).correct).toBe(false);
    const partial = gradeAnswer(short, { type: "text", text: "chlorophylx ish" });
    expect(partial.score).toBeLessThan(1);
  });

  it("grades explanations by key-term coverage with partial credit", () => {
    const good = gradeAnswer(explanation, {
      type: "text",
      text: "It is the process of converting light energy into chemical energy in plants.",
    });
    expect(good.correct).toBe(true);
    expect(good.score).toBeGreaterThanOrEqual(0.6);
    expect(good.keyTermsMissed).toHaveLength(0);

    const weak = gradeAnswer(explanation, { type: "text", text: "Something plants do with sunlight." });
    expect(weak.correct).toBe(false);
    expect(weak.keyTermsCovered!.length).toBeLessThan(3);
    expect(weak.feedback).toContain("key ideas");
  });

  it("never crashes on mismatched answer shapes", () => {
    expect(gradeAnswer(mcq, { type: "text", text: "x" }).correct).toBe(false);
    expect(gradeAnswer(short, { type: "option", optionId: "o1" }).correct).toBe(false);
  });

  it("always includes evidence in the result", () => {
    for (const q of [mcq, tf, short, explanation]) {
      const r = gradeAnswer(q, { type: "text", text: "any" });
      expect(r.evidence.length).toBeGreaterThan(0);
    }
  });
});

describe("answer values", () => {
  it("accepts all three answer shapes", () => {
    const values: AnswerValue[] = [
      { type: "option", optionId: "o1" },
      { type: "boolean", value: true },
      { type: "text", text: "hello" },
    ];
    expect(values).toHaveLength(3);
  });
});
