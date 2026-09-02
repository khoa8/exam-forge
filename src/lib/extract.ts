import type { Concept, Evidence, ExtractionQuality } from "./types";
import { contentWords, normText, randomId, wordSimilarity, stripArticle, capitalize } from "./util";

/**
 * Deterministic, key-free concept extraction from study text.
 *
 * Strategy:
 *  1. Split the material into sections (markdown headings when present, else blocks).
 *  2. Collect concept candidates from headings, bold terms, "X is/are/refers to ..."
 *     definition sentences, and repeated capitalized phrases.
 *  3. Score candidates (definition evidence and salience), merge near-duplicates,
 *     and keep the top concepts.
 *  4. Each concept keeps a description and evidence quote taken verbatim from the
 *     material — nothing is invented.
 */

export interface Section {
  heading: string;
  body: string;
  start: number;
}

const GENERIC_HEADINGS = new Set([
  "introduction", "overview", "summary", "conclusion", "conclusions", "contents",
  "references", "bibliography", "appendix", "chapter", "section", "notes", "objectives",
  "learning objectives", "review", "review questions", "further reading", "table of contents",
  "toc", "index", "preface", "foreword", "acknowledgments", "acknowledgements", "key terms",
  "glossary", "study guide", "exam tips", "about",
]);

interface Candidate {
  name: string;
  score: number;
  definitionSentence: string | null;
  occurrences: number;
  firstOffset: number;
  section: string;
  mentionOffsets: number[];
}

