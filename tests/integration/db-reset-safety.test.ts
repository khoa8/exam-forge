import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Regression coverage for the `db:reset` deletion boundary.
 *
 * The real `scripts/` tree is copied verbatim into a disposable project root, so the
 * destructive code path runs exactly as shipped while every fixture path stays inside a
 * temporary directory. This checkout and any developer data are never targeted.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPTS_SOURCE = path.join(REPO_ROOT, "scripts");

interface Fixture {
  /** Temporary parent holding the fake project and its siblings. */
  parent: string;
  /** Disposable "project root" that contains the copied scripts. */
  project: string;
}

const fixtures: string[] = [];

function makeFixture(): Fixture {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "examforge-reset-"));
  fixtures.push(parent);
  const project = path.join(parent, "exam-forge");
  fs.mkdirSync(project, { recursive: true });
  fs.cpSync(SCRIPTS_SOURCE, path.join(project, "scripts"), { recursive: true });
  return { parent, project };
}

/** Run the real reset script inside the fixture with a controlled environment. */
function runReset(
  fixture: Fixture,
  options: { dbPath?: string; cwd?: string } = {},
): { status: number | null; output: string } {
  const env = { ...process.env };
  delete env.EXAMFORGE_DB_PATH;
  if (options.dbPath !== undefined) env.EXAMFORGE_DB_PATH = options.dbPath;

  const result = spawnSync(process.execPath, [path.join(fixture.project, "scripts", "reset-db.mjs")], {
    cwd: options.cwd ?? fixture.project,
    env,
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function write(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

afterEach(() => {
  for (const dir of fixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("db:reset deletion boundary", () => {
  it("refuses a sibling directory whose path only starts with the project path", () => {
    const fixture = makeFixture();
    const sibling = path.join(fixture.parent, "exam-forge-backup");
    const sentinel = path.join(sibling, "learner-notes.txt");
    write(sentinel, "private learner data");

    const result = runReset(fixture, { dbPath: sibling });

    expect(result.status).toBe(1);
    expect(result.output).toMatch(/outside this project/i);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("private learner data");
  });

  it("refuses the project root itself", () => {
    const fixture = makeFixture();
    const marker = path.join(fixture.project, "important.txt");
    write(marker, "project file");

    for (const dbPath of [".", fixture.project, "./", path.join(fixture.project, ".data", "..")]) {
      const result = runReset(fixture, { dbPath });
      expect(result.status, `EXAMFORGE_DB_PATH=${dbPath}`).toBe(1);
      expect(result.output, `EXAMFORGE_DB_PATH=${dbPath}`).toMatch(/project root itself/i);
    }

    expect(fs.readFileSync(marker, "utf8")).toBe("project file");
    expect(fs.existsSync(path.join(fixture.project, "scripts", "reset-db.mjs"))).toBe(true);
  });

  it("refuses paths outside the project, including a parent traversal", () => {
    const fixture = makeFixture();
    const outside = path.join(fixture.parent, "elsewhere.sqlite");
    write(outside, "unrelated file");

    for (const dbPath of [outside, path.join("..", "elsewhere.sqlite"), path.join("..", "..")]) {
      const result = runReset(fixture, { dbPath });
      expect(result.status, `EXAMFORGE_DB_PATH=${dbPath}`).toBe(1);
      expect(result.output, `EXAMFORGE_DB_PATH=${dbPath}`).toMatch(/outside this project/i);
    }

    expect(fs.readFileSync(outside, "utf8")).toBe("unrelated file");
  });

  it("refuses a path that is a directory inside the project instead of deleting it recursively", () => {
    const fixture = makeFixture();
    const notes = path.join(fixture.project, "material", "notes.txt");
    write(notes, "study material");

    const result = runReset(fixture, { dbPath: "material" });

    expect(result.status).toBe(1);
    expect(result.output).toMatch(/must name the SQLite database file/i);
    expect(fs.readFileSync(notes, "utf8")).toBe("study material");
  });

  it("refuses a symlink that resolves outside the project", () => {
    const fixture = makeFixture();
    const outside = path.join(fixture.parent, "outside");
    const sentinel = path.join(outside, "learner-notes.txt");
    write(sentinel, "private learner data");
    fs.symlinkSync(outside, path.join(fixture.project, "escape"), "dir");
    // The default `.data` storage pointing outside the project is refused too.
    fs.symlinkSync(outside, path.join(fixture.project, ".data"), "dir");

    const custom = runReset(fixture, { dbPath: "escape" });
    expect(custom.status).toBe(1);
    expect(custom.output).toMatch(/outside this project/i);

    const fallback = runReset(fixture);
    expect(fallback.status).toBe(1);
    expect(fallback.output).toMatch(/outside this project/i);

    expect(fs.readFileSync(sentinel, "utf8")).toBe("private learner data");
  });

  it("resets a custom database file inside the project and leaves unrelated files alone", () => {
    const fixture = makeFixture();
    const dataDir = path.join(fixture.project, ".data");
    const dbFile = path.join(dataDir, "scratch.sqlite");
    write(dbFile, "database");
    write(`${dbFile}-wal`, "wal");
    write(`${dbFile}-shm`, "shm");
    write(path.join(dataDir, "unrelated.txt"), "keep me");
    fs.mkdirSync(path.join(fixture.project, "nested"), { recursive: true });

    // A relative EXAMFORGE_DB_PATH resolves against the project root, not the cwd.
    const result = runReset(fixture, { dbPath: path.join(".data", "scratch.sqlite"), cwd: path.join(fixture.project, "nested") });

    expect(result.status).toBe(0);
    expect(fs.existsSync(dbFile)).toBe(false);
    expect(fs.existsSync(`${dbFile}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbFile}-shm`)).toBe(false);
    expect(fs.readFileSync(path.join(dataDir, "unrelated.txt"), "utf8")).toBe("keep me");
  });

  it("still removes the default .data directory", () => {
    const fixture = makeFixture();
    const dataDir = path.join(fixture.project, ".data");
    write(path.join(dataDir, "examforge.sqlite"), "database");
    write(path.join(dataDir, "examforge.sqlite-wal"), "wal");

    const result = runReset(fixture);

    expect(result.status).toBe(0);
    expect(fs.existsSync(dataDir)).toBe(false);
  });

  it("reports nothing to remove when the default storage does not exist", () => {
    const fixture = makeFixture();

    const result = runReset(fixture);

    expect(result.status).toBe(0);
    expect(result.output).toMatch(/nothing to remove/i);
  });
});
