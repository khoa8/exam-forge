# PROJECT_STATUS.md

_Last updated: 2026-09-03, final verification round complete_

## Current state: release candidate, all gates green

ExamForge is a complete, verified, runnable Next.js 15 + TypeScript MVP implementing the
full no-key learning loop:

> Material → Concepts → Diagnostic → Grading/Feedback → Weak-topic model → Targeted
> practice → Mock exam → Readiness dashboard — persisted in local SQLite.

## Verified final results (production build)

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npx tsc --noEmit` | ✅ clean |
| Lint | `npm run lint` | ✅ clean |
| Unit + integration | `npx vitest run tests/unit tests/integration` | ✅ 68/68 (10 files) |
| E2E | `npx playwright test` | ✅ full UI journey passes |
| Production build | `npm run build` | ✅ succeeds |
| Bundled demo (API-level user simulation) | diagnostic 4/8 → practice weakest 4/4 → mock 5/8, no grade leakage before submit, readiness 59% + next action, progress persisted | ✅ |
| Real-browser UX | Playwright journey + UX probe (unknown-course error, short-paste validation, poor-material honesty, empty-session message, keyboard MCQ, 390-px mobile) | ✅ |
| Screenshots | 8 production-server captures in `docs/screenshots/`, visually reviewed | ✅ |

The demo database was reset to pristine after testing, so a first-time user sees the
intended empty state.

## P1 criteria check (GOAL.md)

- ✅ Text-based PDF ingestion (unpdf, honest quality/failure messages, tested with
  generated fixtures)
- ✅ Real provider adapter (GLM, OpenAI-compatible) plus deterministic mock provider and
  automatic fallback (`.env.example`, failure-path tested)
- ✅ Stronger question schema validation (zod + deterministic gates: membership,
  uniqueness, grounding, ambiguity, duplicates)
- ✅ Duplicate/ambiguous-question checks (near-duplicate prompts/statements, ambiguity
  guard; cross-session duplicates are backlog item 1)
- ✅ Adaptive practice logic (review-priority-ordered practice picker, weakest-first)
- ✅ Simple spaced-review metadata (lastSeen, per-status next-review hints; scheduling
  persistence is backlog item 14)
- ✅ Concept/readiness visualization (mastery bars, statuses, readiness plan; concept
  graph is backlog item 3)
- ✅ Polished demo, README, and real screenshots

## Documentation

- `README.md` — what it is, quick start, workflow, screenshots, limitations
- `PRODUCT.md` — mission, loop, grounding/honesty rules, adaptive model
- `ARCHITECTURE.md` — module map, data flow, invariants, testing strategy
- `TASKS.md` — P0 done, P1 state, backlog
- `FINAL_REPORT.md` — verified behavior, commands, results, limitations, next 20 tasks,
  readiness assessments

## Git checkpoints

- `5aa6a9e` core engine + API + UI scaffold
- `ae7e8fe` unit/integration test suite
- `0b93e04` Playwright e2e journey
- `2d1ba99` recovery baseline documentation
- `39dac3b` spaced-review hints + UX states + screenshots + probe
- final docs/report commit (see git log)

## Known limitations (accepted, documented)

Definition-centric demo generation with fail-closed grounding (fewer questions, never
fabricated ones); heuristic-only readiness; no OCR; single local learner; GLM adapter
verified against mapping/failure/fallback paths but not a live paid endpoint.

## Next highest-value actions

See FINAL_REPORT.md §6 (20 ranked tasks); top three: cross-session duplicate detection,
"review today" queue page, concept-map view.
