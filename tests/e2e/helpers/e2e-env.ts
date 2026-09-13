import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Shared environment for browser test suites. E2E must never touch a real
 * learner database or an arbitrary developer server:
 *  - a disposable SQLite file inside a temp directory is used via EXAMFORGE_DB_PATH;
 *  - each suite binds its own loopback-only server on a dedicated port;
 *  - generation is deterministic and local (no key, no network);
 *  - the temp directory is recreated on setup and removed on teardown.
 */

export function e2eTempDir(): string {
  return path.join(os.tmpdir(), "examforge-e2e");
}

export function e2eDbPath(): string {
  return path.join(e2eTempDir(), "e2e.sqlite");
}

export function setupE2eEnv(): void {
  fs.rmSync(e2eTempDir(), { recursive: true, force: true });
  fs.mkdirSync(e2eTempDir(), { recursive: true });
}

export function teardownE2eEnv(): void {
  fs.rmSync(e2eTempDir(), { recursive: true, force: true });
}

export function e2eServerEnv(): Record<string, string> {
  return {
    EXAMFORGE_DB_PATH: e2eDbPath(),
  };
}
