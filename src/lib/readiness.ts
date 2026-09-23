import type { Concept, MasteryState, NextAction, ReadinessReport } from "./types.ts";
import { clamp01 } from "./util.ts";

/**
 * Readiness aggregation.
 *
 * The readiness score is an INTERNAL HEURISTIC ESTIMATE over the loaded material's
 * concepts only. It is explicitly NOT a prediction of a real exam score.
 */

export const READINESS_DISCLAIMER =
  "Internal readiness estimate based on your answers in this app. It is a heuristic, not a prediction of your real exam score.";

export interface SessionFlag {
  hasDiagnostic: boolean;
  hasMock: boolean;
  hasPractice: boolean;
}

export function computeReadiness(
  concepts: Concept[],
  masteryByConcept: Map<string, MasteryState>,
  flags: SessionFlag,
): ReadinessReport {
  const states = concepts.map((c) => masteryByConcept.get(c.id) ?? {
    conceptId: c.id,
    attempts: 0,
    correct: 0,
    mastery: 0,
    confidence: 0,
    status: "untested" as const,
    recentCorrect: 0,
    lastSeen: null,
    reviewPriority: c.importance * 0.5,
    nextReviewInDays: null,
  });

  const totalImportance = concepts.reduce((s, c) => s + Math.max(0.1, c.importance), 0) || 1;

  // Coverage: share of (importance-weighted) concepts that have been tested.
  let testedImportance = 0;
  for (const c of concepts) {
    const m = masteryByConcept.get(c.id);
    if (m && m.attempts > 0) testedImportance += Math.max(0.1, c.importance);
  }
  const coverage = clamp01(testedImportance / totalImportance);

  // Performance: importance-weighted mastery over tested concepts.
  let perfSum = 0;
  let perfWeight = 0;
  for (const c of concepts) {
    const m = masteryByConcept.get(c.id);
    if (m && m.attempts > 0) {
      const w = Math.max(0.1, c.importance) * (0.4 + 0.6 * m.confidence);
      perfSum += m.mastery * w;
      perfWeight += w;
    }
  }
  const performance = perfWeight > 0 ? perfSum / perfWeight : 0;

  // Unready weight: weak/untested concepts drag readiness down.
  const readinessRaw = performance * (0.35 + 0.65 * coverage);
  const readiness = Math.round(clamp01(readinessRaw) * 100);

  const overallConfidence =
    states.length > 0
      ? states.reduce((s, m) => s + m.confidence, 0) / states.length
      : 0;

  const weak = states.filter((m) => m.status === "weak").sort((a, b) => b.reviewPriority - a.reviewPriority);
  const strong = states.filter((m) => m.status === "strong");
  const untested = states.filter((m) => m.status === "untested");

  const nextAction = computeNextAction(states, weak, flags);

  return {
    readiness,
    overallConfidence,
    coverage,
    concepts: states,
    weak,
    strong,
    untested,
    nextAction,
    disclaimer: READINESS_DISCLAIMER,
  };
}

function computeNextAction(
  states: MasteryState[],
  weak: MasteryState[],
  flags: SessionFlag,
): NextAction {
  if (!flags.hasDiagnostic) {
    return {
      kind: "diagnostic",
      message: "Take the diagnostic quiz so ExamForge can estimate your strong and weak topics.",
      href: "diagnostic",
    };
  }
  if (weak.length > 0) {
    return {
      kind: "practice",
      conceptId: weak[0].conceptId,
      message: "Practice your weakest topic next, then re-check readiness.",
      href: "practice",
    };
  }
  if (states.length > 0 && !flags.hasMock) {
    return {
      kind: "mock",
      message: "No weak topics left — take a short mock exam to consolidate.",
      href: "mock",
    };
  }
  return {
    kind: "review",
    message: "Review the concept list below and retake practice or a mock exam when ready.",
    href: "readiness",
  };
}
