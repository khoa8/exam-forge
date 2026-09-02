import type { Concept, McqOption, Question } from "./types";
import { contentWords, lightStem, normText, randomId, seededRandom, wordSimilarity } from "./util";

/**
 * Deterministic, key-free question generation from source text and extracted concepts.
 *
 * Every question is derived from sentences that appear in the material and carries
 * the grounding quote. Nothing is invented: wrong options in MCQs reuse definition
 * clauses of *other* concepts from the same material, and false statements in
 * true/false questions are built by swapping another concept into this concept's
 * definition (a discrimination exercise) rather than fabricating new claims.
 */

const GENERATOR = "demo:deterministic";

interface DefinitionInfo {
  sentence: string;
  subject: string;
  clause: string;
}

function findDefinitionSentence(text: string, concept: Concept): DefinitionInfo | null {
  const normSource = normText(text);
  const sentences = text
    .replace(/\r\n?/g, "\n")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12);

  const normName = normText(concept.name);
  const normNameNoArticle = normName.replace(/^(the|a|an)\s+/, "");

  for (const sentence of sentences) {
    const n = normText(sentence);
    if (!(n.includes(normName) || n.includes(normNameNoArticle))) continue;
    const m =
      /^(.{0,80}?)\s+(?:is|are)\s+(?:defined\s+as|known\s+as|referred\s+to\s+as|considered|essentially|simply|basically)?\s*(?:the\s+|a\s+|an\s+)?(?=\S)/.exec(
        sentence,
      );
    if (!m) continue;
    const subject = m[1].trim().replace(/^(the|a|an)\s+/i, "");
    if (normText(subject) !== normName && normText(subject) !== normNameNoArticle) continue;
    const rest = sentence.slice(m[0].length).trim();
    if (rest.length < 12) continue;
    let clause = rest.replace(/\s*[,;]\s*[^,;]*$/, "").trim();
    if (clause.length < 12) clause = rest;
    if (clause.length > 160) clause = clause.slice(0, clause.lastIndexOf(" ", 155)) + "…";
    if (!normSource.includes(normText(sentence))) continue; // must be grounded verbatim
    return { sentence, subject, clause };
  }
  return null;
}

function keySentenceFor(text: string, concept: Concept): string | null {
  const normName = normText(concept.name);
  const normNameNoArticle = normName.replace(/^(the|a|an)\s+/, "");
  const sentences = text
    .replace(/\r\n?/g, "\n")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12);
  for (const sentence of sentences) {
    const n = normText(sentence);
    if (n.includes(normName) || n.includes(normNameNoArticle)) return sentence;
  }
  return null;
}

function buildMcq(
  concept: Concept,
  def: DefinitionInfo,
  otherDefs: { concept: Concept; def: DefinitionInfo }[],
  seed: string,
): Question | null {
  if (otherDefs.length < 2) return null;

  const scored = otherDefs
    .map((o) => ({ ...o, sim: wordSimilarity(def.clause, o.def.clause) }))
    .filter((o) => o.sim < 0.72 && o.sim > 0.02)
    .sort((a, b) => b.sim - a.sim);

  // Prefer plausible-but-clearly-different distractors; diversify them.
  const pickedDistractors: typeof scored = [];
  for (const cand of scored) {
    if (pickedDistractors.length >= 3) break;
    if (pickedDistractors.some((p) => wordSimilarity(p.def.clause, cand.def.clause) > 0.8)) continue;
    pickedDistractors.push(cand);
  }
  if (pickedDistractors.length < 2) return null;

  const optionTexts = [def.clause, ...pickedDistractors.map((p) => p.def.clause)];
  const rand = seededRandom(seed);
  const optionOrder = optionTexts
    .map((text, i) => ({ text, i }))
    .map((v) => ({ v, k: rand() }))
    .sort((a, b) => a.k - b.k)
    .map(({ v }) => v);

  const options: McqOption[] = optionOrder.map((o, idx) => ({ id: `o${idx + 1}`, text: o.text }));
  const correct = options.find((o) => o.text === def.clause)!;

  const confusedWith = pickedDistractors.map((p) => p.concept.name).join(" or ");
  return {
    id: `q_${randomId()}`,
    conceptId: concept.id,
    conceptName: concept.name,
    type: "mcq",
    prompt: `According to the material, what is ${concept.name}?`,
    options,
    correctOptionId: correct.id,
    explanation:
      `${def.clause.endsWith("…") ? "The material defines " + concept.name + " as: " : "The material states: "}"${def.sentence}" ` +
      `The other options describe ${confusedWith}, which the material presents as distinct topics.`,
    evidence: [{ quote: def.sentence }],
    difficulty: "easy",
    generator: GENERATOR,
  };
}

