import type { Concept, Question } from "./types";
import { normAnswer, normText, wordSimilarity } from "./util";
import { quoteIsGrounded } from "./extract";

/**
 * Deterministic validation gates applied to every generated question before it is
 * accepted, regardless of provider. Invalid or low-quality questions are dropped,
 * never silently fixed.
 */

export interface ValidationIssue {
  questionId: string;
  errors: string[];
}

export interface ValidationResult {
  accepted: Question[];
  rejected: ValidationIssue[];
  duplicatesRemoved: number;
}

export function validateQuestion(q: Question, sourceText: string, concepts: Concept[]): string[] {
  const errors: string[] = [];

  if (!q.id || q.id.length < 3) errors.push("missing id");
  if (!q.prompt || normText(q.prompt).length < 8) errors.push("prompt too short");
  if (!q.explanation || normText(q.explanation).length < 10) errors.push("explanation missing or too short");
  if (!q.evidence || q.evidence.length === 0) errors.push("no source evidence");

  // Grounding: every evidence quote must actually exist in the source material.
  for (const ev of q.evidence) {
    if (!quoteIsGrounded(sourceText, ev.quote)) {
      errors.push(`evidence quote not found in source material: "${ev.quote.slice(0, 60)}…"`);
      break;
    }
  }

  const concept = concepts.find((c) => c.id === q.conceptId);
  if (!concept) errors.push(`unknown conceptId ${q.conceptId}`);

  switch (q.type) {
    case "mcq": {
      if (q.options.length < 3) errors.push("MCQ needs at least 3 options");
      if (new Set(q.options.map((o) => o.id)).size !== q.options.length) errors.push("duplicate option ids");
      const texts = q.options.map((o) => normText(o.text));
      if (new Set(texts).size !== q.options.length) errors.push("duplicate option texts");
      if (!q.options.some((o) => o.id === q.correctOptionId)) errors.push("correct answer not among options");
      // Ambiguity guard: the correct answer must not be a near-copy of a distractor.
      const correctText = q.options.find((o) => o.id === q.correctOptionId)?.text ?? "";
      for (const o of q.options) {
        if (o.id !== q.correctOptionId && wordSimilarity(correctText, o.text) > 0.8) {
          errors.push(`correct option too similar to distractor "${o.text.slice(0, 50)}…"`);
          break;
        }
      }
      break;
    }
    case "truefalse": {
      if (!q.statement || normText(q.statement).length < 12) errors.push("statement too short");
      if (typeof q.correctAnswer !== "boolean") errors.push("correctAnswer must be boolean");
      if (!quoteIsGrounded(sourceText, q.statement) && q.correctAnswer) {
        // A "true" statement must be verbatim from the source.
        errors.push("true statement is not grounded in the source");
      }
      break;
    }
    case "short": {
      if (!q.acceptedAnswers || q.acceptedAnswers.length === 0) errors.push("no accepted answers");
      if (q.acceptedAnswers.some((a) => normAnswer(a).length === 0)) errors.push("empty accepted answer");
      if (!q.modelAnswer || normAnswer(q.modelAnswer).length === 0) errors.push("model answer missing");
      break;
    }
    case "explanation": {
      if (!q.keyTerms || q.keyTerms.length < 2) errors.push("not enough key terms for grading");
      if (!q.modelAnswer || normText(q.modelAnswer).length < 10) errors.push("model answer missing");
      break;
    }
  }

  return errors;
}

export function validateQuestionSet(
  questions: Question[],
  sourceText: string,
  concepts: Concept[],
): ValidationResult {
  const accepted: Question[] = [];
  const rejected: ValidationIssue[] = [];
  const seenPrompts = new Set<string>();
  const seenIds = new Set<string>();
  let duplicatesRemoved = 0;

  for (const q of questions) {
    if (seenIds.has(q.id)) {
      rejected.push({ questionId: q.id, errors: ["duplicate question id"] });
      continue;
    }

    const errors = validateQuestion(q, sourceText, concepts);
    if (errors.length > 0) {
      rejected.push({ questionId: q.id, errors });
      continue;
    }

    // Duplicate detection: identical normalized prompts, or near-identical ones.
    const normPrompt = normText(q.prompt);
    const normStatement = q.type === "truefalse" ? normText(q.statement) : "";
    let isDup = false;
    for (const prev of accepted) {
      const prevNorm = normText(prev.prompt);
      const prevStatement = prev.type === "truefalse" ? normText(prev.statement) : "";
      const promptSim = wordSimilarity(normPrompt, prevNorm);
      const sameConcept = prev.conceptId === q.conceptId;
      const sameType = prev.type === q.type;
      const statementSim =
        normStatement && prevStatement ? wordSimilarity(normStatement, prevStatement) : 0;
      if (promptSim > 0.9 && sameType && sameConcept) {
        isDup = true;
        break;
      }
      if (statementSim > 0.9 && sameType && sameConcept) {
        isDup = true;
        break;
      }
      // Same concept + same type + same prompt shape is repetitive even if words differ a bit.
      if (sameConcept && sameType && promptSim > 0.82) {
        isDup = true;
        break;
      }
    }

    if (isDup) {
      duplicatesRemoved++;
      continue;
    }

    seenIds.add(q.id);
    seenPrompts.add(normPrompt);
    accepted.push(q);
  }

  return { accepted, rejected, duplicatesRemoved };
}
