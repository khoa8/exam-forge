import type { Concept, Question } from "./types.ts";
import { seededRandom } from "./util.ts";
import { isShortAnswerEquivalentToConcept } from "./grade.ts";

/**
 * Balanced question sampling for sessions.
 * - Diagnostic: one question per major concept (auto-gradable types), capped.
 * - Practice: all questions for one concept, mixed types.
 * - Mock exam: balanced across concepts, auto-gradable, capped.
 */

export function shuffleSeeded<T>(items: T[], seed: string): T[] {
  const rand = seededRandom(seed);
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const AUTO_GRADABLE = new Set(["mcq", "truefalse", "short"]);

/**
 * The questions eligible for the Diagnostic flow under the real sampling rules:
 * auto-gradable types only. Shared with the course-acceptance viability gate so
 * "what a Diagnostic can sample" has exactly one definition.
 */
export function diagnosticEligibleQuestions(questions: Question[]): Question[] {
  return questions.filter((q) => AUTO_GRADABLE.has(q.type));
}

export function sampleDiagnostic(
  questions: Question[],
  concepts: Concept[],
  seed: string,
  maxQuestions = 8,
): Question[] {
  const byConcept = new Map<string, Question[]>();
  for (const q of diagnosticEligibleQuestions(questions)) {
    const list = byConcept.get(q.conceptId) ?? [];
    list.push(q);
    byConcept.set(q.conceptId, list);
  }

  const ordered = [...concepts].sort((a, b) => b.importance - a.importance);
  const picked: Question[] = [];
  for (const concept of ordered) {
    if (picked.length >= maxQuestions) break;
    const pool = byConcept.get(concept.id);
    if (!pool || pool.length === 0) continue;
    // Rotate preferred type per concept so a diagnostic mixes question types.
    const preferred = ["mcq", "truefalse", "short"][picked.length % 3];
    const chosen =
      pool.find((q) => q.type === preferred) ??
      shuffleSeeded(pool, seed + concept.id)[0];
    if (chosen) picked.push(chosen);
  }
  return picked;
}

export function samplePractice(questions: Question[], conceptId: string, seed: string, maxQuestions = 6): Question[] {
  // Exclude term-recall questions where the answer reproduces the concept name
  // that was already selected and disclosed in the practice-selection UI.
  const pool = questions.filter(
    (q) => q.conceptId === conceptId && !isShortAnswerEquivalentToConcept(q, q.conceptName),
  );
  const ordered = shuffleSeeded(pool, seed + ":" + conceptId);
  // Prefer a mix: mcq/truefalse/short first, then explanation.
  const auto = ordered.filter((q) => AUTO_GRADABLE.has(q.type));
  const expl = ordered.filter((q) => q.type === "explanation");
  return [...auto.slice(0, maxQuestions - 1), ...expl.slice(0, 1)].slice(0, maxQuestions);
}

export function sampleMock(
  questions: Question[],
  concepts: Concept[],
  seed: string,
  maxQuestions = 8,
): Question[] {
  const byConcept = new Map<string, Question[]>();
  for (const q of questions) {
    const list = byConcept.get(q.conceptId) ?? [];
    list.push(q);
    byConcept.set(q.conceptId, list);
  }

  const ordered = [...concepts].sort((a, b) => b.importance - a.importance);
  const picked: Question[] = [];
  // Round-robin concepts, one question each per pass, cycling until full.
  for (let pass = 0; pass < 3 && picked.length < maxQuestions; pass++) {
    for (const concept of ordered) {
      if (picked.length >= maxQuestions) break;
      const pool = shuffleSeeded(byConcept.get(concept.id) ?? [], seed + concept.id + ":" + pass);
      const autoFirst = [...pool].sort((a, b) =>
        Number(AUTO_GRADABLE.has(b.type)) - Number(AUTO_GRADABLE.has(a.type)),
      );
      const candidate = autoFirst.find(
        (q) => !picked.some((p) => p.id === q.id) && (pass === 0 ? AUTO_GRADABLE.has(q.type) : true),
      );
      if (candidate) picked.push(candidate);
    }
  }
  return picked;
}
