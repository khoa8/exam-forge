import type { Concept, Question } from "./types";
import { contentWords, lightStem, normAnswer, normText, wordSimilarity } from "./util";
import { isSourceSpan, quoteIsGrounded } from "./extract";

/**
 * Deterministic validation gates applied to every generated question before it is
 * accepted, regardless of provider. Invalid or low-quality questions are dropped,
 * never silently fixed.
 *
 * Provenance contract (per question type): every field that determines grading or
 * learner-facing factual feedback must be deterministically grounded in the source
 * material — evidence quotes, MCQ correct options, true/false statements keyed
 * true, short answers, explanation model answers and key terms must all be spans
 * (or stemmed content words) that actually occur in the source. A valid evidence
 * quote never legitimizes unsupported answer-bearing content.
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

/** Every key term driving coverage grading must be derivable from the source text. */
function keyTermSupported(normSource: string, sourceStems: Set<string>, term: string): boolean {
  if (normSource.includes(normText(term))) return true;
  const words = contentWords(term);
  if (words.length === 0) return false;
  return words.every((w) => sourceStems.has(lightStem(w)));
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

  // Provenance: the learner-facing explanation must quote grounded source text.
  // Free-form prose that never quotes the material is not acceptable feedback.
  if (q.evidence && q.evidence.length > 0 && q.explanation) {
    const normExplanation = normText(q.explanation);
    const anchored = q.evidence.some((ev) => normExplanation.includes(normText(ev.quote)));
    if (!anchored) errors.push("explanation does not quote grounded source evidence");
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
      // Provenance: the correct answer must be a span that occurs in the source.
      if (correctText && !isSourceSpan(sourceText, correctText)) {
        errors.push("correct answer text is not grounded in the source material");
      }
      break;
    }
    case "truefalse": {
      if (!q.statement || normText(q.statement).length < 12) errors.push("statement too short");
      if (typeof q.correctAnswer !== "boolean") errors.push("correctAnswer must be boolean");
      const verbatim = quoteIsGrounded(sourceText, q.statement);
      if (q.correctAnswer === true && !verbatim) {
        // A "true" statement must be verbatim from the source.
        errors.push("true statement is not grounded in the source");
      }
      if (q.correctAnswer === false && verbatim) {
        // A statement that IS in the source cannot be keyed false: the answer key
        // would contradict the material.
        errors.push("false statement is verbatim in the source, contradicting the answer key");
      }
      break;
    }
    case "short": {
      if (!q.acceptedAnswers || q.acceptedAnswers.length === 0) errors.push("no accepted answers");
      if (q.acceptedAnswers.some((a) => normAnswer(a).length === 0)) errors.push("empty accepted answer");
      if (!q.modelAnswer || normAnswer(q.modelAnswer).length === 0) errors.push("model answer missing");
      // Provenance: graded answers must be terms/spans that occur in the source.
      if (q.modelAnswer && normAnswer(q.modelAnswer).length > 0 && !isSourceSpan(sourceText, q.modelAnswer)) {
        errors.push("model answer is not grounded in the source material");
      }
      if (q.acceptedAnswers) {
        for (const a of q.acceptedAnswers) {
          if (normAnswer(a).length > 0 && !isSourceSpan(sourceText, a)) {
            errors.push(`accepted answer not grounded in the source material: "${a.slice(0, 50)}"`);
            break;
          }
        }
      }
      break;
    }
    case "explanation": {
      if (!q.keyTerms || q.keyTerms.length < 2) errors.push("not enough key terms for grading");
      if (!q.modelAnswer || normText(q.modelAnswer).length < 10) errors.push("model answer missing");
      // Provenance: the model answer must come from the source, and every key term
      // that drives coverage grading must be derivable from the source text.
      if (q.modelAnswer && normText(q.modelAnswer).length >= 10 && !isSourceSpan(sourceText, q.modelAnswer)) {
        errors.push("model answer is not grounded in the source material");
      }
      if (q.keyTerms && q.keyTerms.length > 0) {
        const normSource = normText(sourceText);
        const stems = new Set(contentWords(sourceText).map(lightStem));
        for (const t of q.keyTerms) {
          if (!keyTermSupported(normSource, stems, t)) {
            errors.push(`key term not grounded in the source material: "${t.slice(0, 50)}"`);
            break;
          }
        }
      }
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
