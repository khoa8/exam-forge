import { describe, expect, it, vi } from "vitest";
import { HostedDb, type CourseState, type SessionRow } from "@/lib/hosted-db";
import { HostedService } from "@/lib/hosted-service";
import type { Question } from "@/lib/types";

const now = "2026-09-24T00:00:00.000Z";
const question: Question = {
  id: "q1", conceptId: "c1", conceptName: "Synthetic concept", type: "mcq",
  prompt: "Which synthetic option is correct?", options: [{ id: "o1", text: "First" }, { id: "o2", text: "Second" }],
  correctOptionId: "o1", explanation: "The synthetic evidence supports the first option.",
  evidence: [{ quote: "Synthetic evidence supports the first option." }], difficulty: "easy", generator: "test",
};
const otherQuestion: Question = { ...question, id: "q2", conceptId: "c2", conceptName: "Other concept" };
const diagnostic: SessionRow = {
  id: "diagnostic", courseId: "course", kind: "diagnostic", conceptId: null,
  questionIds: ["q1"], status: "completed", createdAt: now, completedAt: now,
};
const mock: SessionRow = {
  id: "mock", courseId: "course", kind: "mock", conceptId: null,
  questionIds: ["q1"], status: "active", createdAt: now, completedAt: null,
};
const saved = {
  id: 1, sessionId: "diagnostic", questionId: "q1", conceptId: "c1", score: 1,
  correct: true, answerJson: JSON.stringify({ type: "option", optionId: "o1" }), createdAt: now,
};
const protectedState: CourseState = { sessions: [mock, diagnostic], attempts: [saved] };
const releasedState: CourseState = { sessions: [{ ...mock, status: "completed", completedAt: now }, diagnostic], attempts: [saved] };

function fakeDb(state: CourseState) {
  const db = {
    getCourse: vi.fn(async () => ({
      id: "course", title: "Synthetic", sourceType: "bundled", materialText: "Synthetic material",
      qualityJson: JSON.stringify({ level: "good", notes: [] }), createdAt: now,
    })),
    getConcepts: vi.fn(async () => [
      { id: "c1", name: "Synthetic concept", description: "Synthetic concept", evidenceJson: "[]", importance: 0.5 },
      { id: "c2", name: "Other concept", description: "Other concept", evidenceJson: "[]", importance: 0.5 },
    ]),
    getQuestions: vi.fn(async () => [question, otherQuestion].map((q) => ({ id: q.id, conceptId: q.conceptId, payloadJson: JSON.stringify(q) }))),
    getSession: vi.fn(async () => diagnostic),
    getCourseState: vi.fn(async () => state),
    getEligibleCourseAttempts: HostedDb.prototype.getEligibleCourseAttempts,
    listSessions: vi.fn(() => { throw new Error("independent session read would mix snapshots"); }),
    getSessionAttempts: vi.fn(() => { throw new Error("independent attempt read would mix snapshots"); }),
    insertSession: vi.fn(async () => {}),
    getAttempt: vi.fn(async () => null),
    insertAttempt: vi.fn(async () => true),
  };
  return { db, service: new HostedService(db as unknown as HostedDb) };
}

describe("hosted active mock snapshot", () => {
  it("uses one protection state for overview signals, session metadata and practice targeting", async () => {
    const { db, service } = fakeDb(protectedState);
    const overview = await service.getCourseOverview("course");
    expect(overview.activeMockSession?.id).toBe("mock");
    expect(overview.concepts.find((c) => c.id === "c1")?.mastery.attempts).toBe(0);
    expect(overview.readiness.concepts.find((c) => c.conceptId === "c1")?.status).toBe("untested");
    expect(db.getCourseState).toHaveBeenCalledTimes(1);
    const practice = await service.startSession("course", "practice");
    expect(practice.conceptId).toBe("c1");
    expect(db.listSessions).not.toHaveBeenCalled();
  });

  it("withholds completed diagnostic feedback from the same snapshot and restores it after mock submission", async () => {
    const { db, service } = fakeDb(protectedState);
    const withheld = await service.getSessionView("diagnostic");
    expect(withheld.withheldQuestionIds).toContain("q1");
    expect(withheld.revealed.q1).toBeUndefined();
    expect(withheld.summary).toBeNull();
    expect(db.getCourseState).toHaveBeenCalledTimes(1);
    db.getCourseState.mockResolvedValue(releasedState);
    const restored = await service.getSessionView("diagnostic");
    expect(restored.withheldQuestionIds).toEqual([]);
    expect(restored.revealed.q1.correct).toBe(true);
    expect(restored.summary?.correct).toBe(1);
  });
});
