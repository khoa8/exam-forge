import { describe, expect, it } from "vitest";
import { computeMastery } from "@/lib/mastery";
import { computeReadiness } from "@/lib/readiness";
import type { Concept } from "@/lib/types";

const NOW = "2026-09-03T06:00:00.000Z";
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();

const concept: Concept = {
  id: "c1",
  name: "Encoding",
  description: "Encoding is the process of transforming sensory input.",
  evidence: [{ quote: "Encoding is the process of transforming sensory input." }],
  importance: 0.8,
};

describe("mastery update rules", () => {
  it("returns untested state with no attempts", () => {
    const m = computeMastery("c1", [], concept.importance, NOW);
    expect(m.status).toBe("untested");
    expect(m.confidence).toBe(0);
    expect(m.mastery).toBe(0);
  });

  it("increases mastery with correct attempts", () => {
    const one = computeMastery("c1", [{ conceptId: "c1", score: 1, createdAt: daysAgo(1) }], concept.importance, NOW);
    const many = computeMastery(
      "c1",
      [1, 2, 3, 4].map((d) => ({ conceptId: "c1", score: 1, createdAt: daysAgo(d) })),
      concept.importance,
      NOW,
    );
    expect(one.mastery).toBeGreaterThan(0.4);
    expect(many.mastery).toBeGreaterThan(one.mastery);
    expect(many.status).toBe("strong");
  });

  it("keeps mastery low after wrong attempts", () => {
    const m = computeMastery(
      "c1",
      [1, 2].map((d) => ({ conceptId: "c1", score: 0, createdAt: daysAgo(d) })),
      concept.importance,
      NOW,
    );
    expect(m.status).toBe("weak");
    expect(m.mastery).toBeLessThan(0.4);
  });

  it("weights recent answers more than old ones", () => {
    // Two correct answers long ago, two wrong ones recently…
    const recentlyWrong = computeMastery(
      "c1",
      [
        { conceptId: "c1", score: 1, createdAt: daysAgo(10) },
        { conceptId: "c1", score: 1, createdAt: daysAgo(9) },
        { conceptId: "c1", score: 0, createdAt: daysAgo(1) },
        { conceptId: "c1", score: 0, createdAt: daysAgo(0.5) },
      ],
      concept.importance,
      NOW,
    );
    // …versus the same counts but with the wrong answers first.
    const recentlyRight = computeMastery(
      "c1",
      [
        { conceptId: "c1", score: 0, createdAt: daysAgo(10) },
        { conceptId: "c1", score: 0, createdAt: daysAgo(9) },
        { conceptId: "c1", score: 1, createdAt: daysAgo(1) },
        { conceptId: "c1", score: 1, createdAt: daysAgo(0.5) },
      ],
      concept.importance,
      NOW,
    );
    expect(recentlyRight.mastery).toBeGreaterThan(recentlyWrong.mastery);
  });

  it("grows confidence with evidence and caps review priority at 1", () => {
    const m = computeMastery(
      "c1",
      Array.from({ length: 10 }, (_, i) => ({ conceptId: "c1", score: 1, createdAt: daysAgo(i) })),
      concept.importance,
      NOW,
    );
    expect(m.confidence).toBe(1);
    expect(m.reviewPriority).toBeGreaterThanOrEqual(0);
    expect(m.reviewPriority).toBeLessThanOrEqual(1);
  });

  it("gives stale strong topics a review nudge", () => {
    const fresh = computeMastery("c1", [{ conceptId: "c1", score: 1, createdAt: daysAgo(0.1) }], concept.importance, NOW);
    const stale = computeMastery("c1", [{ conceptId: "c1", score: 1, createdAt: daysAgo(6) }], concept.importance, NOW);
    expect(stale.reviewPriority).toBeGreaterThan(fresh.reviewPriority);
  });

  it("recommends spaced review timing by status", () => {
    const weak = computeMastery("c1", [{ conceptId: "c1", score: 0, createdAt: daysAgo(1) }], 0.5, NOW);
    const strong = computeMastery(
      "c2",
      [1, 2, 3].map((d) => ({ conceptId: "c2", score: 1, createdAt: daysAgo(d) })),
      0.5,
      NOW,
    );
    expect(weak.nextReviewInDays).toBe(0);
    expect(strong.nextReviewInDays).toBe(7);
    expect(computeMastery("c3", [], 0.5, NOW).nextReviewInDays).toBeNull();
  });
});

