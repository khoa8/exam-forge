# FINAL_REPORT.md — ExamForge sprint

_Date: 2026-09-03 · Branch: local only (no remote) · Head: see git log_

## 1. What ExamForge is

A runnable consumer MVP that turns study material into an adaptive exam coach:
**Material → Concepts → Diagnostic → Practice → Mock Exam → Readiness**, with grounded
questions/explanations, deterministic grading, a simple adaptive model, and local
persistence — all working with **no API key** via the bundled deterministic provider.

## 2. Verified behavior (all personally executed on this machine)

### 2.1 Automated gates (final round, production build)

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npx tsc --noEmit` | ✅ clean |
| Lint | `npm run lint` | ✅ no warnings/errors |
| Unit + integration | `npx vitest run tests/unit tests/integration` | ✅ **68/68** across 10 files |
| E2E journey | `npx playwright test` | ✅ 1/1 — full UI journey (bundled material → diagnostic → practice → mock → readiness) |
| Production build | `npm run build` | ✅ succeeds; 14 routes; ~103–111 kB first load |
| Bundled demo via API | simulated first-time user (`scripts` run): diagnostic 4/8 → weak topics detected → practice weakest 4/4 (incl. 5/6 key-idea coverage on explanation) → mock 5/8 with **no grade leakage before submit** → readiness 59% with next action | ✅ |

### 2.2 Real-browser verification

- Playwright journey test clicks through the actual UI: loads bundled material, sees
  extracted concepts, answers all diagnostic questions with feedback, practices a topic,
  completes and submits a mock exam, and lands on the readiness dashboard with the
  honest-estimate labels.
- UX probe (`scripts/ux-probe.mjs`) verified: unknown-course error state, short-paste
  validation error, poor-material honest quality note, friendly empty-session message,
  keyboard operability of MCQ options, and 390-px mobile layout (screenshot
  `08-mobile-dashboard.png`).
- 8 screenshots captured from the **production server** in `docs/screenshots/` and
  visually reviewed (home + empty state, dashboard, diagnostic feedback with source
  quote, mock exam, mock results review, readiness plan with review hints, practice
  picker, mobile).

### 2.3 Behavior specifics verified

- **No answer-key leakage** while a session is active (API-level assertions + tests).
- **First answer counts**: re-answering returns the stored grade; DB UNIQUE constraint.
- **Mock exams hide correctness** until submission (`grade: null` during the exam).
- **Grounding**: every question/concept evidence quote is verified against the source by
  deterministic validation; fabricated quotes are rejected (tests).
- **Injection resistance**: a document containing "Ignore all previous instructions…"
  still yields clean study content; instruction-like sentences are excluded from concepts
  and evidence; the user sees an honest notice (tests + probe).
- **Provider fallback**: unreachable GLM endpoint → demo output with a visible notice
  (test).
- **Persistence**: close/reopen over the same SQLite file retains courses, attempts,
  mastery (integration test re-attaches the DB file).
- **Determinism**: identical material → identical concept names, prompts, and answer
  keys across runs (test).

## 3. Commands for a reviewer

```bash
npm install
npm run dev            # → http://localhost:3000, click "Load bundled demo material"
npm test               # 68 unit/integration tests
npm run test:e2e       # Playwright journey (auto-starts a dev server)
npm run typecheck && npm run lint && npm run build
```

## 4. Architecture summary

Next.js 15 App Router + TypeScript monolith. Domain modules under `src/lib`
(extraction, generation, validation, grading, mastery, readiness, sampling, ingestion,
persistence) are UI-free and fully unit-tested. Providers implement
`MaterialProvider`; the registry prefers GLM when configured and falls back to the
deterministic demo provider on any failure. Persistence is a single SQLite file via
`node:sqlite` (no native deps), gitignored under `.data/`. Details in
[ARCHITECTURE.md](ARCHITECTURE.md).

## 5. Limitations (known, intentional)

1. Demo-provider questions are definition-centric; material without "X is …" patterns
   yields fewer questions (with honest notes — never fabricated filler).
2. Readiness/mastery are internal heuristics over this app's answers only.
3. PDF OCR is not supported; scanned PDFs produce an explicit message.
4. Single local learner; no accounts/auth (P1 per AGENTS.md).
5. The GLM adapter is implemented and unit-tested for mapping/failure/fallback but has
   not been exercised against a live paid endpoint.
6. Evidence quotes are whitespace-normalized matches; exotic ligatures/OCR noise can
   defeat exact grounding and drop questions (fail-closed by design).
7. Distractors reuse other concepts' definition clauses — for materials with very
   similar definitions the ambiguity guard drops such MCQs (fewer questions rather than
   ambiguous ones).

## 6. Next 20 highest-value tasks

1. Cross-session duplicate detection (near-duplicate prompts across different sessions).
2. "Review today" queue page driven by `nextReviewInDays`.
3. Concept-map view (relationships only when the material states them).
4. Course export/import (single-file archive of material + progress).
5. Live-endpoint test harness for the GLM adapter (recorded fixtures + contract test).
6. Streaming provider progress ("extracting concepts…" → "writing questions…") in the UI.
7. Question flags ("ambiguous", "too easy") feeding a local review list.
8. Per-question difficulty calibration from real attempt data.
9. Keyboard-only session flow audit + focus management in SessionRunner.
10. Diagnostic length setting (5/8/12 questions) with coverage warnings.
11. Mock exam blueprint option ("weight these topics higher").
12. PDF layout-aware extraction quality scoring (report confidence per page).
13. Optional server-side embedding search for evidence selection (pluggable, off by
    default).
14. Spaced-review persistence (`next_review_at` column + due list ordering).
15. Accessibility pass (aria-live for feedback, contrast audit, screen-reader labels).
16. i18n scaffolding (extraction currently assumes English definitional patterns).
17. Playwright test for paste + PDF ingestion paths through the real UI.
18. Performance: generate questions in a worker for very large materials.
19. `.env` validation at boot with actionable errors (zod-based env schema).
20. Demo GIF for README (scripted Playwright capture → GIF).

## 7. Readiness assessments

- **Local demo: ready.** `npm install && npm run dev` → full loop works keyless; DB is
  pristine (first-run empty state visible).
- **GitHub launch: ready** after a repo description/topics; README claims match
  verified behavior; no secrets or private material in the tree; `.data/` and `.env`
  gitignored.
- **Public deployment: mostly ready, with caveats.** The app is single-user local by
  design; a public host would need auth (out of P0 scope), a persistent-disk SQLite
  story, and honest tos/privacy copy. No server hardening or rate limiting has been
  implemented.
- **Paid-product development: not started (by design).** No billing, no multi-tenant
  data model, no admin tooling. The provider abstraction and validation gates are the
  right foundation, but everything commercial remains future work.
