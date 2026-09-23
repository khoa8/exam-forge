import type { Concept, ExtractionQuality, Question } from "../types.ts";
import type { ValidationIssue } from "../validate.ts";
import { extractConcepts } from "../extract.ts";
import { generateQuestions } from "../generate.ts";
import { validateQuestionSet, validateConceptProvenance } from "../validate.ts";
import { validateConcept } from "../schemas.ts";
import { injectionNotice, scanForInjection } from "./sanitize.ts";

/**
 * The only material-generation path in ExamForge: deterministic and local.
 *
 * Runs entirely without any model API: concepts are extracted with linguistic
 * heuristics and questions are built from the material's own definition
 * sentences. The same input always produces the same output. No external
 * service sees the study material, so prompt injection cannot reach a model
 * through this path by construction.
 *
 * Accepted concepts pass the same canonical runtime schema and provenance gates
 * as every other candidate — deterministic code is not exempt from the trust
 * boundary.
 */

export class ProviderError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * Controlled provider error: the source material contained no extractable,
 * grounded concepts. Represents an expected user-content limitation rather
 * than an unexpected internal server failure.
 */
export class NoConceptsError extends ProviderError {
  constructor(message: string) {
    super(message);
    this.name = "NoConceptsError";
  }
}

export interface ProviderOutput {
  title: string;
  concepts: Concept[];
  questions: Question[];
  quality: ExtractionQuality;
  dropped: { reason: string; count: number }[];
  rejected: ValidationIssue[];
  duplicatesRemoved: number;
}

export function generateDeterministic(text: string): ProviderOutput {
  const extraction = extractConcepts(text);

  // Concept trust boundary: canonical schema + grounded, aligned provenance.
  const concepts: Concept[] = [];
  for (const c of extraction.concepts) {
    if (!validateConcept(c).ok) continue;
    if (validateConceptProvenance(c, text).length > 0) continue;
    concepts.push(c);
  }
  const conceptsDropped = extraction.concepts.length - concepts.length;

  if (concepts.length === 0) {
    throw new NoConceptsError(
      "Could not identify any concepts in this material. Try text with headings and clear definitions (for example 'X is …').",
    );
  }

  const seed = extraction.title;
  const generation = generateQuestions(text, concepts, seed);
  const validation = validateQuestionSet(generation.questions, text, concepts);

  const quality = { ...extraction.quality };
  const scan = scanForInjection(text);
  if (scan.detected) {
    quality.notes = [...quality.notes, injectionNotice()];
  }
  if (conceptsDropped > 0) {
    quality.notes = [
      ...quality.notes,
      `${conceptsDropped} extracted concept(s) were dropped because their content was not fully grounded in the material.`,
    ];
  }
  if (validation.duplicatesRemoved > 0) {
    quality.notes = [
      ...quality.notes,
      `${validation.duplicatesRemoved} near-duplicate question(s) were removed by validation.`,
    ];
  }

  return {
    title: extraction.title,
    concepts,
    questions: validation.accepted,
    quality,
    dropped: generation.dropped,
    rejected: validation.rejected,
    duplicatesRemoved: validation.duplicatesRemoved,
  };
}
