import type { ClientQuestion, Question, SessionKind, SessionSummary } from "./types.ts";
import { isShortAnswerEquivalentToConcept } from "./grade.ts";

export function summarize(
  session: { id: string; kind: string; courseId: string },
  questions: Question[],
  attempts: { questionId: string; conceptId: string; score: number; correct: boolean }[],
): SessionSummary {
  const perConceptMap = new Map<string, { conceptId: string; conceptName: string; correct: number; attempts: number }>();
  for (const q of questions) {
    const entry = perConceptMap.get(q.conceptId) ?? {
      conceptId: q.conceptId,
      conceptName: q.conceptName,
      correct: 0,
      attempts: 0,
    };
    entry.attempts++;
    const at = attempts.find((a) => a.questionId === q.id);
    if (at && at.correct) entry.correct++;
    perConceptMap.set(q.conceptId, entry);
  }
  const answered = attempts.filter((a) => questions.some((q) => q.id === a.questionId));
  return {
    sessionId: session.id,
    kind: session.kind as SessionKind,
    courseId: session.courseId,
    status: "completed",
    totalQuestions: questions.length,
    answered: answered.length,
    correct: answered.filter((a) => a.correct).length,
    score: answered.length > 0 ? answered.reduce((s, a) => s + a.score, 0) / questions.length : 0,
    perConcept: Array.from(perConceptMap.values()),
  };
}

export interface QuestionPresentationContext {
  sessionKind: SessionKind;
  sessionStatus: "active" | "completed";
  isAnswered: boolean;
  /** True while an active mock exam in this course protects the question's answer key. */
  answerProtected: boolean;
}

/**
 * Determine whether a question's topic/concept name is safe to disclose to the client.
 * Fail-closed: answer-equivalent term-recall questions are withheld until safe, and an
 * active mock exam's answer-key protection always wins.
 */
export function isConceptNameSafe(q: Question, context: QuestionPresentationContext): boolean {
  if (context.answerProtected) {
    return false;
  }
  if (!isShortAnswerEquivalentToConcept(q, q.conceptName)) {
    return true;
  }
  if (context.sessionStatus === "completed") {
    return true;
  }
  if (context.sessionKind === "mock") {
    return false;
  }
  return context.isAnswered;
}

/**
 * Strip the answer key before sending a question to the client.
 * Topic context disclosure is fail-closed and strictly computed from session context.
 */
export function clientQuestion(q: Question, context: QuestionPresentationContext): ClientQuestion {
  const safeTopic = isConceptNameSafe(q, context);
  return {
    id: q.id,
    ...(safeTopic && q.conceptName ? { conceptName: q.conceptName } : {}),
    prompt: q.prompt,
    difficulty: q.difficulty,
    type: q.type,
    ...(q.type === "mcq" ? { options: q.options } : {}),
    ...(q.type === "truefalse" ? { statement: q.statement } : {}),
  };
}
