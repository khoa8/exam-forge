import { describe, expect, it } from "vitest";
import { ingestPdf, ingestText } from "@/lib/ingest";

/** Build a minimal single-page text PDF with correct xref offsets. */
function buildTextPdf(lines: string[]): Buffer {
  const content = lines
    .map((line, i) => `BT /F1 12 Tf 72 ${720 - i * 16} Td (${line.replace(/([()\\])/g, "\\$1")}) Tj ET`)
    .join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

describe("text ingestion", () => {
  it("normalizes line endings and strips BOM", () => {
    const long = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} explains a fact about the topic in detail.`).join("\r\n");
    const result = ingestText("\uFEFF" + long);
    expect(result.text).toBe(long.replace(/\r\n/g, "\n"));
    expect(result.warnings).toHaveLength(0);
  });

  it("warns about very short material", () => {
    const result = ingestText("Too short.");
    expect(result.warnings.some((w) => /very short/i.test(w))).toBe(true);
  });

  it("warns when material has little readable text", () => {
    const result = ingestText("1234567890 +-*/= 1234567890 +-*/= 1234567890 +-*/= 1234567890 +-*/= 1234567890 abc");
    expect(result.warnings.some((w) => /little readable text/i.test(w))).toBe(true);
  });
});

describe("pdf ingestion", () => {
  it("extracts text from a simple text-based PDF", async () => {
    const pdf = buildTextPdf([
      "Photosynthesis is the process by which plants convert light energy into chemical energy.",
      "Chlorophyll is the green pigment that absorbs light in plant leaves.",
      "Cellular respiration is the process by which cells release energy stored in glucose.",
      "The Calvin cycle is the set of chemical reactions that fix carbon dioxide into glucose.",
      "Stomata are small pores on the underside of leaves that exchange gases.",
      "Transpiration is the movement of water through a plant and its evaporation from leaves.",
    ]);
    const result = await ingestPdf(pdf);
    expect(result.text).toContain("Photosynthesis");
    expect(result.text).toContain("Chlorophyll is the green pigment");
  });

  it("is honest when a valid PDF has no extractable text layer", async () => {
    // A structurally valid PDF whose only page has an empty content stream,
    // like a scanned document with no OCR text layer.
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
      "<< /Length 0 >>\nstream\nendstream",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let pdf = "%PDF-1.4\n";
    const offsets: number[] = [];
    objects.forEach((body, i) => {
      offsets.push(pdf.length);
      pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xrefStart = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

    const result = await ingestPdf(Buffer.from(pdf, "latin1"));
    expect(result.text).toBe("");
    expect(result.warnings.join(" ")).toMatch(/scanned or image-based|OCR/i);
  });

  it("throws with a clear message for invalid PDFs", async () => {
    await expect(ingestPdf(Buffer.from("this is not a pdf at all"))).rejects.toThrow(/PDF|parse|structure/i);
  });
});
