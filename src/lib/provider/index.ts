import type { Concept, ExtractionQuality, Question, SourceType } from "../types";
import type { ValidationIssue } from "../validate";

/**
 * Provider contract. ExamForge can generate concepts and questions through any
 * provider that implements this interface. The deterministic demo provider needs
 * no API key; LLM providers (e.g. GLM) are optional adapters behind the same
 * interface and validated with the same schemas and grounding checks.
 */

export interface ProviderOutput {
  provider: string;
  title: string;
  concepts: Concept[];
  questions: Question[];
  quality: ExtractionQuality;
  dropped: { reason: string; count: number }[];
  rejected: ValidationIssue[];
  duplicatesRemoved: number;
  providerNotice?: string;
}

export interface MaterialProvider {
  /** Identifier recorded on generated content, e.g. "demo" or "glm:glm-4-flash". */
  name: string;
  requiresKey: boolean;
  generate(text: string, sourceType: SourceType): Promise<ProviderOutput>;
}

export class ProviderError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "ProviderError";
  }
}
