import { describe, expect, it } from "vitest";
import { diagnosticEligibleQuestions, sampleDiagnostic, sampleMock, samplePractice, shuffleSeeded } from "@/lib/sampler";
import type { Concept, Question } from "@/lib/types";

function makeQuestions(): { questions: Question[]; concepts: Concept[] } {
  const concepts: Concept[] = ["A", "B", "C", "D"].map((name, i) => ({
    id: `c${i}`,
    name,
    description: `${name} is a test concept.`,
    evidence: [{ quote: `${name} is a test concept.` }],
    importance: 1 - i * 0.1,
  }));
  const questions: Question[] = concepts.flatMap((c) =>
    (["mcq", "truefalse", "short", "explanation"] as const).map((type, j) => ({
      id: `q_${c.id}_${type}`,
      conceptId: c.id,
      conceptName: c.name,
      type,
      prompt: `Question about ${c.name} (${type}) variant ${j}`,
      explanation: "Because the material says so, quoted.",
      evidence: [{ quote: `${c.name} is a test concept.` }],
      difficulty: "easy" as const,
      generator: "test",
      ...(type === "mcq"
        ? {
            options: [
              { id: "o1", text: "right" },
              { id: "o2", text: "wrong1" },
              { id: "o3", text: "wrong2" },
            ],
            correctOptionId: "o1",
          }
        : type === "truefalse"
          ? { statement: `${c.name} is a test concept.`, correctAnswer: true }
          : type === "short"
            ? { modelAnswer: c.name, acceptedAnswers: [c.name] }
            : { modelAnswer: `${c.name} is a test concept.`, keyTerms: ["test", "concept"] }),
    }) as Question),
  );
  return { questions, concepts };
}

describe("balanced sampling", () => {
  const { questions, concepts } = makeQuestions();

  it("diagnostic covers distinct concepts with auto-gradable types only", () => {
    const picked = sampleDiagnostic(questions, concepts, "seed1", 8);
    expect(picked.length).toBeLessThanOrEqual(8);
    const conceptIds = picked.map((q) => q.conceptId);
    expect(new Set(conceptIds).size).toBe(conceptIds.length);
    expect(picked.every((q) => q.type !== "explanation")).toBe(true);
  });

  it("practice draws only from the requested concept and includes an explanation type", () => {
    const picked = samplePractice(questions, "c1", "seed2");
    expect(picked.length).toBeGreaterThan(0);
    expect(picked.every((q) => q.conceptId === "c1")).toBe(true);
    expect(picked.some((q) => q.type === "explanation")).toBe(true);
  });

  it("mock exam is balanced across concepts and deterministic", () => {
    const a = sampleMock(questions, concepts, "seed3", 8);
    const b = sampleMock(questions, concepts, "seed3", 8);
    expect(a.map((q) => q.id)).toEqual(b.map((q) => q.id));
    const perConcept = new Set(a.map((q) => q.conceptId));
    expect(perConcept.size).toBeGreaterThanOrEqual(3);
    expect(a.length).toBe(8);
    expect(new Set(a.map((q) => q.id)).size).toBe(8);
  });

  it("shuffles deterministically for the same seed", () => {
    const items = [1, 2, 3, 4, 5];
    expect(shuffleSeeded(items, "s")).toEqual(shuffleSeeded(items, "s"));
    expect(shuffleSeeded(items, "s")).not.toEqual(items); // actually shuffled
  });
});

describe("diagnostic eligibility (shared with the course viability gate)", () => {
  it("keeps auto-gradable types and drops explanation questions", () => {
    const { questions } = makeQuestions();
    const eligible = diagnosticEligibleQuestions(questions);
    expect(eligible.every((q) => q.type !== "explanation")).toBe(true);
    expect(eligible.length).toBe(questions.filter((q) => q.type !== "explanation").length);
  });

  it("agrees with the real diagnostic sampling: no eligible questions means no diagnostic pick", () => {
    const { questions, concepts } = makeQuestions();
    const explanationOnly = questions.filter((q) => q.type === "explanation");
    expect(diagnosticEligibleQuestions(explanationOnly)).toHaveLength(0);
    expect(sampleDiagnostic(explanationOnly, concepts, "seedX")).toHaveLength(0);
  });
});
