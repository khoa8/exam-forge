import { describe, expect, it, vi } from "vitest";
import { HostedService, HostedInvalidAnswerError } from "@/lib/hosted-service";
import { HostedDb } from "@/lib/hosted-db";
import { hostedSubmitAnswerBodySchema } from "@/lib/schemas";

describe("hosted persisted answer boundary", () => {
  it("rejects oversize, extra-field and malformed answers before persistence", async () => {
    for (const answer of [
      { type: "text", text: "x".repeat(2001) },
      { type: "option", optionId: "x".repeat(65) },
      { type: "option", optionId: "o1", padding: "x".repeat(10000) },
    ]) {
      expect(hostedSubmitAnswerBodySchema.safeParse({ questionId: "q1", answer }).success).toBe(false);
    }
    const db = {
      getSession: vi.fn(async () => ({
        id: "session", courseId: "course", kind: "diagnostic", conceptId: null,
        questionIds: ["q1"], status: "active", createdAt: "2026-09-24T00:00:00.000Z", completedAt: null,
      })),
      getCourseState: vi.fn(async () => ({
        sessions: [{ id: "session", courseId: "course", kind: "diagnostic", conceptId: null,
          questionIds: ["q1"], status: "active", createdAt: "2026-09-24T00:00:00.000Z", completedAt: null }],
        attempts: [],
      })),
      getQuestions: vi.fn(async () => [{ id: "q1", conceptId: "c1", payloadJson: JSON.stringify({
        id: "q1", type: "mcq", options: [{ id: "o1", text: "First" }, { id: "o2", text: "Second" }],
        correctOptionId: "o1",
      }) }]),
      insertAttempt: vi.fn(async () => true),
    };
    const service = new HostedService(db as unknown as HostedDb);
    await expect(service.answerQuestion("session", "q1", { type: "text", text: "x".repeat(2000) }))
      .rejects.toBeInstanceOf(HostedInvalidAnswerError);
    await expect(service.answerQuestion("session", "q1", { type: "option", optionId: "unknown" }))
      .rejects.toBeInstanceOf(HostedInvalidAnswerError);
    expect(db.insertAttempt).not.toHaveBeenCalled();
  });
});
