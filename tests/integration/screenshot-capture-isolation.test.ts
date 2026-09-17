import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "@/lib/db";
import { SAMPLE_MATERIAL_TITLE } from "@/sample/material";
import { CAPTURE_HOST, CAPTURE_PORT, defaultServerCommand, startCaptureServer } from "../../scripts/lib/capture-env.mjs";

/**
 * Regression coverage for the screenshot-capture isolation contract.
 *
 * Screenshots are published, so the capture environment must own a disposable database
 * and must never be able to read a learner database. These tests use the real Next.js
 * app (dev mode, so no production build is required) started by the real capture
 * environment helper, plus a process-level test of the shipped capture CLI.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SENTINEL_TITLE = "PRIVATE SENTINEL COURSE — must never be captured";
/** Dedicated test port, distinct from the CLI's capture port and from the E2E ports. */
const TEST_PORT = 3311;

const tempDirs: string[] = [];
const servers: { stop: () => Promise<void> }[] = [];
let previousDbPath: string | undefined;
let hadDbPath = false;

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A valid learner database, so an isolation failure would surface as visible course data. */
function createLearnerDatabase(file: string, title: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  try {
    runMigrations(raw);
    raw
      .prepare(
        `INSERT INTO courses (id, title, source_type, material_text, provider_used, provider_notice, quality_json, created_at)
         VALUES (?, ?, 'paste', ?, 'deterministic', NULL, ?, ?)`,
      )
      .run(
        "crs_sentinel",
        title,
        "private study material that must never be published",
        JSON.stringify({ level: "good", notes: [] }),
        new Date().toISOString(),
      );
  } finally {
    raw.close();
  }
}

function readCourseTitles(file: string): string[] {
  const raw = new DatabaseSync(file);
  try {
    return (raw.prepare("SELECT title FROM courses ORDER BY created_at").all() as { title: string }[]).map((r) => r.title);
  } finally {
    raw.close();
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

async function startIsolated(): Promise<Awaited<ReturnType<typeof startCaptureServer>>> {
  const server = await startCaptureServer({
    port: TEST_PORT,
    cwd: REPO_ROOT,
    serverCommand: defaultServerCommand({ port: TEST_PORT, cwd: REPO_ROOT, mode: "dev" }),
    readyTimeoutMs: 120_000,
  });
  servers.push(server);
  return server;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  if (hadDbPath) process.env.EXAMFORGE_DB_PATH = previousDbPath;
  else delete process.env.EXAMFORGE_DB_PATH;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("screenshot capture isolation", () => {
  it(
    "ignores an ambient learner database and starts from clean disposable state",
    async () => {
      const learnerDir = tempDir("examforge-learner-");
      const learnerDb = path.join(learnerDir, "learner.sqlite");
      createLearnerDatabase(learnerDb, SENTINEL_TITLE);
      hadDbPath = true;
      previousDbPath = process.env.EXAMFORGE_DB_PATH;
      // Simulates a maintainer whose shell points the app at their own database.
      process.env.EXAMFORGE_DB_PATH = learnerDb;

      const server = await startIsolated();

      // The capture server owns a fresh temporary database, not the learner one.
      expect(server.tempDir.startsWith(os.tmpdir())).toBe(true);
      expect(server.dbPath.startsWith(server.tempDir + path.sep)).toBe(true);
      expect(fs.existsSync(server.dbPath)).toBe(true);

      const body = (await (await fetch(`${server.baseUrl}/api/courses`)).json()) as { courses: { title: string }[] };
      expect(body.courses.map((c) => c.title)).not.toContain(SENTINEL_TITLE);
      expect(body.courses).toEqual([]);

      // The learner database and the ambient environment are left untouched.
      expect(process.env.EXAMFORGE_DB_PATH).toBe(learnerDb);
      expect(readCourseTitles(learnerDb)).toEqual([SENTINEL_TITLE]);
    },
    180_000,
  );

  it(
    "creates only bundled demo material and removes its disposable state afterwards",
    async () => {
      const server = await startIsolated();
      const { tempDir: dir, dbPath } = server;

      const created = await fetch(`${server.baseUrl}/api/courses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sample: true }),
      });
      expect(created.ok).toBe(true);

      const body = (await (await fetch(`${server.baseUrl}/api/courses`)).json()) as {
        courses: { title: string; sourceType: string }[];
      };
      expect(body.courses.map((c) => c.title)).toEqual([SAMPLE_MATERIAL_TITLE]);
      expect(body.courses.every((c) => c.sourceType === "bundled")).toBe(true);

      await server.stop();
      await server.stop(); // idempotent

      expect(fs.existsSync(dir)).toBe(false);
      expect(fs.existsSync(dbPath)).toBe(false);
      expect(await waitForPortFree(TEST_PORT)).toBe(true);
    },
    180_000,
  );

  it("refuses to reuse a server that is already listening on the capture port", async () => {
    const learnerDir = tempDir("examforge-learner-");
    const learnerDb = path.join(learnerDir, "learner.sqlite");
    createLearnerDatabase(learnerDb, SENTINEL_TITLE);

    const requests: string[] = [];
    const blocker = http.createServer((req, res) => {
      requests.push(req.url ?? "");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, courses: [{ id: "crs_sentinel", title: SENTINEL_TITLE }] }));
    });
    await new Promise<void>((resolve) => blocker.listen(CAPTURE_PORT, CAPTURE_HOST, resolve));

    try {
      const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "capture-screenshots.mjs")], {
        cwd: REPO_ROOT,
        env: { ...process.env, EXAMFORGE_DB_PATH: learnerDb },
        encoding: "utf8",
        timeout: 60_000,
      });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/already in use/i);
      // The pre-existing server was never contacted, so it could never be captured.
      expect(requests).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  }, 60_000);
});
