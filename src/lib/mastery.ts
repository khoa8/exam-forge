import type { MasteryState } from "./types.ts";
import { clamp01 } from "./util.ts";

/**
 * Simple, understandable adaptive model.
 *
 * For each concept we track attempts and scores. Mastery is a smoothed,
 * recency-weighted estimate (recent answers count more). Confidence grows with
 * the amount of evidence. Review priority combines low mastery, concept
 * importance and staleness. No psychometric engine — everything is explainable.
 */

const RECENT_WINDOW = 5;

/**
 * Simple spaced-review recommendation (days until the next review).
 * Weak topics: today. Developing: ~2 days. Strong: ~1 week. Untested: n/a.
 * Deliberately simple — not an Anki-style scheduler.
 */
export function nextReviewInDays(status: MasteryState["status"]): number | null {
  switch (status) {
    case "weak":
      return 0;
    case "developing":
      return 2;
    case "strong":
      return 7;
    default:
      return null;
  }
}

export interface AttemptRecord {
  conceptId: string;
  score: number; // 0..1
  createdAt: string;
}

export function computeMastery(
  conceptId: string,
  attempts: AttemptRecord[],
  conceptImportance: number,
  now: string,
): MasteryState {
  const sorted = [...attempts].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const n = sorted.length;
  const correct = sorted.filter((a) => a.score >= 0.99).length;

  if (n === 0) {
    return {
      conceptId,
      attempts: 0,
      correct: 0,
      mastery: 0,
      confidence: 0,
      status: "untested",
      recentCorrect: 0,
      lastSeen: null,
      reviewPriority: conceptImportance * 0.5,
      nextReviewInDays: null,
    };
  }

  // Laplace-smoothed cumulative rate.
  const cumulative = (correct + 1) / (n + 2);

  // Recency-weighted mean over the last RECENT_WINDOW attempts.
  const recent = sorted.slice(-RECENT_WINDOW);
  let wsum = 0;
  let wscore = 0;
  recent.forEach((a, i) => {
    const w = i + 1; // most recent has the highest weight
    wsum += w;
    wscore += w * a.score;
  });
  const recency = wsum > 0 ? wscore / wsum : cumulative;

  const mastery =
    n >= 3 ? 0.45 * cumulative + 0.55 * recency : 0.7 * cumulative + 0.3 * recency;

  const confidence = clamp01(n / 6);
  const recentCorrect = recent.filter((a) => a.score >= 0.99).length;

  // Staleness: attempts older than ~3 days get a review nudge (max +0.2).
  const lastSeen = sorted[sorted.length - 1].createdAt;
  const ageDays = (Date.parse(now) - Date.parse(lastSeen)) / 86_400_000;
  const staleness = clamp01(ageDays / 3) * 0.2;

  let status: MasteryState["status"];
  if (mastery >= 0.8 && n >= 2) status = "strong";
  else if (mastery >= 0.5) status = "developing";
  else status = "weak";

  const reviewPriority = clamp01(
    (1 - mastery) * 0.65 + conceptImportance * 0.15 + staleness * 0.2,
  );

  return {
    conceptId,
    attempts: n,
    correct,
    mastery: clamp01(mastery),
    confidence,
    status,
    recentCorrect,
    lastSeen,
    reviewPriority,
    nextReviewInDays: nextReviewInDays(status),
  };
}