function buildTrueFalse(
  concept: Concept,
  def: DefinitionInfo | null,
  otherDefs: { concept: Concept; def: DefinitionInfo }[],
  keySentence: string | null,
  seed: string,
): Question | null {
  const rand = seededRandom(seed + ":tf");
  const swapCandidate = otherDefs[Math.floor(rand() * otherDefs.length)] ?? otherDefs[0];

  if (def && swapCandidate && rand() < 0.6) {
    // False statement: another concept's definition attributed to this concept.
    const other = swapCandidate;
    const replaced = swapSubject(other.def.sentence, other.def.subject, concept.name);
    if (replaced) {
      return {
        id: `q_${randomId()}`,
        conceptId: concept.id,
        conceptName: concept.name,
        type: "truefalse",
        statement: replaced,
        correctAnswer: false,
        prompt: "According to the material, is this statement true or false?",
        explanation: `This statement actually describes ${other.concept.name}, not ${concept.name}. The material states: "${def.sentence}"`,
        evidence: [{ quote: def.sentence }],
        difficulty: "medium",
        generator: GENERATOR,
      };
    }
  }

  if (def) {
    // True statement: the definition, quoted as-is.
    return {
      id: `q_${randomId()}`,
      conceptId: concept.id,
      conceptName: concept.name,
      type: "truefalse",
      statement: def.sentence,
      correctAnswer: true,
      prompt: "According to the material, is this statement true or false?",
      explanation: `The material states: "${def.sentence}"`,
      evidence: [{ quote: def.sentence }],
      difficulty: "easy",
      generator: GENERATOR,
    };
  }
  return null;
}

function swapSubject(sentence: string, from: string, to: string): string | null {
  // Prefer replacing "The spacing effect" as a whole (avoids "The Storage").
  const escapedFrom = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    `\\b(?:the|a|an)\\s+${escapedFrom}\\b`,
    `\\b${escapedFrom}\\b`,
  ];
  for (const p of patterns) {
    const re = new RegExp(p, "i");
    if (re.test(sentence)) {
      return sentence.replace(re, to);
    }
  }
  return null;
}

function buildShort(concept: Concept, def: DefinitionInfo): Question {
  const blanked = swapSubject(def.sentence, def.subject, "______") ?? def.sentence;
  const accepted = Array.from(new Set([def.subject, def.subject.replace(/^(the|a|an)\s+/i, "")]));
  return {
    id: `q_${randomId()}`,
    conceptId: concept.id,
    conceptName: concept.name,
    type: "short",
    prompt: `Fill in the blank according to the material:\n\n"${blanked}"\n\nWhich term does the blank represent?`,
    modelAnswer: def.subject,
    acceptedAnswers: accepted,
    explanation: `The blank refers to ${def.subject}. The material states: "${def.sentence}"`,
    evidence: [{ quote: def.sentence }],
    difficulty: "medium",
    generator: GENERATOR,
  };
}

function buildExplanation(concept: Concept, def: DefinitionInfo | null, keySentence: string | null): Question | null {
  const source = def?.sentence ?? keySentence;
  if (!source) return null;
  const subjectWords = new Set(contentWords(concept.name).map(lightStem));
  const terms: string[] = [];
  for (const w of contentWords(source).map(lightStem)) {
    if (subjectWords.has(w)) continue;
    if (!terms.includes(w)) terms.push(w);
    if (terms.length >= 6) break;
  }
  if (terms.length < 2) return null;
  return {
    id: `q_${randomId()}`,
    conceptId: concept.id,
    conceptName: concept.name,
    type: "explanation",
    prompt: `In your own words, explain what ${concept.name} is, according to the material. Your answer will be checked for coverage of the key ideas from the source.`,
    modelAnswer: source,
    keyTerms: terms,
    explanation: `A strong answer, grounded in the material, is: "${source}" Key ideas to cover: ${terms.join(", ")}.`,
    evidence: [{ quote: source }],
    difficulty: "hard",
    generator: GENERATOR,
  };
}

export interface GenerationOutput {
  questions: Question[];
  dropped: { reason: string; count: number }[];
}

export function generateQuestions(text: string, concepts: Concept[], seed: string): GenerationOutput {
  const defs = new Map<string, DefinitionInfo | null>();
  const keySentences = new Map<string, string | null>();
  for (const c of concepts) {
    defs.set(c.id, findDefinitionSentence(text, c));
    keySentences.set(c.id, keySentenceFor(text, c));
  }

  const questions: Question[] = [];
  const dropped: { reason: string; count: number }[] = [];
  const drop = (reason: string) => {
    const existing = dropped.find((d) => d.reason === reason);
    if (existing) existing.count++;
    else dropped.push({ reason, count: 1 });
  };

  concepts.forEach((concept) => {
    const def = defs.get(concept.id) ?? null;
    const otherDefs = concepts
      .filter((c) => c.id !== concept.id && defs.get(c.id))
      .map((c) => ({ concept: c, def: defs.get(c.id)! }));

    const mcq = def ? buildMcq(concept, def, otherDefs, `${seed}:${concept.id}:mcq`) : null;
    if (mcq) questions.push(mcq);
    else drop(def ? "MCQ dropped: not enough distinct definition distractors" : "MCQ skipped: no definition sentence");

    const tf = buildTrueFalse(concept, def, otherDefs, keySentences.get(concept.id) ?? null, `${seed}:${concept.id}:tf`);
    if (tf) questions.push(tf);
    else drop("True/false skipped: no grounded key sentence");

    if (def) questions.push(buildShort(concept, def));

    const expl = buildExplanation(concept, def, keySentences.get(concept.id) ?? null);
    if (expl) questions.push(expl);
    else drop("Explanation skipped: not enough key terms");
  });

  return { questions, dropped };
}