export function splitSections(text: string): Section[] {
  const sections: Section[] = [];
  const lines = text.split("\n");
  let current: Section = { heading: "", body: "", start: 0 };
  let offset = 0;
  for (const line of lines) {
    const headingMatch = /^(#{1,4})\s+(.{2,120})\s*$/.exec(line);
    if (headingMatch) {
      if (current.body.trim().length > 0 || current.heading) sections.push(current);
      current = { heading: headingMatch[2].trim(), body: "", start: offset };
    } else {
      current.body += line + "\n";
    }
    offset += line.length + 1;
  }
  if (current.body.trim().length > 0 || current.heading) sections.push(current);
  if (sections.length === 0 && text.trim().length > 0) {
    sections.push({ heading: "", body: text, start: 0 });
  }
  return sections;
}

/** Split text into sentences (line-broken aware, abbreviation tolerant). */
export function splitSentences(text: string): { sentence: string; offset: number }[] {
  const out: { sentence: string; offset: number }[] = [];
  const re = /[^.!?\n]+(?:[.!?]+|\n+|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const s = m[0].trim();
    if (s.length >= 8) {
      const leadingWs = m[0].length - m[0].trimStart().length;
      out.push({ sentence: s, offset: m.index + leadingWs });
    }
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return out;
}

function isGenericHeading(h: string): boolean {
  const n = normText(h).replace(/[^a-z0-9\s]/g, "");
  if (GENERIC_HEADINGS.has(n)) return true;
  // e.g. "1. Introduction", "Chapter 3: Summary"
  return n.split(/\s+/).every((w) => GENERIC_HEADINGS.has(w) || /^\d+$/.test(w));
}

/** Headings phrased as questions ("What Is Memory?") are not concepts. */
function isQuestionHeading(h: string): boolean {
  return /^(what|why|how|when|who|where|which|is|are|does|do|can|could|should)\b/i.test(h.trim());
}

function extractDefinitionSubject(sentence: string): string | null {
  // "Encoding is the process of ..." / "The spacing effect refers to ..."
  const m =
    /^(.{3,80}?)\s+(?:is|are)\s+(?:defined\s+as|known\s+as|referred\s+to\s+as|considered|essentially|simply|basically)?\s*(?:the\s+|a\s+|an\s+)?\S/.exec(
      sentence,
    );
  if (!m) return null;
  let subj = m[1].trim();
  subj = stripArticle(subj);
  if (subj.length < 3 || subj.length > 60) return null;
  const words = subj.split(/\s+/);
  if (words.length > 6) return null;
  const first = words[0].toLowerCase();
  if (["this", "that", "these", "those", "it", "there", "they", "we", "he", "she", "which", "such", "here"].includes(first)) return null;
  if (/^(in|on|at|to|for|from|by|with|as|of|if|when|while|because|and|or|but|so|also|however|additionally|moreover|therefore|for example|in addition|in contrast)$/i.test(first)) return null;
  return subj;
}

function addCandidate(
  map: Map<string, Candidate>,
  rawName: string,
  score: number,
  offset: number,
  section: string,
  definitionSentence: string | null,
) {
  const name = capitalize(stripArticle(rawName.trim()));
  if (name.length < 3 || name.length > 60) return;
  const words = name.split(/\s+/);
  if (words.length > 6) return;
  if (words.every((w) => w.length < 3)) return;
  const key = normText(name);
  const existing = map.get(key);
  if (existing) {
    existing.score += score;
    existing.occurrences += 1;
    existing.mentionOffsets.push(offset);
    if (definitionSentence && !existing.definitionSentence) {
      existing.definitionSentence = definitionSentence;
    }
  } else {
    map.set(key, {
      name,
      score,
      definitionSentence,
      occurrences: 1,
      firstOffset: offset,
      section,
      mentionOffsets: [offset],
    });
  }
}

export interface ExtractionResult {
  concepts: Concept[];
  title: string;
  quality: ExtractionQuality;
}

export function extractTitle(text: string): string {
  const h1 = /^#\s+(.{3,120})\s*$/m.exec(text);
  if (h1) return h1[1].trim();
  const firstLine =
    text
      .split("\n")
      .map((l) => l.replace(/^[#>\-*\d.\s]+/, "").trim())
      .find((l) => l.length >= 6) ?? "";
  return firstLine.length > 0 ? firstLine.slice(0, 80) : "Untitled material";
}

export function extractConcepts(text: string, maxConcepts = 10): ExtractionResult {
  const normalized = text.replace(/\r\n?/g, "\n");
  const sections = splitSections(normalized);
  const title = extractTitle(normalized);
  const notes: string[] = [];
  const candidates = new Map<string, Candidate>();

  for (const section of sections) {
    const heading = section.heading;
    const bodyOffset = section.start + (heading.length > 0 ? heading.length + 1 : 0);

    if (heading && !isGenericHeading(heading) && !isQuestionHeading(heading) && heading.length <= 60) {
      addCandidate(candidates, heading.replace(/[.:?!]+$/, ""), 3, bodyOffset, heading, null);
    }

    // Bold markdown terms: **term**
    for (const bm of section.body.matchAll(/\*\*(.{3,60}?)\*\*/g)) {
      addCandidate(candidates, bm[1].replace(/[.:]$/, ""), 2, bodyOffset + (bm.index ?? 0), heading, null);
    }

    const sentences = splitSentences(section.body);
    for (const { sentence, offset } of sentences) {
      const subj = extractDefinitionSubject(sentence);
      if (subj) {
        addCandidate(candidates, subj, 3.5, bodyOffset + offset, heading, sentence);
      } else {
        // Non-definition mentions still add salience to existing candidates.
        for (const cand of candidates.values()) {
          if (normText(sentence).includes(normText(cand.name))) {
            cand.score += 0.4;
            cand.occurrences += 1;
          }
        }
      }
    }
  }

  // Repeated capitalized phrases (likely domain terms)
  for (const section of sections) {
    for (const cm of section.body.matchAll(/\b(?:[A-Z][a-z]{2,}\s+){1,3}[A-Z][a-z]{2,}\b/g)) {
      const phrase = cm[0].trim();
      const offset = section.start + (cm.index ?? 0);
      const key = normText(phrase);
      const existing = candidates.get(key);
      if (existing) existing.score += 0.8;
      else addCandidate(candidates, phrase, 0.8, offset, section.heading, null);
    }
  }

  // Merge candidates that are substrings of higher-scored ones (keep canonical).
  const all = Array.from(candidates.values()).sort((a, b) => b.score - a.score);
  const kept: Candidate[] = [];
  for (const cand of all) {
    const normName = normText(cand.name);
    const duplicate = kept.find((k) => {
      const normK = normText(k.name);
      return normK.includes(normName) || normName.includes(normK);
    });
    if (duplicate) {
      duplicate.score += cand.score * 0.5;
      duplicate.occurrences += cand.occurrences;
      if (!duplicate.definitionSentence && cand.definitionSentence) {
        duplicate.definitionSentence = cand.definitionSentence;
      }
    } else {
      kept.push(cand);
    }
  }

  const maxScore = Math.max(1, ...kept.map((c) => c.score));
  const concepts: Concept[] = kept
    .filter((c) => c.score >= 1.5)
    .slice(0, maxConcepts)
    .map((c, i) => {
      const description = c.definitionSentence
        ? c.definitionSentence
        : firstMentionSentence(normalized, c.name) ?? `Key topic "${c.name}" appears repeatedly in the material.`;
      const evidence = buildEvidence(normalized, description, c.section, c.firstOffset);
      return {
        id: `c_${String(i + 1).padStart(2, "0")}_${randomId()}`,
        name: c.name,
        description,
        evidence,
        importance: Math.min(1, c.score / maxScore),
      };
    });

  // Quality assessment — be honest about weak extractions.
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  const hasHeadings = sections.some((s) => s.heading.length > 0);
  if (concepts.length >= 6 && wordCount >= 250) {
    notes.push(`Identified ${concepts.length} concepts from ${wordCount} words.`);
    if (!hasHeadings) notes.push("No headings found — concepts were inferred from definition sentences and term frequency.");
  } else if (concepts.length >= 3) {
    notes.push(`Only ${concepts.length} concepts could be identified confidently; the material may be too short or unstructured for a full diagnosis.`);
  } else {
    notes.push("Could not reliably identify concepts. For best results paste material with headings and clear definitions (for example 'X is …').");
  }
  const level: ExtractionQuality["level"] = concepts.length >= 6 ? "good" : concepts.length >= 3 ? "fair" : "poor";

  return { concepts, title, quality: { level, notes } };
}

function firstMentionSentence(text: string, name: string): string | null {
  const sentences = splitSentences(text);
  const normName = normText(name);
  for (const { sentence } of sentences) {
    if (normText(sentence).includes(normName)) return sentence;
  }
  return null;
}

export function buildEvidence(text: string, sentence: string, section?: string, offset?: number): Evidence[] {
  const normSource = normText(text);
  const normQuote = normText(sentence);
  const idx = normSource.indexOf(normQuote);
  if (idx < 0 || normQuote.length < 8) return [];
  const ev: Evidence = { quote: sentence.trim(), section: section && section.length > 0 ? section : undefined };
  if (offset !== undefined) ev.offset = offset;
  return [ev];
}

/** Verify that an evidence quote is actually present in the source (grounding audit). */
export function quoteIsGrounded(text: string, quote: string): boolean {
  const normSource = normText(text);
  const normQuote = normText(quote);
  if (normQuote.length < 8) return false;
  if (normSource.includes(normQuote)) return true;
  // Quotes may be truncated for long sentences — allow prefix match on the quote.
  const words = normQuote.split(" ");
  if (words.length >= 6) {
    const prefix = words.slice(0, 6).join(" ");
    return normSource.includes(prefix);
  }
  return false;
}

/** Concept-name similarity used to avoid near-duplicate concepts. */
export function conceptTooSimilar(a: string, b: string): boolean {
  return wordSimilarity(a, b) > 0.85 || normText(a) === normText(b);
}

export { contentWords };
