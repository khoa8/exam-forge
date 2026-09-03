#!/usr/bin/env node
/**
 * Deletes the local ExamForge database (material + progress).
 * Usage: npm run db:reset  (prompts-free, safe: only removes EXAMFORGE_DB_PATH
 * or the default .data directory inside this project)
 */
import fs from "node:fs";
import path from "node:path";

const custom = process.env.EXAMFORGE_DB_PATH;
const target = custom
  ? path.resolve(custom)
  : path.join(process.cwd(), ".data");

if (custom && !target.includes(process.cwd())) {
  console.error(`Refusing to delete ${target} — EXAMFORGE_DB_PATH points outside this project.`);
  process.exit(1);
}

if (fs.existsSync(target)) {
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`Removed ${target}`);
} else {
  console.log(`Nothing to remove at ${target}`);
}
