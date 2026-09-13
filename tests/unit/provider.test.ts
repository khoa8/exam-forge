import { afterEach, describe, expect, it, vi } from "vitest";
import { generateDeterministic } from "@/lib/provider/deterministic";
import { validateConcept, validateQuestion } from "@/lib/schemas";
import { SAMPLE_MATERIAL } from "@/sample/material";

describe("deterministic generator", () => {
  it("produces the same content for the same input (deterministic ids aside)", () => {
    const a = generateDeterministic(SAMPLE_MATERIAL);
    const b = generateDeterministic(SAMPLE_MATERIAL);
    expect(a.concepts.map((c) => c.name)).toEqual(b.concepts.map((c) => c.name));
    expect(a.questions.map((q) => q.prompt)).toEqual(b.questions.map((q) => q.prompt));
    expect(a.questions.map((q) => q.type)).toEqual(b.questions.map((q) => q.type));
    // Correct answers are identical between runs.
    const correctA = a.questions.map((q) => (q.type === "mcq" ? q.correctOptionId : q.type === "truefalse" ? q.correctAnswer : ""));
    const correctB = b.questions.map((q) => (q.type === "mcq" ? q.correctOptionId : q.type === "truefalse" ? q.correctAnswer : ""));
    expect(correctA).toEqual(correctB);
  });

  it("output passes the canonical runtime schemas and keeps all question types", () => {
    const output = generateDeterministic(SAMPLE_MATERIAL);
    // Positive control: the stricter per-field provenance contract must not
    // eliminate normal deterministic generation.
    expect(output.concepts.length).toBeGreaterThanOrEqual(8);
    expect(output.questions.length).toBeGreaterThanOrEqual(20);
    const types = new Set(output.questions.map((q) => q.type));
    expect(types.has("mcq")).toBe(true);
    expect(types.has("truefalse")).toBe(true);
    expect(types.has("short")).toBe(true);
    expect(types.has("explanation")).toBe(true);
    for (const c of output.concepts) {
      const parsed = validateConcept(c);
      expect(parsed.ok).toBe(true);
    }
    for (const q of output.questions) {
      const parsed = validateQuestion(q);
      expect(parsed.ok).toBe(true);
    }
  });

  it("rejects material with no extractable concepts", () => {
    expect(() => generateDeterministic("Hello world. Hi there!")).toThrow(/concepts/i);
  });
});

describe("deterministic-only contract (removed external LLM path)", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("ignores former provider environment variables — a stale LLM key cannot reactivate a removed network path", () => {
    process.env.EXAMFORGE_PROVIDER = "glm";
    process.env.EXAMFORGE_LLM_API_KEY = "stale-key";
    process.env.GLM_API_KEY = "stale-key";
    process.env.EXAMFORGE_LLM_BASE_URL = "http://127.0.0.1:9";
    process.env.EXAMFORGE_LLM_MODEL = "glm-4-flash";
    process.env.EXAMFORGE_LLM_TIMEOUT_MS = "1000";

    const withStaleEnv = generateDeterministic(SAMPLE_MATERIAL);
    const clean = generateDeterministic(SAMPLE_MATERIAL);
    expect(withStaleEnv.questions.length).toBeGreaterThan(10);
    // Stale configuration must not change generation in any way.
    expect(withStaleEnv.questions.map((q) => q.prompt)).toEqual(clean.questions.map((q) => q.prompt));
    expect(withStaleEnv.concepts.map((c) => c.name)).toEqual(clean.concepts.map((c) => c.name));
  });

  it("makes no network requests during generation", () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("unexpected outbound network request");
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as typeof fetch;
    try {
      const output = generateDeterministic(SAMPLE_MATERIAL);
      expect(output.concepts.length).toBeGreaterThanOrEqual(8);
      expect(output.questions.length).toBeGreaterThan(10);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
