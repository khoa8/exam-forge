/**
 * ExamForge core domain types.
 * These types are the contract between generation, grading, persistence and UI.
 */

export type QuestionType = "mcq" | "truefalse" | "short" | "explanation";

export type SourceType = "bundled" | "paste" | "pdf";

/** A quote from the source material that grounds a concept or question. */
export interface Evidence {
  /** Exact (whitespace-normalized) substring of the source material. */
  quote: string;
  /** Heading of the section the quote came from, when known. */
  section?: string;
  /** Approximate character offset of the quote in the source text. */
  offset?: number;
}

export interface Concept {
  id: string;
  name: string;
  /** Description derived from the source material (never fabricated). */
  description: string;
  evidence: Evidence[];
  /** Heuristic salience of the concept in the material, 0..1. */
  importance: number;
}

export interface McqOption {
  id: string;
  text: string;
}

interface QuestionBase {
  id: string;
  conceptId: string;
  conceptName: string;
  prompt: string;
  /** Why the correct answer is correct; grounded in the source. */
  explanation: string;
  evidence: Evidence[];
  difficulty: "easy" | "medium" | "hard";
  generator: string;
}

export interface McqQuestion extends QuestionBase {
  type: "mcq";
  options: McqOption[];
  correctOptionId: string;
}

export interface TrueFalseQuestion extends QuestionBase {
  type: "truefalse";
  statement: string;
  correctAnswer: boolean;
  /**
   * Deterministic proof for false-keyed statements: the statement was derived
   * from `sourceQuote` (a grounded, non-instruction source sentence) by replacing
   * `originalSubject` with the concept name. Required for false statements;
   * without it a false key cannot be verified and the question is rejected.
   */
  falseProof?: { sourceQuote: string; originalSubject: string };
}

export interface ShortQuestion extends QuestionBase {
  type: "short";
  modelAnswer: string;
  acceptedAnswers: string[];
}

export interface ExplanationQuestion extends QuestionBase {
  type: "explanation";
  modelAnswer: string;
  /** Key terms from the source used for deterministic coverage grading. */
  keyTerms: string[];
}

export type Question =
  | McqQuestion
  | TrueFalseQuestion
  | ShortQuestion
  | ExplanationQuestion;

export type AnswerValue =
  | { type: "option"; optionId: string }
  | { type: "boolean"; value: boolean }
  | { type: "text"; text: string };

export interface GradeResult {
  correct: boolean;
  /** 0..1 partial credit (full for mcq/tf; coverage for short/explanation). */
  score: number;
  /** Direct feedback: why the answer is right or wrong. */
  feedback: string;
  modelAnswer: string;
  evidence: Evidence[];
  keyTermsCovered?: string[];
  keyTermsMissed?: string[];
  /** Set when a wrong MCQ answer matches another concept's definition. */
  confusionWith?: string;
}

export interface ExtractionQuality {
  level: "good" | "fair" | "poor";
  notes: string[];
}

export interface Course {
  id: string;
  title: string;
  sourceType: SourceType;
  createdAt: string;
  textLength: number;
  quality: ExtractionQuality;
}

export type SessionKind = "diagnostic" | "practice" | "mock";

export interface Session {
  id: string;
  courseId: string;
  kind: SessionKind;
  /** Focus concept for practice sessions. */
  conceptId: string | null;
  questionIds: string[];
  status: "active" | "completed";
  createdAt: string;
  completedAt: string | null;
}

/** Question as exposed to the client: answer key and explanations removed. */
export type ClientQuestion = Pick<
  QuestionBase,
  "id" | "prompt" | "difficulty"
> & {
  type: QuestionType;
  conceptName?: string;
  options?: McqOption[];
  statement?: string;
};

export interface MasteryState {
  conceptId: string;
  attempts: number;
  correct: number;
  /** 0..1 smoothed, recency-weighted estimate of mastery. */
  mastery: number;
  /** 0..1 confidence in the mastery estimate (grows with evidence). */
  confidence: number;
  status: "untested" | "weak" | "developing" | "strong";
  recentCorrect: number;
  lastSeen: string | null;
  /** 0..1 higher = review sooner. */
  reviewPriority: number;
  /** Simple spaced-review hint, in days from now (null = nothing scheduled). */
  nextReviewInDays: number | null;
}

export interface ReadinessReport {
  /** 0..100 internal heuristic estimate. NOT a real exam score prediction. */
  readiness: number;
  overallConfidence: number;
  coverage: number;
  concepts: MasteryState[];
  weak: MasteryState[];
  strong: MasteryState[];
  untested: MasteryState[];
  nextAction: NextAction;
  disclaimer: string;
}

export interface NextAction {
  kind: "diagnostic" | "practice" | "mock" | "review" | "material";
  conceptId?: string;
  message: string;
  href: string;
}

export interface SessionReviewItem {
  question: Question;
  userAnswer: AnswerValue | null;
  result: GradeResult | null;
}

export interface SessionSummary {
  sessionId: string;
  kind: SessionKind;
  courseId: string;
  status: "active" | "completed";
  totalQuestions: number;
  answered: number;
  correct: number;
  /** 0..1. */
  score: number;
  perConcept: { conceptId: string; conceptName: string; correct: number; attempts: number }[];
}
