import { describe, expect, it } from "vitest";
import { extractConcepts, extractTitle, quoteIsGrounded, splitSections } from "@/lib/extract";
import { SAMPLE_MATERIAL } from "@/sample/material";

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
