# PROJECT_STATUS.md

_Last updated: 2026-09-03 13:20 Asia/Ho_Chi_Minh (recovery checkpoint)_

## Current verified state

ExamForge is a runnable Next.js 15 (App Router, TypeScript) MVP that implements the full
no-key learning loop: **Material → Concepts → Diagnostic → Grading/Feedback → Weak-topic
model → Targeted practice → Mock exam → Readiness dashboard**, with SQLite persistence
(`node:sqlite`, file `.data/examforge.sqlite`, gitignored).

The deterministic demo provider (no API key, no network) extracts concepts and generates
grounded questions from study material; an optional GLM adapter exists behind the same
interface with automatic fallback.

## Last known working commit

`ae7e8fe` — "E2E: Playwright smoke test covering the full bundled-demo journey"
(on top of `5aa6a9e` core + tests). Working tree clean after this commit.

## Validation commands and results (all run 2026-09-03 13:12–13:20 ICT)

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | ✅ clean |
| `npm run lint` | ✅ no warnings/errors |
| `npx vitest run tests/unit tests/integration` | ✅ 67/67 tests, 10 files |
| `npx playwright test` | ✅ 1/1 e2e smoke (full UI journey, ~4s) |
| `npm run build` | ✅ production build succeeds (103–111 kB first load) |
| API user-flow simulation (`/tmp/ef-user-flow.py`) | ✅ full loop verified: diagnostic 4/8 → weak topics detected → practice weakest 4/4 → mock 5/8 with deferred grading → readiness 46%→57%, progress persisted |

## Current uncommitted work

None (Playwright config + e2e test were committed as `ae7e8fe`).

## Goal criteria status

Done and verified:
- Bundled sample material (original, redistributable) → 10 concepts, 40 validated questions, no key needed
- Diagnostic (≤8 balanced questions), consistent grading, grounded explanations + evidence quotes
- Weak/strong/untested mastery estimates with review priority; readiness labeled as internal heuristic
- Practice by concept (weak first); mock exam with deferred feedback + full review
- Persistence (SQLite) across sessions; delete-course privacy behavior
- Deterministic validation gates (required fields, option membership/uniqueness, grounding quotes,
  near-duplicate removal, ambiguity guard); all applied to every generated question
- Prompt-injection defenses (sentence-level filtering, nonce-wrapped untrusted blocks for LLM path,
  injection scan surfaced honestly in quality notes)
- GLM provider adapter (OpenAI-compatible), fallback to demo on any failure, `.env.example`
- PDF ingestion via unpdf with honest quality warnings (unit-tested with generated fixtures)
- Tests: ingestion, schemas, validation, grading, mastery, readiness, sampling, injection,
  provider failure/fallback, persistence, full demo flow, Playwright UI journey

## Remaining work

The previous 08:40 / 09:00 feature-freeze is obsolete and must be ignored.

P0 is fully implemented and verified.

Before final completion, prioritize:

1. Real screenshots for README using the actual running application.
2. Browser UX inspection across main states and responsive layouts, with repairs for material issues.
3. Verify whether any high-value P1 criteria in GOAL.md remain incomplete or only partially implemented.
4. Improve documentation: README.md, PRODUCT.md, ARCHITECTURE.md, TASKS.md, FINAL_REPORT.md.
5. Cleanup temporary/scratch artifacts and verify .gitignore.
6. Run the complete validation suite again after any changes.
7. Create final verified local checkpoint commit(s).

Do not invent new low-value features merely to consume quota.

## Next highest-value action

Re-read GOAL.md and compare the verified repository against every P1 criterion.

If any important P1 criterion is incomplete, implement and verify it.

Otherwise continue with real screenshot capture, browser UX inspection and repairs,
documentation, cleanup, and final release validation.
