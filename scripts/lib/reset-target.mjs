/**
 * Deletion-safety decision for `npm run db:reset`.
 *
 * The reset command is destructive, so what it may delete is decided here, in one
 * place, and the CLI script does nothing but execute the decision. The rule is a real
 * filesystem boundary — never string containment:
 *
 *  - the project root is the checkout that contains this file, not the current working
 *    directory (a reset started from `/` or from a home directory must not become
 *    "anything on this machine is inside the project");
 *  - the target is canonicalized (symlinks resolved) before it is compared, so a path
 *    that only *looks* contained cannot reach outside the checkout;
 *  - the project root itself is never a valid target;
 *  - `EXAMFORGE_DB_PATH` is the app's SQLite *file* (see `src/lib/db.ts`), so a custom
 *    reset removes that file and its SQLite sidecars instead of recursively deleting a
 *    directory;
 *  - only the default `.data` directory (the app-owned, gitignored storage directory)
 *    is removed recursively.
 */
import fs from "node:fs";
import path from "node:path";

/** SQLite sidecar suffixes that belong to a database file. */
const SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"];

/**
 * Canonical form of `p`: symlinks in every existing path segment are resolved, and a
 * not-yet-existing tail is kept as-is. Returns an absolute path.
 */
export function canonicalPath(p) {
  let current = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return tail.length > 0 ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return tail.length > 0 ? path.join(current, ...tail) : current;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** True when `target` is strictly inside `root` (never `root` itself, never a sibling). */
export function isStrictlyInside(root, target) {
  const rel = path.relative(canonicalPath(root), canonicalPath(target));
  if (rel === "") return false;
  if (rel === ".." || rel.startsWith(`..${path.sep}`)) return false;
  if (path.isAbsolute(rel)) return false; // different volume (Windows) — not comparable
  return true;
}

/**
 * Decide what a reset may delete.
 *
 * @param {{ env?: Record<string, string | undefined>, projectRoot: string }} options
 * @returns {{ ok: true, kind: "directory" | "file", paths: string[] }
 *          | { ok: false, reason: string, target: string }}
 */
export function resolveResetTarget({ env = process.env, projectRoot }) {
  const root = canonicalPath(projectRoot);
  const custom = env.EXAMFORGE_DB_PATH;
  const target = custom ? path.resolve(projectRoot, custom) : path.join(projectRoot, ".data");

  if (!isStrictlyInside(root, target)) {
    const reason =
      canonicalPath(target) === root
        ? "the project root itself cannot be reset"
        : custom
          ? "EXAMFORGE_DB_PATH resolves outside this project"
          : "the default .data directory resolves outside this project";
    return { ok: false, reason, target };
  }

  if (!custom) {
    return { ok: true, kind: "directory", paths: [target] };
  }

  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    return {
      ok: false,
      reason: "EXAMFORGE_DB_PATH must name the SQLite database file, not a directory",
      target,
    };
  }

  return { ok: true, kind: "file", paths: [target, ...SIDECAR_SUFFIXES.map((s) => target + s)] };
}
