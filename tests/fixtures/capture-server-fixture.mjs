/**
 * Test-owned stand-in for the capture server.
 *
 * The screenshot lifecycle tests need to hold the startup window open and to observe
 * exactly when the owned child process is torn down, which a real `next start` cannot do
 * deterministically. This fixture is spawned by the shipped `startCaptureServer()` through
 * its documented `serverCommand` option, so the production lifecycle code runs unchanged.
 *
 * Environment (all set by the test):
 *  - `R01_FIXTURE_PID_FILE` — where to write this process's pid, the test's proof that the
 *    owned child was really spawned.
 *  - `R01_FIXTURE_DB_RECORD` — where to record the disposable `EXAMFORGE_DB_PATH` this
 *    process was handed, the test's proof that capture temp state already existed.
 *  - `R01_FIXTURE_MODE` — `stall` (default) never listens, so startup never resolves;
 *    `serve` answers the health/course-list probes from a clean disposable database.
 *  - `R01_FIXTURE_SIGTERM_DELAY_MS` — linger after `SIGTERM`, so tests can prove that
 *    cleanup callers wait for real termination instead of returning early.
 *  - `R01_CAPTURE_PORT` — the port to listen on in `serve` mode.
 */
import fs from "node:fs";
import http from "node:http";

const mode = process.env.R01_FIXTURE_MODE ?? "stall";
const sigtermDelayMs = Number(process.env.R01_FIXTURE_SIGTERM_DELAY_MS ?? "0");

// Written before the pid file below, which is the tests' synchronization point.
if (process.env.R01_FIXTURE_DB_RECORD) {
  fs.writeFileSync(process.env.R01_FIXTURE_DB_RECORD, process.env.EXAMFORGE_DB_PATH ?? "");
}
if (process.env.R01_FIXTURE_PID_FILE) {
  fs.writeFileSync(process.env.R01_FIXTURE_PID_FILE, String(process.pid));
}

process.on("SIGTERM", () => {
  if (sigtermDelayMs > 0) setTimeout(() => process.exit(0), sigtermDelayMs);
  else process.exit(0);
});

if (mode === "serve") {
  // The disposable database must exist before the helper's isolation self-check runs.
  if (process.env.EXAMFORGE_DB_PATH) fs.writeFileSync(process.env.EXAMFORGE_DB_PATH, "");

  const port = Number(process.env.R01_CAPTURE_PORT);
  http
    .createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/health") res.end(JSON.stringify({ ok: true }));
      else if (req.url === "/api/courses") res.end(JSON.stringify({ courses: [] }));
      else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
      }
    })
    .listen(port, "127.0.0.1", () => console.log(`fixture listening on 127.0.0.1:${port}`));
  console.log(`fixture serving pid=${process.pid}`);
} else {
  console.log(`fixture stalling pid=${process.pid}`);
}

// Keep the process alive independently of signal listeners.
setInterval(() => {}, 1_000);
