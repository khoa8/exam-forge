# ARCHITECTURE.md — ExamForge

A modular monolith: Next.js 15 (App Router) + TypeScript + SQLite (`node:sqlite`).
Everything runs in one process; module boundaries keep the learning-loop logic testable
without a browser or server.

## Module map

```
src/
├── lib/
│   ├── types.ts        # Domain contracts (Concept, Question, MasteryState, …)
│   ├── schemas.ts      # Zod schemas validating all generated content
│   ├── extract.ts      # Deterministic concept extraction (headings, definitions,
│   │                   #   bold terms, capitalized phrases) + grounding checks
│   ├── generate.ts     # Deterministic question generation from definitions
│   ├── validate.ts     # Validation gates: required fields, option membership,
│   │                   #   duplicates, ambiguity, evidence grounding
│   ├── grade.ts        # Deterministic grading (incl. key-term coverage scoring)
│   ├── mastery.ts      # Recency-weighted mastery + spaced-review hints
│   ├── readiness.ts    # Readiness aggregation + next-action computation
│   ├── sampler.ts      # Balanced session sampling (diagnostic/practice/mock)
│   ├── ingest.ts       # Text/PDF ingestion with honest quality warnings
│   ├── db.ts           # SQLite persistence (node:sqlite, WAL), schema migrations
│   ├── service.ts      # Orchestration: courses, sessions, answers, views
│   ├── util.ts         # Seeded RNG, normalization, similarity metrics
│   └── provider/
│       ├── index.ts    # MaterialProvider interface + ProviderError
│       ├── demo.ts     # Deterministic demo provider (no key, no network)
│       ├── glm.ts      # Optional GLM adapter (OpenAI-compatible HTTP)
│       ├── registry.ts # Provider selection + automatic fallback
│       └── sanitize.ts # Prompt-injection detection, filtering, untrusted wrapping
├── app/                # Next.js routes (pages + REST API under /api)
├── components/         # Stepper, MasteryBar, SessionRunner, RunnerGate
└── sample/material.ts  # Bundled original demo material
```

## Data flow (learning loop)

```
material text
   │ ingest.ts (normalize / PDF extract / quality warnings)
   ▼
provider.generate()                      ── demo.ts (deterministic) or glm.ts (LLM)
   │ extract concepts → generate questions → validate (schemas + grounding + duplicates)
   ▼
db.insertCourse()  (courses, concepts, questions)
   │
   ▼
startSession(kind)  ── sampler.ts balances across concepts
   │
   ▼
answerQuestion()  ── grade.ts (deterministic) → db.insertAttempt()
   │                   first answer counts (UNIQUE(session,question))
   ▼
finishSession()  → per-concept summary + full review (with answer keys)
   │
   ▼
getCourseOverview() ── mastery.ts + readiness.ts → readiness %, weak/strong, next action
```

## Key invariants

1. **No answer key reaches the client while a session is active** — `service.ts` strips
   `correctOptionId`, `correctAnswer`, `acceptedAnswers`, `keyTerms`, `modelAnswer`, and
   `explanation` from every question sent to the browser (tested).
2. **First answer counts** — enforced by a SQLite UNIQUE constraint; retries cannot
   improve a score.
3. **Mock exams hide correctness until submission** — the API returns `grade: null`
   during mock sessions (tested).
4. **Every generated question passes deterministic validation** — schema membership,
   exactly-one-correct-option, option-id uniqueness, near-duplicate prompts, and an
   ambiguity guard (correct answer ≈ distractor).
5. **Exact grounding and answer provenance (deterministic, fail-closed)** —
   `extract.ts::quoteIsGrounded` accepts an evidence quote only when its normalized form
   is a contiguous substring of the normalized source; there is no prefix/partial
   fallback, so a real prefix can never legitimize a fabricated suffix. Additionally,
   every answer-bearing field must be proven from the source: MCQ correct option text
   (`isSourceSpan` containment), true/false statements keyed true (verbatim span; a
   statement keyed false must NOT be verbatim, otherwise the key contradicts the
   material), short accepted/model answers (source spans), explanation model answers
   (source span) and key terms (derivable from source words by normalized containment or
   stemming), and learner-facing explanations (must quote a grounded evidence quote).
   The GLM adapter constructs explanations deterministically from the validated evidence
   quote and never passes model-written explanation prose to the learner. Unsupported
   candidates are dropped, never repaired; if fewer than 3 questions survive a provider
   falls back or fails per the provider-mode contract (tested).
6. **Injection-filtered extraction** — sentences matching instruction patterns never
   become concepts or evidence quotes (tested with an injected fixture).
7. **Provider independence** — the GLM adapter can fail arbitrarily; the registry falls
   back to the demo provider with a visible notice when the mode allows fallback (tested).

## Persistence

Single SQLite file (`.data/examforge.sqlite`, override with `EXAMFORGE_DB_PATH`), via
Node's built-in `node:sqlite` — no native dependencies. Tables: `courses`, `concepts`,
`questions`, `sessions`, `attempts` (cascade deletes; deleting a course removes all
derived data). WAL mode for concurrent dev-server reads.

## Local network boundary

ExamForge is a local, single-user application with no auth layer, so the normal dev and
production entrypoints (`npm run dev`, `npm start`) bind the HTTP server to loopback
(`127.0.0.1`) by default. The app is not reachable from other machines unless a user
deliberately overrides the host. There is no account/auth subsystem; the loopback default
plus local SQLite is the privacy boundary. `/api/health` returns only `{ ok: true }` — no
local paths, provider configuration details or material-derived data.

## Provider abstraction

`MaterialProvider.generate(text, sourceType) → ProviderOutput`. Selection order:
`EXAMFORGE_PROVIDER=glm|demo|auto` (auto = GLM if a key exists, else demo). Forced `glm`
is an explicit contract: when GLM is unavailable or its output is rejected, the request
fails loudly instead of silently substituting demo content; `auto` treats GLM as
best-effort and falls back to the demo provider with a visible notice. GLM output is
parsed from a JSON block, remapped (concepts, answers and explanations provenance-checked
per the key invariants above), validated with the same gates as demo output, and rejected
(→ fallback in `auto`, error in forced `glm`) if fewer than 3 grounded concepts/questions
survive.

## Testing strategy

- **Unit** (`tests/unit`): extraction, schemas, validation gates, grading, mastery,
  readiness, sampling, ingestion (incl. generated PDF fixtures), injection, provider
  fallback.
- **Integration** (`tests/integration`): full bundled-demo flow over the real service
  layer + scratch SQLite file — diagnostic → weak topics → practice → mock → readiness →
  persistence, plus lock/consistency rules.
- **E2E** (`tests/e2e/smoke.spec.ts`): the same journey through the real UI with
  Playwright against a live server.

## UI structure

Five course pages map to the stepper (`Material → Diagnostic → Practice → Mock Exam →
Readiness`); a shared `SessionRunner` renders all three session kinds (immediate feedback
for diagnostic/practice, deferred for mock). The dashboard always shows a computed
"next study action" so the user always knows what to do next.
