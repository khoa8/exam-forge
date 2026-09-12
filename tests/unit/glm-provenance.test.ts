import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { GlmProvider } from "@/lib/provider/glm";

/**
 * Deterministic contract tests for the GLM adapter's provenance rules.
 * A local HTTP stub plays the OpenAI-compatible endpoint, so no network or
 * API key is needed: model output with real evidence quotes but unsupported
 * answer-bearing content must be dropped, never persisted as grounded content.
 */

const SOURCE = `Photosynthesis is the process by which plants convert light energy into chemical energy. Chlorophyll is the green pigment that absorbs light in plant leaves. Cellular respiration is the process by which cells release energy stored in glucose.`;

const PHOTO_QUOTE =
  "Photosynthesis is the process by which plants convert light energy into chemical energy.";
const CHLORO_QUOTE = "Chlorophyll is the green pigment that absorbs light in plant leaves.";
const RESPIRATION_QUOTE =
  "Cellular respiration is the process by which cells release energy stored in glucose.";

function groundedConcepts() {
  return [
    { name: "Photosynthesis", description: PHOTO_QUOTE, evidenceQuote: PHOTO_QUOTE, importance: 1 },
    { name: "Chlorophyll", description: CHLORO_QUOTE, evidenceQuote: CHLORO_QUOTE, importance: 0.8 },
    { name: "Cellular respiration", description: RESPIRATION_QUOTE, evidenceQuote: RESPIRATION_QUOTE, importance: 0.7 },
  ];
}

function glmResponsePayload(raw: unknown): string {
  return JSON.stringify({ choices: [{ message: { content: JSON.stringify(raw) } }] });
}

let server: Server | null = null;

