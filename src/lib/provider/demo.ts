import type { MaterialProvider, ProviderOutput } from "./index";
import { ProviderError } from "./index";
import { extractConcepts } from "../extract";
import { generateQuestions } from "../generate";
import { validateQuestionSet } from "../validate";
import { injectionNotice, scanForInjection } from "./sanitize";

/**
 * Deterministic demo provider.
 *
 * Runs entirely without any model API: concepts are extracted with linguistic
 * heuristics and questions are built from the material's own definition
 * sentences. The same input always produces the same output. No LLM sees the
 * study material, so prompt injection cannot affect this path by construction.
 */
export class DemoProvider implements MaterialProvider {
  name = "demo";
  requiresKey = false;

  async generate(text: string): Promise<ProviderOutput> {
    const extraction = extractConcepts(text);

    if (extraction.concepts.length === 0) {
      throw new ProviderError(
        "Could not identify any concepts in this material. Try text with headings and clear definitions (for example 'X is …').",
      );
    }

    const seed = extraction.title;
    const generation = generateQuestions(text, extraction.concepts, seed);
    const validation = validateQuestionSet(generation.questions, text, extraction.concepts);

    const quality = { ...extraction.quality };
    const scan = scanForInjection(text);
    if (scan.detected) {
      quality.notes = [...quality.notes, injectionNotice()];
    }
    if (validation.duplicatesRemoved > 0) {
      quality.notes = [
        ...quality.notes,
        `${validation.duplicatesRemoved} near-duplicate question(s) were removed by validation.`,
      ];
    }

    return {
      provider: "demo",
      title: extraction.title,
      concepts: extraction.concepts,
      questions: validation.accepted,
      quality,
      dropped: generation.dropped,
      rejected: validation.rejected,
      duplicatesRemoved: validation.duplicatesRemoved,
    };
  }
}
