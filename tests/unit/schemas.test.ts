import { describe, expect, it } from "vitest";
import { questionSchema, conceptSchema, answerValueSchema } from "@/lib/schemas";

describe("zod schema validation of generated content", () => {
  const validConcept = {
    id: "c1_photosynthesis",
    name: "Photosynthesis",
    description: "The process by which plants convert light energy into chemical energy.",
    evidence: [{ quote: "Photosynthesis is the process by which plants convert light energy." }],
    importance: 0.9,
  };

  it("accepts a valid concept", () => {
    expect(conceptSchema.safeParse(validConcept).success).toBe(true);
  });

  it("rejects concepts with missing evidence or bad importance", () => {
    expect(conceptSchema.safeParse({ ...validConcept, evidence: [] }).success).toBe(false);
    expect(conceptSchema.safeParse({ ...validConcept, importance: 2 }).success).toBe(false);
    expect(conceptSchema.safeParse({ ...validConcept, name: "" }).success).toBe(false);
  });

  it("accepts a valid mcq and rejects a broken one", () => {
    const valid = {
      id: "q_1",
      conceptId: "c1",
      conceptName: "Photosynthesis",
      type: "mcq",
      prompt: "What is photosynthesis according to the material?",
      options: [
        { id: "o1", text: "Light into chemical energy" },
        { id: "o2", text: "Sugar into oxygen" },
        { id: "o3", text: "Water into minerals" },
      ],
      correctOptionId: "o1",
      explanation: "The material states that photosynthesis converts light energy into chemical energy.",
      evidence: [{ quote: "Photosynthesis converts light energy into chemical energy." }],
      difficulty: "easy",
      generator: "test",
    };
    expect(questionSchema.safeParse(valid).success).toBe(true);

    expect(questionSchema.safeParse({ ...valid, options: valid.options.slice(0, 1) }).success).toBe(false);
    expect(questionSchema.safeParse({ ...valid, evidence: [] }).success).toBe(false);
    expect(questionSchema.safeParse({ ...valid, type: "nonsense" }).success).toBe(false);
  });

  it("validates the other question types", () => {
    const base = {
      id: "q_2",
      conceptId: "c1",
      conceptName: "Photosynthesis",
      prompt: "True or false?",
      explanation: "Grounded explanation of the statement from the material.",
      evidence: [{ quote: "Photosynthesis converts light energy into chemical energy." }],
      difficulty: "medium",
      generator: "test",
    };
    expect(questionSchema.safeParse({ ...base, type: "truefalse", statement: "Some statement.", correctAnswer: false }).success).toBe(true);
    expect(questionSchema.safeParse({ ...base, type: "short", modelAnswer: "photosynthesis", acceptedAnswers: ["photosynthesis"] }).success).toBe(true);
    expect(questionSchema.safeParse({ ...base, type: "short", modelAnswer: "photosynthesis", acceptedAnswers: [] }).success).toBe(false);
    expect(
      questionSchema.safeParse({ ...base, type: "explanation", modelAnswer: "A longer model answer from the source.", keyTerms: ["light", "energy"] })
        .success,
    ).toBe(true);
    expect(
      questionSchema.safeParse({ ...base, type: "explanation", modelAnswer: "A longer model answer from the source.", keyTerms: ["light"] }).success,
    ).toBe(false);
  });

  it("validates answer values from the client", () => {
    expect(answerValueSchema.safeParse({ type: "option", optionId: "o1" }).success).toBe(true);
    expect(answerValueSchema.safeParse({ type: "boolean", value: true }).success).toBe(true);
    expect(answerValueSchema.safeParse({ type: "text", text: "hello" }).success).toBe(true);
    expect(answerValueSchema.safeParse({ type: "option" }).success).toBe(false);
    expect(answerValueSchema.safeParse({ type: "cheat", value: 1 }).success).toBe(false);
  });
});
