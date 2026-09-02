import type { AnswerValue, GradeResult, Question } from "./types";
import { answerSummary, normAnswer, lightStem, similarityRatio } from "./util";

/**
 * Deterministic grading engine. The same answer always receives the same result.
 */

const COVERAGE_PASS_THRESHOLD = 0.6;

export function gradeAnswer(question: Question, answer: AnswerValue): GradeResult {
  switch (question.type) {
    case "mcq":
      return gradeMcq(question, answer);
    case "truefalse":
      return gradeTrueFalse(question, answer);
    case "short":
      return gradeShort(question, answer);
    case "explanation":
      return gradeExplanation(question, answer);
  }
}

function baseResult(question: Question): GradeResult {
  return {
    correct: false,
    score: 0,
    feedback: "",
    modelAnswer: correctModelAnswer(question),
    evidence: question.evidence,
  };
}

export function correctModelAnswer(question: Question): string {
  switch (question.type) {
    case "mcq":
      return question.options.find((o) => o.id === question.correctOptionId)?.text ?? "";
    case "truefalse":
      return question.correctAnswer ? "True" : "False";
    case "short":
    case "explanation":
      return question.modelAnswer;
  }
}

function gradeMcq(question: Extract<Question, { type: "mcq" }>, answer: AnswerValue): GradeResult {
  const result = baseResult(question);
  if (answer.type !== "option") {
    result.feedback = "This question expects you to pick one of the options.";
    return result;
  }
  const chosen = question.options.find((o) => o.id === answer.optionId);
  if (!chosen) {
    result.feedback = "The selected option is not one of the available choices.";
    return result;
  }
  const correct = answer.optionId === question.correctOptionId;
  result.correct = correct;
  result.score = correct ? 1 : 0;
  if (correct) {
    result.feedback = `Correct. ${question.explanation}`;
  } else {
    result.feedback = `Not quite — you chose "${chosen.text}". ${question.explanation}`;
  }
  return result;
}

function gradeTrueFalse(
  question: Extract<Question, { type: "truefalse" }>,
  answer: AnswerValue,
): GradeResult {
  const result = baseResult(question);
  if (answer.type !== "boolean") {
    result.feedback = "This question expects a true/false answer.";
    return result;
  }
  const correct = answer.value === question.correctAnswer;
  result.correct = correct;
  result.score = correct ? 1 : 0;
  result.feedback = correct
    ? `Correct. ${question.explanation}`
    : `Incorrect. You answered "${answer.value ? "True" : "False"}". ${question.explanation}`;
  return result;
}

function gradeShort(question: Extract<Question, { type: "short" }>, answer: AnswerValue): GradeResult {
  const result = baseResult(question);
  if (answer.type !== "text") {
    result.feedback = "This question expects a typed answer.";
    return result;
  }
  const given = normAnswer(answer.text);
  if (given.length === 0) {
    result.feedback = "You did not type an answer.";
    return result;
  }
  let best = 0;
  for (const accepted of question.acceptedAnswers) {
    const norm = normAnswer(accepted);
    best = Math.max(best, similarityRatio(given, norm));
    if (given === norm) best = 1;
  }
  const correct = best >= 0.9;
  result.correct = correct;
  result.score = correct ? 1 : best >= 0.75 ? 0.5 : 0;
  result.feedback = correct
    ? `Correct — "${answer.text.trim()}" matches the term from the material. ${question.explanation}`
    : result.score > 0
      ? `Close, but not the exact term. The expected answer is "${question.modelAnswer}". ${question.explanation}`
      : `Incorrect. The expected answer is "${question.modelAnswer}". ${question.explanation}`;
  return result;
}

function gradeExplanation(
  question: Extract<Question, { type: "explanation" }>,
  answer: AnswerValue,
): GradeResult {
  const result = baseResult(question);
  if (answer.type !== "text") {
    result.feedback = "This question expects a written explanation.";
    return result;
  }
  const given = normAnswer(answer.text);
  if (given.length < 10) {
    result.feedback = "Your answer is too short to cover the key ideas. " + question.explanation;
    return result;
  }

  const covered: string[] = [];
  const missed: string[] = [];
  for (const term of question.keyTerms) {
    const stem = lightStem(term);
    const hit =
      given.includes(stem) ||
      normAnswer(answer.text)
        .split(/\s+/)
        .some((w) => lightStem(w) === stem || similarityRatio(lightStem(w), stem) >= 0.85);
    if (hit) covered.push(term);
    else missed.push(term);
  }
  const coverage = covered.length / question.keyTerms.length;
  const correct = coverage >= COVERAGE_PASS_THRESHOLD;
  result.correct = correct;
  result.score = Math.min(1, coverage);
  result.keyTermsCovered = covered;
  result.keyTermsMissed = missed;
  result.feedback = correct
    ? `Good — your explanation covers ${covered.length}/${question.keyTerms.length} key ideas from the source. ${missed.length > 0 ? `Also worth including: ${missed.join(", ")}. ` : ""}${question.explanation}`
    : `Your explanation covers only ${covered.length}/${question.keyTerms.length} key ideas from the source${missed.length > 0 ? ` (missing: ${missed.join(", ")})` : ""}. Model answer: "${question.modelAnswer}"`;
  return result;
}

export function answerLabel(question: Question, answer: AnswerValue | null): string {
  if (!answer) return "—";
  switch (answer.type) {
    case "option":
      return question.type === "mcq"
        ? (question.options.find((o) => o.id === answer.optionId)?.text ?? answer.optionId)
        : answer.optionId;
    case "boolean":
      return answer.value ? "True" : "False";
    case "text":
      return answer.text;
  }
}

export { answerSummary };
