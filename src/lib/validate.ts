import type { Concept, Question } from "./types";
import { contentWords, lightStem, normAnswer, normText, wordSimilarity } from "./util";
import { isSourceSpan, quoteIsGrounded } from "./extract";
import { looksLikeInstruction } from "./provider/sanitize";
import { swapSubject } from "./generate";
import { validateQuestion as parseQuestionSchema } from "./schemas";

/**
 * Deterministic validation gates applied to every generated question before it is
 * accepted, regardless of provider. Invalid or low-quality questions are dropped,
 * never silently fixed.
 *
 * Trust-boundary contract (enforced here, on the real acceptance path):
 *  1. Canonical runtime schemas — every candidate is parsed with the zod schemas
 *     before any semantic gate; TypeScript types are not validation.
 *  2. Evidence grounding — every evidence quote is an exact, token-bounded,
 *     normalized span of the source, and never instruction-like content.
 *  3. Evidence/concept-scoped answer provenance — answer-bearing fields must be
 *     supported by the CURRENT question's evidence and its concept's validated
 *     evidence/description, not merely by occurring somewhere in the source.
 *  4. True/false keys — true statements must be verbatim in the scoped evidence;
 *     false statements require a deterministic, re-derivable proof of the false
 *     transformation (falseProof); absence of verbatim text never proves false.
 *  5. Learner-facing explanations must quote grounded source evidence.
 *
 * Unsupported candidates are dropped, never repaired; too few survivors trigger
 * the documented provider fallback/failure contract.
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

/**
 * Provenance scope for one question's answer-bearing fields: the validated
 * evidence of the question plus the validated evidence/description of its
 * concept. Source-global containment outside this scope is not provenance.
 */
function provenanceScope(q: Question, concept: Concept | undefined): string {
  const parts: string[] = [];
  for (const ev of q.evidence) parts.push(ev.quote);
  if (concept) {
    parts.push(concept.description);
    for (const ev of concept.evidence) parts.push(ev.quote);
  }
  return parts.filter((p) => p && p.trim().length > 0).join("\n");
}

/** Every key term driving coverage grading must be derivable from the provenance scope. */
function keyTermSupported(scope: string, term: string): boolean {
  if (isSourceSpan(scope, term)) return true;
  const scopeStems = new Set(contentWords(scope).map(lightStem));
  const words = contentWords(term);
  if (words.length === 0) return false;
  return words.every((w) => scopeStems.has(lightStem(w)));
}

