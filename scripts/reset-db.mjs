#!/usr/bin/env node
/**
 * Deletes the local ExamForge database (material + progress).
 * Usage: npm run db:reset
 *
 * Prompts-free, and fail-closed about what it may delete:
 *  - only a target strictly inside this checkout is accepted (a real path boundary,
 *    resolved against this script's project root — not the current directory);
 *  - the project root itself is always refused;
 *  - EXAMFORGE_DB_PATH names the SQLite database file, so a custom reset removes that
 *    file and its SQLite sidecars — never a directory tree;
 *  - without EXAMFORGE_DB_PATH the app-owned `.data` directory is removed.
 *
 * The decision lives in ./lib/reset-target.mjs and is covered by tests.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveResetTarget } from "./lib/reset-target.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const decision = resolveResetTarget({ env: process.env, projectRoot });

if (!decision.ok) {
  console.error(`Refusing to reset ${decision.target} — ${decision.reason}.`);
  console.error(
    "db:reset only deletes local ExamForge data inside this checkout. " +
      "Point EXAMFORGE_DB_PATH at a path inside the project, or delete an external file yourself.",
  );
  process.exit(1);
}

let removed = 0;
for (const target of decision.paths) {
  if (!fs.existsSync(target)) continue;
  try {
    if (decision.kind === "directory") fs.rmSync(target, { recursive: true, force: true });
    else fs.rmSync(target, { force: true });
    removed++;
    console.log(`Removed ${target}`);
  } catch (err) {
    console.error(`Failed to remove ${target}: ${err.message}`);
    process.exitCode = 1;
  }
}

if (removed === 0 && process.exitCode !== 1) {
  console.log(`Nothing to remove at ${decision.paths[0]}`);
}
