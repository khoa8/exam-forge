import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CAPTURE_HOST, startCaptureServer } from "../../scripts/lib/capture-env.mjs";

/**
 * Regression coverage for the screenshot-capture startup lifecycle.
 *
 * A `SIGINT`/`SIGTERM` delivered while the capture server was still starting used to be
 * handled by Node's default handler, because the CLI installed its own handlers only
 * after `startCaptureServer()` resolved. The owned server process and the disposable
 * temp directory were then left behind (and the port stayed occupied by the orphan).
 *
 * These tests drive the real shipped lifecycle — `scripts/lib/capture-lifecycle.mjs` and
 * `scripts/lib/capture-env.mjs` — through a test-owned fixture server, so the startup
 * window can be held open deterministically without a production Next build. Every path
 * is disposable: the driver gets its own `TMPDIR` and its own `EXAMFORGE_DB_PATH`, and
 * the ambient learner data it points at must stay untouched.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DRIVER = path.join(REPO_ROOT, "tests", "fixtures", "capture-lifecycle-driver.mjs");
const FIXTURE = path.join(REPO_ROOT, "tests", "fixtures", "capture-server-fixture.mjs");
/** Dedicated test port, distinct from the CLI capture port and the E2E ports. */
const PORT = 3322;
const TEMP_PREFIX = "examforge-screenshots-";
const SENTINEL = "private learner material that must never be read or written";
const SYSTEM_TMP = os.tmpdir();

interface Fixture {
  /** Disposable root owned by this test. */
  root: string;
  /** Private `TMPDIR` for the driver, so capture temp state cannot escape into real /tmp. */
  tmp: string;
  /** Where the fixture server writes its pid. */
  pidFile: string;
  /** Where the fixture server records the disposable database path it was handed. */
  dbRecord: string;
  /** Ambient learner database path the capture must never touch. */
  ambientDb: string;
}

interface DriverRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface Driver {
  child: ChildProcess;
  exited: Promise<DriverRun>;
}

const tempRoots: string[] = [];
const drivers: Driver[] = [];
const servers: { stop: () => Promise<void> }[] = [];
const fixturePids: number[] = [];
const savedEnv = {
  TMPDIR: process.env.TMPDIR,
  EXAMFORGE_DB_PATH: process.env.EXAMFORGE_DB_PATH,
};

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(SYSTEM_TMP, "examforge-capture-lifecycle-"));
  tempRoots.push(root);
  const tmp = path.join(root, "tmp");
  fs.mkdirSync(tmp, { recursive: true });
  const ambientDb = path.join(root, "learner.sqlite");
  fs.writeFileSync(ambientDb, SENTINEL);
  return {
    root,
    tmp,
    pidFile: path.join(root, "fixture.pid"),
    dbRecord: path.join(root, "fixture-db-path.txt"),
    ambientDb,
  };
}

