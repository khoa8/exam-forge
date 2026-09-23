import { isAlphaRatio } from "./util.ts";

/**
 * Ingestion: pasted text/Markdown, text-based PDF, and the bundled sample.
 * Parsing problems are surfaced honestly instead of silently degrading.
 */

export interface IngestResult {
  text: string;
  warnings: string[];
}

export function ingestText(input: string): IngestResult {
  const warnings: string[] = [];
  const text = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();

  if (text.length < 200) {
    warnings.push("The material is very short — concept extraction and question generation will be limited.");
  }
  const alpha = isAlphaRatio(text.slice(0, 2000));
  if (alpha < 0.5) {
    warnings.push("The material contains little readable text. If this is a scanned document or slides, try pasting plain text instead.");
  }
  return { text, warnings };
}

export async function ingestPdf(buffer: Uint8Array): Promise<IngestResult> {
  const warnings: string[] = [];
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text, totalPages } = await extractText(pdf, { mergePages: true });
    let merged = (Array.isArray(text) ? text.join("\n") : text)
      .replace(/\r\n?/g, "\n")
      // de-hyphenate words split across PDF lines
      .replace(/(\w)-\n(\w)/g, "$1$2")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    if (merged.length < 200) {
      warnings.push(
        "Almost no text could be extracted from this PDF. It is probably scanned or image-based (OCR is not supported yet). Please paste the text instead.",
      );
      merged = "";
    } else if (isAlphaRatio(merged.slice(0, 2000)) < 0.5) {
      warnings.push("The extracted PDF text looks noisy. Concepts may be incomplete — check them before studying.");
    } else {
      warnings.push(`Extracted text from ${totalPages} PDF page(s). Layout (figures, tables, columns) may not survive extraction.`);
    }
    return { text: merged, warnings };
  } catch (err) {
    throw new Error(`PDF extraction failed: ${(err as Error).message}`);
  }
}
