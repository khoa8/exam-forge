import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setDbPathForTests, db } from "@/lib/db";
import { createCourse, startSession, MaterialNotViableError } from "@/lib/service";
import { SAMPLE_MATERIAL } from "@/sample/material";
import { ingestText } from "@/lib/ingest";

/**
 * F-01 regression: course creation must reject material that cannot support the
 * core learning loop — assessment viability — BEFORE anything is persisted.
 *
 * The failure class is material whose grounded, extractable concepts yield
 * individually valid questions but either too few of them or none that the
 * Diagnostic sampler can actually draw (auto-gradable types only). A
 * representative case is heading concepts plus descriptive prose that mentions
 * each concept without ever giving it a definition structure.
 * All fixture text below is original, redistributable content.
 */

const FEWER_THAN_THREE = `# Estuary Field Notes

## Osmosis
Osmosis moves water across a semipermeable membrane toward the region of higher solute concentration.

## Turgor
Turgor pressure keeps soft plant stems firm and upright while the plant stays hydrated.`;

const NO_DIAGNOSTIC_POOL = `# Plant Water Notes

## Osmosis
Osmosis moves water across a semipermeable membrane toward the region of higher solute concentration.

## Turgor
Turgor pressure keeps soft plant stems firm and upright while the plant stays hydrated.

## Wilting
Wilting begins when water loss outpaces root uptake and cells lose their rigidity.

## Xylem
Xylem conduits lift water from the roots to the leaves through transpiration pull.`;

const PASTE_DEFINITIONS = `Plant energy notes.
Photosynthesis is the process by which plants convert light energy into chemical energy.
Chlorophyll is the green pigment that absorbs light in plant leaves.
Cellular respiration is the process by which cells release energy stored in glucose.
The Calvin cycle is the set of chemical reactions that fix carbon dioxide into glucose.
Stomata are small pores on the underside of leaves that exchange gases.
Transpiration is the movement of water through a plant and its evaporation from leaves.`;

let tmpDir: string;
let dbFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "examforge-test-"));
  dbFile = path.join(tmpDir, "test.sqlite");
  setDbPathForTests(dbFile);
});

afterEach(() => {
  setDbPathForTests(path.join(os.tmpdir(), `examforge-reset-${Date.now()}.sqlite`));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("assessment viability gate before course persistence", () => {
  async function attemptCreate(text: string): Promise<unknown> {
    const ingested = ingestText(text);
    return createCourse({ text: ingested.text, sourceType: "paste", ingestionWarnings: ingested.warnings }).then(
      () => null,
      (err) => err,
    );
  }

  it("rejects grounded material that yields fewer than three validated questions, persisting nothing", async () => {
    const err = await attemptCreate(FEWER_THAN_THREE);
    expect(err).toBeInstanceOf(MaterialNotViableError);
    expect((err as Error).message).toMatch(/enough grounded assessment structure/);
    expect((err as Error).message).toMatch(/at least 3/);

    // No course (and therefore no derived concept/question/learner state) exists.
    expect(db.listCourses()).toHaveLength(0);
  });

  it("rejects material whose accepted questions leave no Diagnostic-eligible pool, persisting nothing", async () => {
    // Grounded concepts are extracted and four individually valid explanation
    // questions are accepted — yet the diagnostic sampler (auto-gradable types
    // only) would find nothing to ask. Creation must fail before persistence.
    const err = await attemptCreate(NO_DIAGNOSTIC_POOL);
    expect(err).toBeInstanceOf(MaterialNotViableError);
    expect((err as Error).message).toMatch(/enough grounded assessment structure/);
    expect((err as Error).message).toMatch(/Diagnostic/);

    expect(db.listCourses()).toHaveLength(0);
  });

  it("still creates the bundled demo course, and its Diagnostic can actually start", async () => {
    const ingested = ingestText(SAMPLE_MATERIAL);
    const { courseId, questionCount } = await createCourse({
      text: ingested.text,
      sourceType: "bundled",
      ingestionWarnings: ingested.warnings,
    });
    expect(questionCount).toBeGreaterThanOrEqual(3);
    expect(db.listCourses()).toHaveLength(1);

    const session = startSession(courseId, "diagnostic");
    expect(session.questionIds.length).toBeGreaterThan(0);
  });

  it("still accepts valid pasted material with definition statements (paste path)", async () => {
    const ingested = ingestText(PASTE_DEFINITIONS);
    const { courseId, conceptCount, questionCount } = await createCourse({
      text: ingested.text,
      sourceType: "paste",
      ingestionWarnings: ingested.warnings,
    });
    expect(conceptCount).toBeGreaterThanOrEqual(3);
    expect(questionCount).toBeGreaterThanOrEqual(3);

    const session = startSession(courseId, "diagnostic");
    expect(session.questionIds.length).toBeGreaterThan(0);
  });

  it("rejects sufficiently long material with no extractable concepts as MaterialNotViableError, persisting nothing", async () => {
    const unstructured =
      "This is an ordinary story about a quiet day in the countryside. The sun was warm and the breeze was pleasant. " +
      "We took a long walk down the path until we reached the old stone bridge near the river bank.";
    const err = await attemptCreate(unstructured);
    expect(err).toBeInstanceOf(MaterialNotViableError);
    expect((err as Error).message).toMatch(/Could not identify any concepts/i);
    expect(db.listCourses()).toHaveLength(0);
  });
});
