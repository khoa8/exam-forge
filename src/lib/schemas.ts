import { z } from "zod";

/**
 * Zod schemas for structured generated content.
 * All provider output (demo or LLM) must pass these validators before use.
 */

export const evidenceSchema = z.object({
  quote: z.string().min(8),
  section: z.string().optional(),
  offset: z.number().int().nonnegative().optional(),
});

export const conceptSchema = z.object({
  id: z.string().min(3),
  name: z.string().min(2).max(120),
  description: z.string().min(10),
  evidence: z.array(evidenceSchema).min(1),
  importance: z.number().min(0).max(1),
});

const questionBaseSchema = z.object({
  id: z.string().min(3),
  conceptId: z.string().min(1),
  conceptName: z.string().min(1),
  prompt: z.string().min(8),
  explanation: z.string().min(10),
  evidence: z.array(evidenceSchema).min(1),
  difficulty: z.enum(["easy", "medium", "hard"]),
  generator: z.string().min(1),
});

export const mcqQuestionSchema = questionBaseSchema.extend({
  type: z.literal("mcq"),
  options: z
    .array(z.object({ id: z.string().min(1), text: z.string().min(1) }))
    .min(2)
    .max(6),
  correctOptionId: z.string().min(1),
});

export const trueFalseQuestionSchema = questionBaseSchema.extend({
  type: z.literal("truefalse"),
  statement: z.string().min(8),
  correctAnswer: z.boolean(),
});

export const shortQuestionSchema = questionBaseSchema.extend({
  type: z.literal("short"),
  modelAnswer: z.string().min(1),
  acceptedAnswers: z.array(z.string().min(1)).min(1),
});

export const explanationQuestionSchema = questionBaseSchema.extend({
  type: z.literal("explanation"),
  modelAnswer: z.string().min(10),
  keyTerms: z.array(z.string().min(2)).min(2),
});

export const questionSchema = z.discriminatedUnion("type", [
  mcqQuestionSchema,
  trueFalseQuestionSchema,
  shortQuestionSchema,
  explanationQuestionSchema,
]);

export const conceptListSchema = z.object({ concepts: z.array(conceptSchema) });
export const questionListSchema = z.object({ questions: z.array(questionSchema) });

export const answerValueSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("option"), optionId: z.string() }),
  z.object({ type: z.literal("boolean"), value: z.boolean() }),
  z.object({ type: z.literal("text"), text: z.string() }),
]);

export function validateConcept(raw: unknown):
  { ok: true; concept: import("./types").Concept } | { ok: false; errors: string[] } {
  const parsed = conceptSchema.safeParse(raw);
  if (parsed.success) return { ok: true, concept: parsed.data as import("./types").Concept };
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
}

export function validateQuestion(raw: unknown):
  { ok: true; question: import("./types").Question } | { ok: false; errors: string[] } {
  const parsed = questionSchema.safeParse(raw);
  if (parsed.success) return { ok: true, question: parsed.data as import("./types").Question };
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
}
