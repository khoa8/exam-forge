/**
 * Termination-safe lifecycle for the screenshot capture CLI.
 *
 * Screenshot capture owns real resources — a temporary directory and a spawned server
 * process — and it can be interrupted at any point, including while that server is still
 * starting. Signal ownership therefore has to be installed *before* the asynchronous
 * startup begins, so a `SIGINT`/`SIGTERM` that arrives during startup still releases
 * everything that was already acquired before the process exits.
 *
 * The contract:
 *  - `start(signal)` observes the signal, releases whatever it acquired, and rejects;
 *  - `run(server)` is the actual capture work and is never entered once termination has
 *    been requested;
 *  - every exit path awaits the same `server.stop()` promise, so repeated or concurrent
 *    cleanup callers all observe real completion rather than returning early;
 *  - the process exits with the conventional signal status (130 for `SIGINT`, 143 for
 *    `SIGTERM`) instead of a generic failure code.
 */

/**
 * @template {{ stop: () => Promise<void> }} Server
 * @param {{
 *   start: (signal: AbortSignal) => Promise<Server>,
 *   run: (server: Server) => Promise<void>,
 *   signals?: readonly string[],
 *   exit?: (code: number) => void,
 *   reportError?: (error: unknown) => void,
 * }} options
 * @returns {Promise<void>}
 */
export async function runCaptureLifecycle({
  start,
  run,
  signals = ["SIGINT", "SIGTERM"],
  exit = (code) => process.exit(code),
  reportError = (error) => console.error(error),
}) {
  const controller = new AbortController();
  /** Signal whose termination is already being handled, if any. */
  let terminating = null;

  // Started before the handlers below are installed, and awaited by both paths, so a
  // signal arriving mid-startup can never race the caller into a half-owned server.
  const startup = start(controller.signal);

  const removeSignalHandlers = () => {
    for (const signal of signals) process.removeListener(signal, onSignal);
  };

  const shutdown = async (signal) => {
    terminating = signal;
    controller.abort();
    let server = null;
    try {
      server = await startup;
    } catch {
      // Startup observed the abort and released everything it had acquired.
    }
    if (server) {
      try {
        await server.stop();
      } catch (error) {
        reportError(error);
      }
    }
    exit(signal === "SIGINT" ? 130 : 143);
  };

  const onSignal = (signal) => {
    if (terminating) return;
    void shutdown(signal);
  };
  for (const signal of signals) process.once(signal, onSignal);

  let server;
  try {
    server = await startup;
  } catch (error) {
    removeSignalHandlers();
    if (terminating) return; // shutdown() owns the exit path
    throw error;
  }

  try {
    if (terminating) return; // never fall through into capture after a termination request
    await run(server);
  } finally {
    try {
      if (!terminating) await server.stop();
    } finally {
      // Handlers stay installed until the server is stopped: a signal in that window is
      // still handled by shutdown() instead of killing the process with cleanup pending.
      removeSignalHandlers();
    }
  }
}
