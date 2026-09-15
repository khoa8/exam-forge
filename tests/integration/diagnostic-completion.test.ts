import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setDbPathForTests, db } from "@/lib/db";
import {
  createCourse,
  startSession,
  getSessionView,
  answerQuestion,
  finishSession,
  getCourseOverview,
  ConflictError,
} from "@/lib/service";
import { SAMPLE_MATERIAL } from "@/sample/material";
import { ingestText } from "@/lib/ingest";

let tmpDir: string;
let dbFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "examforge-diag-complete-"));
  dbFile = path.join(tmpDir, "test.sqlite");
  setDbPathForTests(dbFile);
});

afterEach(() => {
  setDbPathForTests(path.join(os.tmpdir(), `examforge-diag-reset-${Date.now()}.sqlite`));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("diagnostic completion invariant (service layer)", () => {
  it("rejects completing an active diagnostic when questions remain unanswered and preserves active state", async () => {
    const ingested = ingestText(SAMPLE_MATERIAL);
    const { courseId } = await createCourse({
      text: ingested.text,
      sourceType: "bundled",
      ingestionWarnings: ingested.warnings,
    });

    const session = startSession(courseId, "diagnostic");
    expect(session.status).toBe("active");
    expect(session.completedAt).toBeNull();
    expect(session.questionIds.length).toBeGreaterThan(1);

    const initialView = getSessionView(session.id);
    expect(initialView.answeredCount).toBe(0);

    // 1. Attempt to finish with zero questions answered.
    expect(() => finishSession(session.id)).toThrow(ConflictError);
    expect(() => finishSession(session.id)).toThrow(/answer all diagnostic questions before finishing/i);

    // Assert session state remains untouched.
    let currentSession = db.getSession(session.id)!;
    expect(currentSession.status).toBe("active");
    expect(currentSession.completedAt).toBeNull();

    // 2. Answer a subset (only the first question).
    const q1 = initialView.questions[0];
    answerQuestion(session.id, q1.id, { type: "text", text: "memory" });

    const partialAttempts = db.getSessionAttempts(session.id);
    expect(partialAttempts).toHaveLength(1);

    // 3. Attempt to finish with partial answers.
    expect(() => finishSession(session.id)).toThrow(ConflictError);
    expect(() => finishSession(session.id)).toThrow(/answer all diagnostic questions before finishing/i);

    // Assert session state is still active, completedAt is still null, and attempt count is unchanged.
    currentSession = db.getSession(session.id)!;
    expect(currentSession.status).toBe("active");
    expect(currentSession.completedAt).toBeNull();
    expect(db.getSessionAttempts(session.id)).toHaveLength(1);

    // 4. Adaptive flow verification: course overview and readiness must NOT treat diagnostic as complete.
    const overview = getCourseOverview(courseId);
    const overviewSession = overview.sessions.find((s) => s.id === session.id)!;
    expect(overviewSession.status).toBe("active");
    expect(overviewSession.completedAt).toBeNull();
    expect(overviewSession.answered).toBe(1);
    expect(overview.activeSession).toEqual({ id: session.id, kind: "diagnostic" });

    // Next action must remain diagnostic, never advancing to practice or mock prematurely.
    expect(overview.readiness.nextAction.kind).toBe("diagnostic");
    expect(overview.readiness.nextAction.message).toMatch(/take the diagnostic quiz/i);

    // 5. Answer all remaining questions.
    for (let i = 1; i < initialView.questions.length; i++) {
      const q = initialView.questions[i];
      answerQuestion(session.id, q.id, { type: "text", text: "memory" });
    }

    expect(db.getSessionAttempts(session.id)).toHaveLength(initialView.questions.length);

    // 6. Finishing now succeeds.
    const finishedView = finishSession(session.id);
    expect(finishedView.session.status).toBe("completed");
    expect(finishedView.session.completedAt).not.toBeNull();
    expect(finishedView.summary).not.toBeNull();

    const dbFinished = db.getSession(session.id)!;
    expect(dbFinished.status).toBe("completed");
    expect(dbFinished.completedAt).not.toBeNull();

    // 7. Course overview now reflects completed diagnostic and advances next study action.
    const postOverview = getCourseOverview(courseId);
    expect(postOverview.sessions.find((s) => s.id === session.id)!.status).toBe("completed");
    expect(postOverview.activeSession).toBeNull();
    expect(postOverview.readiness.nextAction.kind).toBe("practice");

    // 8. Idempotency: calling finishSession on already-completed diagnostic returns completed view without error.
    const repeatedFinish = finishSession(session.id);
    expect(repeatedFinish.session.status).toBe("completed");
    expect(repeatedFinish.session.completedAt).toBe(dbFinished.completedAt);
  });
});
