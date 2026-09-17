/**
 * Isolated server environment for public screenshot capture.
 *
 * README screenshots are published, so capture must never be able to read a
 * maintainer's local learner database. This module owns the whole environment instead of
 * trusting an already-running server:
 *
 *  - it starts its own server process on a dedicated loopback port (never the normal
 *    3000 dev/production port);
 *  - it refuses to start at all when that port is already serving something, so an
 *    existing server — which may hold real courses — can never be captured;
 *  - the server gets an explicit `EXAMFORGE_DB_PATH` inside a fresh temporary directory;
 *  - before capture begins, the environment proves it is serving that disposable
 *    database and that it starts empty;
 *  - the server process and the temporary directory are removed by `stop()`, which the
 *    capture script calls on success, on failure and on interruption;
 *  - startup observes an optional `AbortSignal`, so a termination signal delivered while
 *    the server is still starting releases the resources already acquired instead of
 *    leaving an orphaned server process and temporary directory behind.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

export const CAPTURE_HOST = "127.0.0.1";
/** Dedicated capture port — deliberately not the 3000 used by `npm run dev` / `npm start`. */
export const CAPTURE_PORT = 3300;

/** Absolute path of the project's Next.js CLI, resolved from the project being captured. */
function nextCliPath(cwd) {
  try {
    return require.resolve("next/dist/bin/next", { paths: [cwd] });
  } catch {
    return path.join(cwd, "node_modules", "next", "dist", "bin", "next");
  }
}

/**
 * Default capture server: the project's production build (`next start`), launched
 * directly rather than through `npx` so the process this module owns is the process it
 * can stop. Run `npm run build` first.
 *
 * @param {{ port?: number, cwd?: string, mode?: "start" | "dev" }} [options]
 * @returns {{ command: string, args: string[] }}
 */
export function defaultServerCommand({ port = CAPTURE_PORT, cwd = process.cwd(), mode = "start" } = {}) {
  return {
    command: process.execPath,
    args: [nextCliPath(cwd), mode, "--hostname", CAPTURE_HOST, "-p", String(port)],
  };
}

/** True only when nothing accepts connections on host:port (unreachable is treated as busy). */
async function isPortFree(port, host) {
  return await new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const finish = (free) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(free);
    };
    socket.setTimeout(1_000);
    socket.once("connect", () => finish(false));
    socket.once("timeout", () => finish(false));
    socket.once("error", (err) => finish(err.code === "ECONNREFUSED"));
  });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Raised when a termination signal cancels startup while it still owns resources. */
function startupInterrupted() {
  return new Error("Capture server startup was interrupted by a termination signal.");
}

/**
 * Start the isolated capture server and prove it is safe to capture.
 *
 * @param {{
 *   port?: number,
 *   host?: string,
 *   serverCommand?: { command: string, args: string[] },
 *   cwd?: string,
 *   readyTimeoutMs?: number,
 *   signal?: AbortSignal,
 * }} [options]
 * @returns {Promise<{ host: string, port: number, baseUrl: string, tempDir: string, dbPath: string, stop: () => Promise<void> }>}
 */
export async function startCaptureServer({
  port = CAPTURE_PORT,
  host = CAPTURE_HOST,
  cwd = process.cwd(),
  serverCommand = defaultServerCommand({ port, cwd }),
  readyTimeoutMs = 120_000,
  signal,
} = {}) {
  if (signal?.aborted) throw startupInterrupted();
  if (!(await isPortFree(port, host))) {
    throw new Error(
      `Refusing to capture: ${host}:${port} is already in use. Screenshot capture never reuses an ` +
        "existing server, because it may be serving a real learner database. Stop that process and retry.",
    );
  }
  // The port probe is the last await before resources are acquired; a signal that arrived
  // during it must not lead to a temporary directory being created at all.
  if (signal?.aborted) throw startupInterrupted();

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "examforge-screenshots-"));
  const dbPath = path.join(tempDir, "capture.sqlite");
  const baseUrl = `http://${host}:${port}`;
  const log = [];
  let child = null;
  let spawnError = null;

  const record = (chunk) => {
    for (const line of String(chunk).split("\n")) {
      if (!line.trim()) continue;
      log.push(line);
      if (log.length > 40) log.shift();
    }
  };
  const logTail = () => (log.length > 0 ? `\n--- capture server output ---\n${log.join("\n")}` : "");

  // One cleanup promise for every caller: repeated or concurrent `stop()` calls all await
  // the same termination and temporary-directory removal instead of returning early.
  let stopPromise = null;
  const stop = () => {
    stopPromise ??= (async () => {
      try {
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          if (!(await waitForExit(child, 5_000))) {
            child.kill("SIGKILL");
            await waitForExit(child, 2_000);
          }
        }
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    })();
    return stopPromise;
  };

  // Release owned resources as soon as termination is requested; the abort checks below
  // then stop startup from continuing with a server that is already being torn down.
  const onAbort = () => {
    void stop().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    child = spawn(serverCommand.command, serverCommand.args, {
      cwd,
      // Explicit disposable database: the ambient EXAMFORGE_DB_PATH (a developer's real
      // database, if any) is deliberately overridden rather than inherited.
      env: { ...process.env, EXAMFORGE_DB_PATH: dbPath, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", record);
    child.stderr.on("data", record);
    child.on("error", (err) => {
      spawnError = err;
      record(`failed to start capture server: ${err.message}`);
    });

    const deadline = Date.now() + readyTimeoutMs;
    for (;;) {
      if (signal?.aborted) throw startupInterrupted();
      if (spawnError) throw new Error(`Capture server failed to start: ${spawnError.message}${logTail()}`);
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Capture server exited before it was ready.${logTail()}`);
      }
      try {
        const res = await fetch(`${baseUrl}/api/health`);
        if (res.ok) break;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) {
        throw new Error(`Capture server was not ready within ${readyTimeoutMs} ms.${logTail()}`);
      }
      await delay(250);
    }

    // Isolation self-check: the server must answer from the disposable database, and
    // that database must start empty. Anything else means capture would publish data
    // this environment does not own.
    let courses = null;
    try {
      const res = await fetch(`${baseUrl}/api/courses`);
      const body = await res.json();
      if (res.ok && body && Array.isArray(body.courses)) courses = body.courses;
    } catch {
      // handled below
    }
    if (signal?.aborted) throw startupInterrupted();
    if (courses === null) {
      throw new Error(`Capture server did not return a readable course list.${logTail()}`);
    }
    if (courses.length > 0) {
      throw new Error(
        `Refusing to capture: the capture server returned ${courses.length} existing course(s). ` +
          "Screenshot capture only publishes bundled demo material from a clean database.",
      );
    }
    if (!fs.existsSync(dbPath)) {
      throw new Error(
        "Refusing to capture: the capture server is not using its disposable database " +
          `(${dbPath} was never created).${logTail()}`,
      );
    }

    return { host, port, baseUrl, tempDir, dbPath, stop };
  } catch (err) {
    await stop();
    throw err;
  } finally {
    // Cancellation is only observed while startup owns the resources; afterwards `stop()`
    // is the caller's cleanup path.
    signal?.removeEventListener("abort", onAbort);
  }
}