export function validateQuestion(q: Question, sourceText: string, concepts: Concept[]): string[] {
  const errors: string[] = [];

  if (!q.id || q.id.length < 3) errors.push("missing id");
  if (!q.prompt || normText(q.prompt).length < 8) errors.push("prompt too short");
  if (!q.explanation || normText(q.explanation).length < 10) errors.push("explanation missing or too short");
  if (!q.evidence || q.evidence.length === 0) errors.push("no source evidence");

  // Grounding + instruction filtering: every evidence quote must exist verbatim in
  // the source and must not be instruction-like untrusted content.
  for (const ev of q.evidence ?? []) {
    if (looksLikeInstruction(ev.quote)) {
      errors.push("evidence quote is instruction-like content");
      break;
    }
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
  const scope = provenanceScope(q, concept);

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
      // Provenance: the correct answer must be a token-bounded span of the
      // question's/concept's validated evidence — occurring elsewhere in the
      // source document is not sufficient.
      if (correctText && !isSourceSpan(scope, correctText)) {
        errors.push("correct answer text is not grounded in the question's validated evidence");
      }
      break;
    }
    case "truefalse": {
      if (!q.statement || normText(q.statement).length < 12) errors.push("statement too short");
      if (typeof q.correctAnswer !== "boolean") errors.push("correctAnswer must be boolean");
      if (q.statement && looksLikeInstruction(q.statement)) {
        errors.push("statement is instruction-like content");
        break;
      }
      if (q.correctAnswer === true) {
        // A "true" statement must be verbatim from the source AND supported by the
        // scoped evidence contract.
        if (!quoteIsGrounded(sourceText, q.statement)) {
          errors.push("true statement is not grounded in the source");
        } else if (concept && !isSourceSpan(scope, q.statement)) {
          errors.push("true statement is not supported by the question's validated evidence");
        }
      } else if (q.correctAnswer === false) {
        // A statement is not proven false merely because it is absent verbatim.
        // False keys require a deterministic, re-derivable transformation proof.
        if (!q.falseProof) {
          errors.push("false statement has no deterministic proof of the false transformation");
          break;
        }
        const proofQuote = q.falseProof.sourceQuote;
        if (looksLikeInstruction(proofQuote) || !quoteIsGrounded(sourceText, proofQuote)) {
          errors.push("false statement proof quote is not grounded in the source");
          break;
        }
        const rederived = swapSubject(proofQuote, q.falseProof.originalSubject, concept?.name ?? "");
        if (!rederived || normText(rederived) !== normText(q.statement)) {
          errors.push("false statement does not match its deterministic transformation proof");
          break;
        }
        if (quoteIsGrounded(sourceText, q.statement)) {
          // The transformed statement exists verbatim in the source, so the
          // material itself supports it as true — the key would contradict it.
          errors.push("false statement is verbatim in the source, contradicting the answer key");
        }
      }
      break;
    }
    case "short": {
      if (!q.acceptedAnswers || q.acceptedAnswers.length === 0) errors.push("no accepted answers");
      if (q.acceptedAnswers.some((a) => normAnswer(a).length === 0)) errors.push("empty accepted answer");
      if (!q.modelAnswer || normAnswer(q.modelAnswer).length === 0) errors.push("model answer missing");
      // Provenance: graded answers must be token-bounded spans of the scoped
      // evidence — unrelated terms from elsewhere in the document are rejected.
      if (q.modelAnswer && normAnswer(q.modelAnswer).length > 0 && !isSourceSpan(scope, q.modelAnswer)) {
        errors.push("model answer is not grounded in the question's validated evidence");
      }
      if (q.acceptedAnswers) {
        for (const a of q.acceptedAnswers) {
          if (normAnswer(a).length > 0 && !isSourceSpan(scope, a)) {
            errors.push(`accepted answer not grounded in the question's validated evidence: "${a.slice(0, 50)}"`);
            break;
          }
        }
      }
      break;
    }
    case "explanation": {
      if (!q.keyTerms || q.keyTerms.length < 2) errors.push("not enough key terms for grading");
      if (!q.modelAnswer || normText(q.modelAnswer).length < 10) errors.push("model answer missing");
      // Provenance: the model answer and every grading term must be supported by
      // the scoped evidence, not by arbitrary source-global provider words.
      if (q.modelAnswer && normText(q.modelAnswer).length >= 10 && !isSourceSpan(scope, q.modelAnswer)) {
        errors.push("model answer is not grounded in the question's validated evidence");
      }
      if (q.keyTerms && q.keyTerms.length > 0) {
        for (const t of q.keyTerms) {
          if (!keyTermSupported(scope, t)) {
            errors.push(`key term not grounded in the question's validated evidence: "${t.slice(0, 50)}"`);
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

    // Canonical runtime schema gate: a typed object is not validation. Candidates
    // that violate the canonical schemas never reach the semantic gates.
    const schemaParsed = parseQuestionSchema(q);
    if (!schemaParsed.ok) {
      rejected.push({ questionId: q.id, errors: ["schema validation failed", ...schemaParsed.errors] });
      continue;
    }

    const errors = validateQuestion(schemaParsed.question, sourceText, concepts);
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

/**
 * Concept-level trust boundary, shared by all providers: a concept is acceptable
 * only when its name, description and evidence are grounded, non-instruction
 * source content AND the description/evidence actually support the concept
 * (the name occurs in them) rather than being independent source-global spans.
 */
export function validateConceptProvenance(concept: Concept, sourceText: string): string[] {
  const errors: string[] = [];
  const name = concept.name?.trim() ?? "";
  const description = concept.description?.trim() ?? "";

  if (!name || name.length < 2) errors.push("concept name missing");
  if (!description || description.length < 10) errors.push("concept description missing or too short");
  if (!concept.evidence || concept.evidence.length === 0) errors.push("concept has no evidence");

  if (name && looksLikeInstruction(name)) errors.push("concept name is instruction-like content");
  if (description && looksLikeInstruction(description)) errors.push("concept description is instruction-like content");
  for (const ev of concept.evidence ?? []) {
    if (looksLikeInstruction(ev.quote)) {
      errors.push("concept evidence is instruction-like content");
      break;
    }
  }

  if (description && !quoteIsGrounded(sourceText, description)) {
    errors.push("concept description not found in source material");
  }
  for (const ev of concept.evidence ?? []) {
    if (!quoteIsGrounded(sourceText, ev.quote)) {
      errors.push("concept evidence quote not found in source material");
      break;
    }
  }

  // Alignment: the concept identity must be supported by its own description or
  // evidence, otherwise the mapping cross-wired two concepts.
  if (name && !isSourceSpan(description, name) && !((concept.evidence ?? []).some((ev) => isSourceSpan(ev.quote, name)))) {
    errors.push("concept name is not supported by its own description/evidence");
  }

  return errors;
}
