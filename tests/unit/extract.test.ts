import { describe, expect, it } from "vitest";
import { extractConcepts, extractTitle, isSourceSpan, quoteIsGrounded, splitSections } from "@/lib/extract";
import { SAMPLE_MATERIAL } from "@/sample/material";

const SOURCE =
  "Photosynthesis is the process by which plants convert light energy into chemical energy. Chlorophyll is the green pigment that absorbs light in plant leaves.";

describe("quote grounding contract (exact containment)", () => {
  it("accepts an exact source quote", () => {
    expect(quoteIsGrounded(SOURCE, "Photosynthesis is the process by which plants convert light energy into chemical energy.")).toBe(true);
  });

  it("accepts a legitimate shorter contiguous quote", () => {
    expect(quoteIsGrounded(SOURCE, "Chlorophyll is the green pigment that absorbs light in plant leaves")).toBe(true);
    expect(quoteIsGrounded(SOURCE, "plants convert light energy into chemical energy")).toBe(true);
  });

  it("rejects a real prefix followed by a fabricated suffix (F-01 class)", () => {
    // First six words are real; the continuation is fabricated.
    expect(
      quoteIsGrounded(SOURCE, "Photosynthesis is the process by which aliens invented chemistry."),
    ).toBe(false);
    expect(
      quoteIsGrounded(SOURCE, "Photosynthesis is the process by which plants convert light energy into sound waves."),
    ).toBe(false);
  });

  it("rejects an unrelated quote", () => {
    expect(quoteIsGrounded(SOURCE, "Cellular respiration releases energy stored in glucose bonds.")).toBe(false);
  });

  it("rejects quotes that are too short to be evidence", () => {
    expect(quoteIsGrounded(SOURCE, "light")).toBe(false);
  });

  it("tolerates whitespace and case differences via normalization", () => {
    expect(
      quoteIsGrounded(SOURCE, "Photosynthesis   is the process\nby which plants convert LIGHT energy into chemical energy."),
    ).toBe(true);
  });

  it("supports answer-span containment via isSourceSpan", () => {
    expect(isSourceSpan(SOURCE, "chlorophyll")).toBe(true);
    expect(isSourceSpan(SOURCE, "green pigment")).toBe(true);
    expect(isSourceSpan(SOURCE, "aliens invented chemistry")).toBe(false);
    expect(isSourceSpan(SOURCE, "ab")).toBe(false);
  });
});

describe("concept extraction", () => {
  it("extracts the main concepts from the bundled sample", () => {
    const { concepts, quality } = extractConcepts(SAMPLE_MATERIAL);
    expect(concepts.length).toBeGreaterThanOrEqual(8);
    expect(quality.level).toBe("good");
    const names = concepts.map((c) => c.name.toLowerCase());
    for (const expected of ["encoding", "storage", "retrieval", "working memory", "spacing effect"]) {
      expect(names).toContain(expected);
    }
  });

  it("does not treat question headings as concepts", () => {
    const { concepts } = extractConcepts(SAMPLE_MATERIAL);
    const names = concepts.map((c) => c.name.toLowerCase());
    expect(names.some((n) => n.startsWith("what "))).toBe(false);
  });

  it("grounds every concept description in the source text", () => {
    const { concepts } = extractConcepts(SAMPLE_MATERIAL);
    for (const c of concepts) {
      expect(c.evidence.length).toBeGreaterThan(0);
      expect(quoteIsGrounded(SAMPLE_MATERIAL, c.evidence[0].quote)).toBe(true);
    }
  });

  it("marks poor material honestly", () => {
    const result = extractConcepts("The sky is blue.\nWater is wet.");
    expect(result.quality.level).toBe("poor");
    expect(result.quality.notes.join(" ")).toMatch(/could not reliably identify/i);
  });

  it("uses markdown headings as sections", () => {
    const sections = splitSections(SAMPLE_MATERIAL);
    expect(sections.length).toBeGreaterThanOrEqual(10);
    expect(sections[1].heading).toBe("Encoding");
  });

  it("falls back to the first line for the title when no heading exists", () => {
    expect(extractTitle("# My Course\nBody")).toBe("My Course");
    expect(extractTitle("Just some text\nmore")).toBe("Just some text");
  });
});