/** Spawn the driver around the production lifecycle with test-owned resources. */
function startDriver(fixture: Fixture, env: Record<string, string>): Driver {
  const child = spawn(process.execPath, [DRIVER], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      TMPDIR: fixture.tmp,
      EXAMFORGE_DB_PATH: fixture.ambientDb,
      R01_CAPTURE_PORT: String(PORT),
      R01_FIXTURE_PID_FILE: fixture.pidFile,
      R01_FIXTURE_DB_RECORD: fixture.dbRecord,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
  const exited = new Promise<DriverRun>((resolve) => {
    // `close` fires once the stdio pipes are drained, so the snapshot is complete.
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  const driver = { child, exited };
  drivers.push(driver);
  return driver;
}

/** Wait until the owned fixture server has really been spawned, and return its pid. */
async function waitForFixturePid(fixture: Fixture, timeoutMs = 20_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(fixture.pidFile)) {
      const raw = fs.readFileSync(fixture.pidFile, "utf8").trim();
      if (raw) {
        const pid = Number(raw);
        fixturePids.push(pid);
        return pid;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("fixture server was never spawned");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function portIsFree(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.connect({ port, host: CAPTURE_HOST });
    const finish = (free: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(free);
    };
    socket.setTimeout(1_000);
    socket.once("connect", () => finish(false));
    socket.once("timeout", () => finish(false));
    socket.once("error", (err) => finish((err as NodeJS.ErrnoException).code === "ECONNREFUSED"));
  });
}

async function waitForPortFree(port: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portIsFree(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/** Capture temp state that survived inside the driver's private `TMPDIR`. */
function leakedTempDirs(fixture: Fixture): string[] {
  return fs.readdirSync(fixture.tmp).filter((name) => name.startsWith(TEMP_PREFIX));
}

/** The disposable database path the owned server was handed, recorded by the fixture. */
function recordedDisposableDb(fixture: Fixture): string {
  const dbPath = fs.readFileSync(fixture.dbRecord, "utf8").trim();
  expect(dbPath.startsWith(fixture.tmp + path.sep)).toBe(true);
  return dbPath;
}

function expectAmbientLearnerDataUntouched(fixture: Fixture): void {
  expect(fs.readFileSync(fixture.ambientDb, "utf8")).toBe(SENTINEL);
}

afterEach(async () => {
  for (const driver of drivers.splice(0)) {
    if (driver.child.exitCode === null && driver.child.signalCode === null) driver.child.kill("SIGKILL");
    await driver.exited;
  }
  for (const pid of fixturePids.splice(0)) {
    if (!isAlive(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const server of servers.splice(0)) await server.stop();
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  for (const key of [
    "R01_CAPTURE_PORT",
    "R01_FIXTURE_MODE",
    "R01_FIXTURE_PID_FILE",
    "R01_FIXTURE_DB_RECORD",
    "R01_FIXTURE_SIGTERM_DELAY_MS",
  ]) {
    delete process.env[key];
  }
  if (savedEnv.TMPDIR === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedEnv.TMPDIR;
  if (savedEnv.EXAMFORGE_DB_PATH === undefined) delete process.env.EXAMFORGE_DB_PATH;
  else process.env.EXAMFORGE_DB_PATH = savedEnv.EXAMFORGE_DB_PATH;
});

describe("screenshot capture startup interruption", () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    it(
      `releases the owned server, temp state and port when ${signal} lands during startup`,
      async () => {
        const fixture = makeFixture();
        // The fixture lingers after SIGTERM, so the assertions below only hold if the
        // lifecycle really waited for cleanup instead of returning early.
        const driver = startDriver(fixture, { R01_FIXTURE_SIGTERM_DELAY_MS: "700" });
        const fixturePid = await waitForFixturePid(fixture);
        // Startup already owned its disposable temp directory and database path.
        const disposableDb = recordedDisposableDb(fixture);
        expect(fs.existsSync(path.dirname(disposableDb))).toBe(true);

        // Startup is provably unresolved: the owned server has been spawned, but a
        // stalling server never answers, so `startCaptureServer()` cannot have returned.
        expect(await portIsFree(PORT)).toBe(true);

        driver.child.kill(signal);
        const signalledAt = Date.now();
        const result = await driver.exited;

        // Startup observes cancellation itself: it must not linger until readiness times
        // out (15 s in the driver) before the process terminates.
        expect(Date.now() - signalledAt).toBeLessThan(10_000);
        // Honest signal-style termination, and no fall-through into capture work.
        expect(result.signal).toBe(null);
        expect(result.code).toBe(signal === "SIGINT" ? 130 : 143);
        expect(result.stdout).not.toContain("capture-started");
        expect(result.stderr).toBe("");

        expect(isAlive(fixturePid)).toBe(false);
        expect(fs.existsSync(path.dirname(disposableDb))).toBe(false);
        expect(leakedTempDirs(fixture)).toEqual([]);
        expect(await waitForPortFree(PORT)).toBe(true);
        expectAmbientLearnerDataUntouched(fixture);
      },
      60_000,
    );
  }

  it(
    "still completes a normal startup and removes its disposable state",
    async () => {
      const fixture = makeFixture();
      const driver = startDriver(fixture, { R01_FIXTURE_MODE: "serve" });
      const fixturePid = await waitForFixturePid(fixture);

      const result = await driver.exited;

      expect(result.signal).toBe(null);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("capture-started");
      expect(result.stdout).toContain("lifecycle-completed");
      expect(result.stderr).toBe("");

      const tempDir = result.stdout.match(/capture-temp-dir (.+)/)?.[1]?.trim();
      expect(tempDir).toBeDefined();
      expect(tempDir?.startsWith(fixture.tmp + path.sep)).toBe(true);
      expect(fs.existsSync(tempDir as string)).toBe(false);

      expect(isAlive(fixturePid)).toBe(false);
      expect(leakedTempDirs(fixture)).toEqual([]);
      expect(await waitForPortFree(PORT)).toBe(true);
      expectAmbientLearnerDataUntouched(fixture);
    },
    60_000,
  );

  it(
    "lets concurrent cleanup callers wait for the same cleanup to finish",
    async () => {
      const fixture = makeFixture();
      process.env.TMPDIR = fixture.tmp;
      process.env.EXAMFORGE_DB_PATH = fixture.ambientDb;
      process.env.R01_CAPTURE_PORT = String(PORT);
      process.env.R01_FIXTURE_MODE = "serve";
      process.env.R01_FIXTURE_PID_FILE = fixture.pidFile;
      process.env.R01_FIXTURE_DB_RECORD = fixture.dbRecord;
      process.env.R01_FIXTURE_SIGTERM_DELAY_MS = "700";

      const server = await startCaptureServer({
        port: PORT,
        cwd: REPO_ROOT,
        serverCommand: { command: process.execPath, args: [FIXTURE] },
        readyTimeoutMs: 30_000,
      });
      servers.push(server);
      const fixturePid = await waitForFixturePid(fixture);
      const disposableDb = recordedDisposableDb(fixture);

      // The lifecycle can reach concurrent cleanup callers (abort listener plus the
      // failing startup path), so every caller must observe real completion rather than
      // returning as soon as the first one started.
      const first = server.stop();
      const observedBySecond = await server.stop().then(() => ({
        childAlive: isAlive(fixturePid),
        tempDirExists: fs.existsSync(server.tempDir),
      }));
      await first;

      expect(observedBySecond.childAlive).toBe(false);
      expect(observedBySecond.tempDirExists).toBe(false);
      expect(fs.existsSync(path.dirname(disposableDb))).toBe(false);
      expect(leakedTempDirs(fixture)).toEqual([]);
      expect(await waitForPortFree(PORT)).toBe(true);
      expectAmbientLearnerDataUntouched(fixture);
    },
    60_000,
  );
});
