# TASKS.md

Status legend: ✅ done · 🔨 in progress · 📋 planned

## P0 — core loop (all done)

- ✅ Bundled sample material (original, redistributable)
- ✅ Deterministic concept extraction with grounding quotes + quality levels
- ✅ Deterministic question generation (MCQ, true/false, short, explanation)
- ✅ Validation gates (schema, answer-key membership, uniqueness, duplicates, ambiguity)
- ✅ Deterministic grading incl. partial-credit explanation grading
- ✅ Diagnostic sessions (balanced, ≤8 questions, immediate grounded feedback)
- ✅ Mastery model (recency-weighted) + weak/developing/strong/untested statuses
- ✅ Targeted practice sessions (per concept, mixed types)
- ✅ Mock exams (balanced, deferred feedback, full review after submit)
- ✅ Readiness dashboard (heuristic estimate, coverage, ordered study plan, next action)
- ✅ SQLite persistence (courses, concepts, questions, sessions, attempts)
- ✅ Provider abstraction (demo + GLM adapter + fallback + `.env.example`)
- ✅ Prompt-injection defenses (sentence filtering + untrusted wrapping + scan notice)
- ✅ PDF ingestion (unpdf) with honest failure/quality messages
- ✅ UI: stepper, dashboard with next action, runners, readiness page, mobile layout
- ✅ Tests: 68 unit/integration + Playwright journey; typecheck; lint; production build

## P1 — high-value polish

- ✅ Spaced-review hints (weak → today, developing → 2 days, strong → 7 days)
- ✅ Real screenshots (docs/screenshots) captured from the running app
- ✅ Friendly empty/error states (verified via UX probe script)
- 🔨 Documentation set (README, PRODUCT, ARCHITECTURE, TASKS, FINAL_REPORT)
- 📋 Stronger duplicate detection across sessions (cross-session prompt similarity)
- 📋 Concept-map visualization (prerequisites only when the material states them)
- 📋 Review-queue page ("review today" list from next-review hints)
- 📋 Export/import of a course (material + progress) as a single file

## P2 — later, non-blocking

- 📋 Fill-in-the-blank as a distinct type; ordering; matching
- 📋 OCR path for scanned PDFs (explicit opt-in, honest quality reporting)
- 📋 Multi-document courses (merge + per-source evidence)
- 📋 Simple scheduling persistence (next_review_at column + reminder list)
- 📋 Optional cloud sync (explicit user action, still local-first)

## Explicitly out of scope

School admin · teacher dashboards · LMS integration · billing · social features ·
gamification systems · voice tutor · live-exam assistance.
