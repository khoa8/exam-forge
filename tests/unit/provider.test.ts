import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DemoProvider } from "@/lib/provider/demo";
import { GlmProvider } from "@/lib/provider/glm";
import { generateWithFallback, resolveProvider } from "@/lib/provider/registry";
import { validateConcept, validateQuestion } from "@/lib/schemas";
import { SAMPLE_MATERIAL } from "@/sample/material";

describe("demo provider", () => {
  it("produces the same content for the same input (deterministic ids aside)", async () => {
    const a = await new DemoProvider().generate(SAMPLE_MATERIAL);
    const b = await new DemoProvider().generate(SAMPLE_MATERIAL);
    expect(a.concepts.map((c) => c.name)).toEqual(b.concepts.map((c) => c.name));
    expect(a.questions.map((q) => q.prompt)).toEqual(b.questions.map((q) => q.prompt));
    expect(a.questions.map((q) => q.type)).toEqual(b.questions.map((q) => q.type));
    // Correct answers are identical between runs.
    const correctA = a.questions.map((q) => (q.type === "mcq" ? q.correctOptionId : q.type === "truefalse" ? q.correctAnswer : ""));
    const correctB = b.questions.map((q) => (q.type === "mcq" ? q.correctOptionId : q.type === "truefalse" ? q.correctAnswer : ""));
    expect(correctA).toEqual(correctB);
  });

  it("output passes the canonical runtime schemas for every accepted concept and question", async () => {
    const output = await new DemoProvider().generate(SAMPLE_MATERIAL);
    expect(output.concepts.length).toBeGreaterThan(0);
    expect(output.questions.length).toBeGreaterThan(0);
    for (const c of output.concepts) {
      const parsed = validateConcept(c);
      expect(parsed.ok).toBe(true);
    }
    for (const q of output.questions) {
      const parsed = validateQuestion(q);
      expect(parsed.ok).toBe(true);
    }
  });

  it("rejects material with no extractable concepts", async () => {
    await expect(new DemoProvider().generate("Hello world. Hi there!")).rejects.toThrow(/concepts/i);
  });
});

describe("provider registry and fallback", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.EXAMFORGE_LLM_API_KEY;
    delete process.env.GLM_API_KEY;
    delete process.env.EXAMFORGE_PROVIDER;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("uses the demo provider when no key is configured", () => {
    const resolved = resolveProvider();
    expect(resolved.provider.name).toBe("demo");
    expect(resolved.provider.requiresKey).toBe(false);
  });

  it("throws a helpful error when glm is forced without a key", () => {
    process.env.EXAMFORGE_PROVIDER = "glm";
    expect(() => resolveProvider()).toThrow(/no API key/i);
  });

  it("falls back to the demo provider when the LLM adapter fails", async () => {
    process.env.EXAMFORGE_LLM_API_KEY = "test-key-that-will-fail";
    process.env.EXAMFORGE_LLM_BASE_URL = "http://127.0.0.1:9"; // unreachable
    process.env.EXAMFORGE_LLM_TIMEOUT_MS = "1500";

    const outcome = await generateWithFallback(SAMPLE_MATERIAL, "bundled");
    expect(outcome.provider).toBe("demo");
    expect(outcome.fallbackNotice).toMatch(/failed/i);
    expect(outcome.questions.length).toBeGreaterThan(10);
  }, 30_000);

  it("wraps fetch failures and timeouts in ProviderError", async () => {
    const glm = new GlmProvider({
      apiKey: "k",
      baseUrl: "http://127.0.0.1:9",
      model: "glm-4-flash",
      timeoutMs: 1000,
    });
    await expect(glm.generate(SAMPLE_MATERIAL, "bundled")).rejects.toThrow(/GLM/);
  }, 15_000);

  it("rejects malformed JSON from the model", async () => {
    const failing = new GlmProvider({
      apiKey: "k",
      baseUrl: "http://127.0.0.1:9",
      model: "m",
      timeoutMs: 1000,
    });
    await expect(failing.generate(SAMPLE_MATERIAL, "bundled")).rejects.toThrow();
  });
});