describe("readiness aggregation", () => {
  const second: Concept = { ...concept, id: "c2", name: "Storage", importance: 0.5 };

  it("is honest about no data", () => {
    const r = computeReadiness([concept], new Map(), { hasDiagnostic: false, hasMock: false, hasPractice: false });
    expect(r.coverage).toBe(0);
    expect(r.readiness).toBe(0);
    expect(r.nextAction.kind).toBe("diagnostic");
    expect(r.disclaimer).toMatch(/not a prediction/i);
  });

  it("recommends practice when weak topics exist", () => {
    const mastery = computeMastery(
      "c1",
      [1, 2].map((d) => ({ conceptId: "c1", score: 0, createdAt: daysAgo(d) })),
      concept.importance,
      NOW,
    );
    const r = computeReadiness([concept], new Map([["c1", mastery]]), { hasDiagnostic: true, hasMock: false, hasPractice: false });
    expect(r.weak).toHaveLength(1);
    expect(r.nextAction.kind).toBe("practice");
    expect(r.readiness).toBeLessThan(50);
  });

  it("recommends a mock exam when nothing is weak", () => {
    const mastery = computeMastery(
      "c1",
      [1, 2, 3].map((d) => ({ conceptId: "c1", score: 1, createdAt: daysAgo(d) })),
      concept.importance,
      NOW,
    );
    const r = computeReadiness([concept], new Map([["c1", mastery]]), { hasDiagnostic: true, hasMock: false, hasPractice: true });
    expect(r.strong).toHaveLength(1);
    expect(r.nextAction.kind).toBe("mock");
    expect(r.readiness).toBeGreaterThan(60);
  });

  it("recommends review once diagnostic and mock are done with nothing weak left", () => {
    const mastery = computeMastery(
      "c1",
      [1, 2, 3].map((d) => ({ conceptId: "c1", score: 1, createdAt: daysAgo(d) })),
      concept.importance,
      NOW,
    );
    const r = computeReadiness([concept], new Map([["c1", mastery]]), {
      hasDiagnostic: true,
      hasMock: true,
      hasPractice: false,
    });
    // The `review` next action is reachable: it is what the dashboard offers after both the
    // diagnostic and a mock exam are complete and no topic is weak.
    expect(r.weak).toHaveLength(0);
    expect(r.nextAction.kind).toBe("review");
    expect(r.nextAction.href).toBe("readiness");
  });

  it("down-weights untested concepts via coverage", () => {
    const mastery = computeMastery(
      "c1",
      [1, 2, 3].map((d) => ({ conceptId: "c1", score: 1, createdAt: daysAgo(d) })),
      concept.importance,
      NOW,
    );
    const oneConcept = computeReadiness([concept], new Map([["c1", mastery]]), { hasDiagnostic: true, hasMock: true, hasPractice: true });
    const twoConcepts = computeReadiness([concept, second], new Map([["c1", mastery]]), { hasDiagnostic: true, hasMock: true, hasPractice: true });
    expect(twoConcepts.coverage).toBeLessThan(oneConcept.coverage);
    expect(twoConcepts.readiness).toBeLessThan(oneConcept.readiness);
  });

  it("classifies statuses into weak/strong/untested buckets", () => {
    const weakM = computeMastery("c1", [{ conceptId: "c1", score: 0, createdAt: daysAgo(1) }], 0.5, NOW);
    const strongM = computeMastery(
      "c2",
      [1, 2, 3].map((d) => ({ conceptId: "c2", score: 1, createdAt: daysAgo(d) })),
      0.5,
      NOW,
    );
    const r = computeReadiness(
      [concept, second, { ...concept, id: "c3", name: "Retrieval" }],
      new Map([
        ["c1", weakM],
        ["c2", strongM],
      ]),
      { hasDiagnostic: true, hasMock: true, hasPractice: true },
    );
    expect(r.weak.map((m) => m.conceptId)).toContain("c1");
    expect(r.strong.map((m) => m.conceptId)).toContain("c2");
    expect(r.untested.map((m) => m.conceptId)).toContain("c3");
  });
});
