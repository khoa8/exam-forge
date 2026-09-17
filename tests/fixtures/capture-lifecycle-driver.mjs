/**
 * Test-owned driver for the shipped screenshot-capture lifecycle.
 *
 * `scripts/capture-screenshots.mjs` cannot be pointed at a fixture server without an
 * unsafe production escape hatch, so this driver wires the same production modules the
 * CLI uses — `runCaptureLifecycle()` and `startCaptureServer()` — around the fixture
 * server. A test process spawns this driver and delivers a real `SIGINT`/`SIGTERM`, which
 * exercises the shipped signal ownership, startup cancellation and cleanup code paths
 * without requiring a production Next build.
 *
 * `R01_CAPTURE_PORT` must be set by the test; the fixture server path is resolved next to
 * this file. `run()` prints markers the test asserts on: a terminated startup must never
 * reach them.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startCaptureServer } from "../../scripts/lib/capture-env.mjs";
import { runCaptureLifecycle } from "../../scripts/lib/capture-lifecycle.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const PORT = Number(process.env.R01_CAPTURE_PORT);
if (!Number.isInteger(PORT) || PORT <= 0) throw new Error("R01_CAPTURE_PORT must be set by the test");

await runCaptureLifecycle({
  start: (signal) =>
    startCaptureServer({
      port: PORT,
      cwd: REPO_ROOT,
      serverCommand: { command: process.execPath, args: [path.join(HERE, "capture-server-fixture.mjs")] },
      // Short enough that a startup which only notices termination when readiness times
      // out fails the tests quickly instead of hanging.
      readyTimeoutMs: 15_000,
      signal,
    }),
  run: async (server) => {
    console.log(`capture-started ${server.baseUrl}`);
    console.log(`capture-temp-dir ${server.tempDir}`);
  },
});

console.log("lifecycle-completed");
