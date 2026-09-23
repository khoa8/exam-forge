import type { AnswerValue, Question } from "./types.ts";

/** Small seeded RNG (mulberry32) so "random" behavior is reproducible per course. */
export function seededRandom(seedText: string): () => number {
  let h = 1779033703 ^ seedText.length;
  for (let i = 0; i < seedText.length; i++) {
    h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomId(prefix = ""): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}${hex}`;
}

/** Normalize text for comparisons: lowercase, collapse whitespace. */
export function normText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Strip punctuation and common filler for answer comparison. */
export function normAnswer(s: string): string {
  let t = normText(s);
  t = t.replace(/[.,;:!?"'`(){}\[\]]/g, "").trim();
  t = t.replace(/^(a|an|the)\s+/, "");
  return t;
}

/** Very light stemmer: strips common suffixes for coverage matching. */
export function lightStem(word: string): string {
  let w = word.toLowerCase();
  if (w.length > 5 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && w.endsWith("sses")) return w.slice(0, -2);
  if (w.length > 4 && (w.endsWith("ing") || w.endsWith("ed"))) w = w.slice(0, w.length - 3);
  else if (w.length > 3 && w.endsWith("es")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  return w;
}

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "than", "that", "this", "these", "those",
  "of", "in", "on", "at", "to", "for", "from", "by", "with", "as", "is", "are", "was", "were",
  "be", "been", "being", "it", "its", "they", "them", "their", "we", "our", "you", "your",
  "he", "she", "his", "her", "not", "no", "can", "will", "would", "should", "could", "may",
  "might", "must", "do", "does", "did", "have", "has", "had", "into", "when", "which", "who",
  "what", "where", "while", "such", "also", "more", "most", "other", "some", "any", "each",
  "between", "because", "so", "only", "very", "much", "many", "one", "two", "how", "there",
]);

export function isStopword(w: string): boolean {
  return STOPWORDS.has(w.toLowerCase());
}

export function contentWords(s: string): string[] {
  return normText(s)
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !isStopword(w));
}

/** Jaccard similarity over content words. */
export function wordSimilarity(a: string, b: string): number {
  const sa = new Set(contentWords(a));
  const sb = new Set(contentWords(b));
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** Levenshtein distance with early size cut. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 12) return Math.max(a.length, b.length);
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  const cur = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

export function similarityRatio(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}

export function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/** Strip a leading article from a phrase ("the water cycle" -> "water cycle"). */
export function stripArticle(s: string): string {
  return s.replace(/^(the|a|an)\s+/i, "");
}

/** Get the correct answer text of a question (server-side only). */
export function correctAnswerText(q: Question): string {
  switch (q.type) {
    case "mcq":
      return q.options.find((o) => o.id === q.correctOptionId)?.text ?? "";
    case "truefalse":
      return q.correctAnswer ? "True" : "False";
    case "short":
      return q.modelAnswer;
    case "explanation":
      return q.modelAnswer;
  }
}

export function answerSummary(answer: AnswerValue): string {
  switch (answer.type) {
    case "option":
      return answer.optionId;
    case "boolean":
      return answer.value ? "True" : "False";
    case "text":
      return answer.text;
  }
}

export function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function isAlphaRatio(s: string): number {
  const letters = s.replace(/[^a-zA-Z]/g, "").length;
  return s.length === 0 ? 0 : letters / s.length;
}

/**
 * Detects whether a learner-facing short question prompt visibly contains any of its accepted or model answers.
 * Uses token-bounded, case-insensitive normalization to prevent answer leakage while avoiding false positives
 * on substrings of unrelated words.
 */
export function promptContainsAcceptedShortAnswer(
  prompt: string,
  acceptedAnswers: string[],
  modelAnswer?: string,
): boolean {
  const normP = normText(prompt);
  if (!normP) return false;

  const candidates = new Set<string>();
  const addCandidate = (raw: string | undefined) => {
    if (!raw) return;
    const trimmed = raw.trim();
    if (trimmed.length > 0) candidates.add(trimmed);
    const stripped = stripArticle(trimmed);
    if (stripped.length > 0) candidates.add(stripped);
    const cleaned = normAnswer(raw);
    if (cleaned.length > 0) candidates.add(cleaned);
  };

  if (modelAnswer) addCandidate(modelAnswer);
  for (const a of acceptedAnswers) {
    addCandidate(a);
  }

  const wordChar = /[a-z0-9]/i;

  for (const cand of candidates) {
    const normCand = normText(cand);
    // Skip terms that are too short to safely check without false-positives (< 2 characters)
    if (normCand.length < 2) continue;

    let idx = normP.indexOf(normCand);
    while (idx !== -1) {
      const before = idx === 0 ? "" : normP[idx - 1];
      const end = idx + normCand.length;
      const after = end >= normP.length ? "" : normP[end];

      const startBounded = !wordChar.test(normCand[0]) || !before || !wordChar.test(before);
      const endBounded = !wordChar.test(normCand[normCand.length - 1]) || !after || !wordChar.test(after);

      if (startBounded && endBounded) {
        return true;
      }
      idx = normP.indexOf(normCand, idx + 1);
    }
  }

  return false;
}