beforeEach(() => {
  server = null;
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

async function providerReturning(content: string, status = 200): Promise<GlmProvider> {
  await new Promise<void>((resolve) => {
    server = createServer((_req, res) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(content);
    });
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server!.address() as AddressInfo;
  return new GlmProvider({
    apiKey: "test-key-not-real",
    baseUrl: `http://127.0.0.1:${port}`,
    model: "glm-test",
    timeoutMs: 5000,
  });
}

describe("GLM adapter answer provenance", () => {
  it("keeps grounded questions and drops fabricated answer-bearing fields", async () => {
    const raw = {
      title: "Plant Biology",
      concepts: groundedConcepts(),
      questions: [
        {
          // Valid MCQ: correct option is a contiguous source span.
          conceptName: "Photosynthesis",
          type: "mcq",
          prompt: "According to the material, what is Photosynthesis?",
          options: [
            "process by which cells release energy stored in glucose",
            "process by which plants convert light energy into chemical energy",
            "green pigment that absorbs light in plant leaves",
          ],
          correctOption: 1,
          evidenceQuote: PHOTO_QUOTE,
          difficulty: "easy",
        },
        {
          // Fabricated MCQ correct answer riding on a real evidence quote.
          conceptName: "Chlorophyll",
          type: "mcq",
          prompt: "According to the material, what is Chlorophyll?",
          options: [
            "green pigment that absorbs light in plant leaves",
            "process by which aliens invented chemistry",
            "process by which cells release energy stored in glucose",
          ],
          correctOption: 1,
          evidenceQuote: CHLORO_QUOTE,
          difficulty: "easy",
        },
        {
          // Fabricated short answer on a real evidence quote.
          conceptName: "Cellular respiration",
          type: "short",
          prompt: "Fill in the blank according to the material.",
          modelAnswer: "aliens invented chemistry",
          acceptedAnswers: ["aliens invented chemistry"],
          evidenceQuote: RESPIRATION_QUOTE,
          difficulty: "medium",
        },
        {
          // Valid short answer: answers are source spans.
          conceptName: "Chlorophyll",
          type: "short",
          prompt: "Fill in the blank according to the material.",
          modelAnswer: "Chlorophyll",
          acceptedAnswers: ["Chlorophyll"],
          evidenceQuote: CHLORO_QUOTE,
          difficulty: "medium",
        },
        {
          // Unsupported key terms must not drive explanation grading.
          conceptName: "Photosynthesis",
          type: "explanation",
          prompt: "In your own words, explain what Photosynthesis is.",
          modelAnswer: PHOTO_QUOTE,
          keyTerms: ["quantum", "neutrino"],
          evidenceQuote: PHOTO_QUOTE,
          difficulty: "hard",
        },
        {
          // Valid explanation: model answer and key terms come from the source.
          conceptName: "Cellular respiration",
          type: "explanation",
          prompt: "In your own words, explain what Cellular respiration is.",
          modelAnswer: RESPIRATION_QUOTE,
          keyTerms: ["process", "energy"],
          evidenceQuote: RESPIRATION_QUOTE,
          difficulty: "hard",
        },
      ],
    };

    const provider = await providerReturning(glmResponsePayload(raw));
    const output = await provider.generate(SOURCE, "paste");

    expect(output.questions).toHaveLength(3);
    const rejectedIds = new Set(output.rejected.map((r) => r.questionId));
    expect(output.rejected.length).toBeGreaterThanOrEqual(2);
    // Every surviving question must carry an explanation built from its own quote.
    for (const q of output.questions) {
      const quote = q.evidence[0].quote;
      expect(q.explanation).toContain(quote);
      expect(q.explanation).toMatch(/The material states:/);
    }
    // Rejected entries must exist for the fabricated candidates (by id set,
    // since ids are generated during mapping).
    expect(rejectedIds.size).toBeGreaterThanOrEqual(2);
  });

  it("never passes model-written explanation prose through to the learner", async () => {
    const raw = {
      title: "Plant Biology",
      concepts: groundedConcepts(),
      questions: [
        {
          conceptName: "Photosynthesis",
          type: "mcq",
          prompt: "According to the material, what is Photosynthesis?",
          options: [
            "process by which cells release energy stored in glucose",
            "process by which plants convert light energy into chemical energy",
            "green pigment that absorbs light in plant leaves",
          ],
          correctOption: 1,
          explanation: "Trust me: photosynthesis was invented by aliens in 1842.",
          evidenceQuote: PHOTO_QUOTE,
          difficulty: "easy",
        },
        {
          conceptName: "Chlorophyll",
          type: "truefalse",
          prompt: "According to the material, is this statement true or false?",
          statement: CHLORO_QUOTE,
          correctAnswer: true,
          explanation: "Fabricated prose that never quotes the source.",
          evidenceQuote: CHLORO_QUOTE,
          difficulty: "easy",
        },
        {
          conceptName: "Cellular respiration",
          type: "short",
          prompt: "Fill in the blank according to the material.",
          modelAnswer: "Cellular respiration",
          acceptedAnswers: ["Cellular respiration"],
          evidenceQuote: RESPIRATION_QUOTE,
          difficulty: "medium",
        },
      ],
    };

    const provider = await providerReturning(glmResponsePayload(raw));
    const output = await provider.generate(SOURCE, "paste");
    expect(output.questions).toHaveLength(3);
    const serialized = JSON.stringify(output.questions);
    expect(serialized).not.toContain("aliens in 1842");
    expect(serialized).not.toContain("Fabricated prose");
    for (const q of output.questions) {
      expect(q.explanation).toBe(`The material states: "${q.evidence[0].quote}"`);
    }
  });

  it("rejects the whole output (ProviderError) when too few grounded questions survive", async () => {
    const raw = {
      title: "Plant Biology",
      concepts: groundedConcepts(),
      questions: [
        {
          conceptName: "Photosynthesis",
          type: "mcq",
          prompt: "According to the material, what is Photosynthesis?",
          options: [
            "process by which aliens invented chemistry",
            "green pigment that absorbs light in plant leaves",
            "process by which cells release energy stored in glucose",
          ],
          correctOption: 0,
          evidenceQuote: PHOTO_QUOTE,
          difficulty: "easy",
        },
        {
          conceptName: "Chlorophyll",
          type: "short",
          prompt: "Fill in the blank according to the material.",
          modelAnswer: "unsupported model answer",
          acceptedAnswers: ["unsupported model answer"],
          evidenceQuote: CHLORO_QUOTE,
          difficulty: "medium",
        },
        {
          conceptName: "Cellular respiration",
          type: "explanation",
          prompt: "In your own words, explain what Cellular respiration is.",
          modelAnswer: "Cellular respiration was invented by aliens in 1842 for unrelated reasons.",
          keyTerms: ["quantum", "neutrino"],
          evidenceQuote: RESPIRATION_QUOTE,
          difficulty: "hard",
        },
      ],
    };

    const provider = await providerReturning(glmResponsePayload(raw));
    await expect(provider.generate(SOURCE, "paste")).rejects.toThrow(/Too few GLM questions/i);
  });

  it("drops concepts whose names or descriptions are not grounded in the source", async () => {
    const raw = {
      title: "Plant Biology",
      concepts: [
        ...groundedConcepts(),
        { name: "Alien botany", description: "Alien botany is the study of extraterrestrial plants.", evidenceQuote: PHOTO_QUOTE, importance: 0.5 },
      ],
      questions: [
        {
          conceptName: "Photosynthesis",
          type: "mcq",
          prompt: "According to the material, what is Photosynthesis?",
          options: [
            "process by which cells release energy stored in glucose",
            "process by which plants convert light energy into chemical energy",
            "green pigment that absorbs light in plant leaves",
          ],
          correctOption: 1,
          evidenceQuote: PHOTO_QUOTE,
          difficulty: "easy",
        },
        {
          conceptName: "Chlorophyll",
          type: "truefalse",
          prompt: "According to the material, is this statement true or false?",
          statement: CHLORO_QUOTE,
          correctAnswer: true,
          evidenceQuote: CHLORO_QUOTE,
          difficulty: "easy",
        },
        {
          conceptName: "Cellular respiration",
          type: "short",
          prompt: "Fill in the blank according to the material.",
          modelAnswer: "Cellular respiration",
          acceptedAnswers: ["Cellular respiration"],
          evidenceQuote: RESPIRATION_QUOTE,
          difficulty: "medium",
        },
      ],
    };

    const provider = await providerReturning(glmResponsePayload(raw));
    const output = await provider.generate(SOURCE, "paste");
    expect(output.concepts.map((c) => c.name)).not.toContain("Alien botany");
    expect(output.concepts).toHaveLength(3);
  });

  it("rejects concepts keyed true when their statements are not source spans", async () => {
    const raw = {
      title: "Plant Biology",
      concepts: groundedConcepts(),
      questions: [
        {
          conceptName: "Photosynthesis",
          type: "truefalse",
          prompt: "According to the material, is this statement true or false?",
          statement: "Photosynthesis converts light energy into sound waves.",
          correctAnswer: true,
          evidenceQuote: PHOTO_QUOTE,
          difficulty: "easy",
        },
        {
          conceptName: "Chlorophyll",
          type: "truefalse",
          prompt: "According to the material, is this statement true or false?",
          statement: CHLORO_QUOTE,
          correctAnswer: true,
          evidenceQuote: CHLORO_QUOTE,
          difficulty: "easy",
        },
        {
          conceptName: "Cellular respiration",
          type: "short",
          prompt: "Fill in the blank according to the material.",
          modelAnswer: "Cellular respiration",
          acceptedAnswers: ["Cellular respiration"],
          evidenceQuote: RESPIRATION_QUOTE,
          difficulty: "medium",
        },
        {
          conceptName: "Cellular respiration",
          type: "mcq",
          prompt: "According to the material, what is Cellular respiration?",
          options: [
            "process by which plants convert light energy into chemical energy",
            "process by which cells release energy stored in glucose",
            "green pigment that absorbs light in plant leaves",
          ],
          correctOption: 1,
          evidenceQuote: RESPIRATION_QUOTE,
          difficulty: "easy",
        },
      ],
    };

    const provider = await providerReturning(glmResponsePayload(raw));
    const output = await provider.generate(SOURCE, "paste");
    // The fabricated "true" statement is dropped; the grounded ones survive.
    expect(output.questions).toHaveLength(3);
    expect(output.rejected.length).toBeGreaterThanOrEqual(1);
  });
});
