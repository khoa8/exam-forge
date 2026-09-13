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
│       ├── deterministic.ts # The only generation path: deterministic concept +
│       │                    #   question generation from the material (no model,
│       │                    #   no network, no API key)
│       └── sanitize.ts      # Untrusted-material filtering: instruction-like
│                            #   content detection for extraction/validation
├── app/                # Next.js routes (pages + REST API under /api)
├── components/         # Stepper, MasteryBar, SessionRunner, RunnerGate
└── sample/material.ts  # Bundled original demo material
```

## Data flow (learning loop)

```
material text
   │ ingest.ts (normalize / PDF extract / quality warnings)
   ▼
deterministic generation (provider/deterministic.ts)
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
4. **Generated content crosses one shared trust boundary** — every candidate goes
   through `validateQuestionSet`, which first parses it against the canonical zod
   schemas (runtime validation, not TypeScript casts) and then applies the semantic
   gates: exactly-one-correct-option, option-id/text uniqueness, near-duplicate prompts,
   and an ambiguity guard (correct answer ≈ distractor). Concepts are gated by
   `validateConcept` plus `validateConceptProvenance`.
5. **Exact grounding and per-field provenance (deterministic, fail-closed)** —
   `extract.ts::quoteIsGrounded` accepts an evidence quote only when its normalized form
   is a token-bounded contiguous span of the normalized source; there is no prefix/partial
   fallback, and a span that only occurs inside a larger word is not grounded. Evidence,
   statements and concept fields that match instruction patterns are rejected even when
   the text genuinely appears in the uploaded material (untrusted instruction data is not
   evidence). Provenance relationships are validated **independently per field — a valid
   sibling field can never launder a cross-wired one**: a concept's description and each
   of its evidence quotes must each support the concept on their own (the concept name is
   a token-bounded span of each); a question's evidence must belong to the question's
   concept (a span of the concept's validated description/evidence, or a quote that names
   the concept — a real sentence about another concept in the same document is not
   evidence); and answer-bearing fields — MCQ correct options, true/false statements keyed
   true, short accepted/model answers, explanation model answers and grading terms — are
   proven from the question's own validated, concept-aligned evidence only, never from a
   union with concept fields. A statement keyed false is never proven false by mere
   absence of verbatim text: false candidates without a deterministic `falseProof`
   (source sentence + replaced subject) that validation re-derives are rejected. A
   concept without grounded, non-instruction, independently-supporting
   description/evidence content is dropped; no synthetic filler is created. Learner-facing
   explanations quote the question's validated evidence. Unsupported candidates are
   dropped, never repaired; if fewer than 3 questions survive, course creation fails
   honestly instead of padding with filler (tested).
6. **Injection-filtered extraction** — instruction-like content can never become a
   concept candidate via headings, bold terms, definition sentences or repeated
   capitalized phrases, and instruction-like candidate fields are rejected at the
   trust boundary (tested with injected fixtures).
7. **Deterministic-only generation** — there is exactly one generation path
   (`provider/deterministic.ts`); no external LLM, network call, API-key configuration
   or provider fallback exists in the runtime. Stale provider environment variables are
   inert, and generation makes no outbound requests (tested).

## Persistence

Single SQLite file (`.data/examforge.sqlite`, override with `EXAMFORGE_DB_PATH`), via
Node's built-in `node:sqlite` — no native dependencies. Tables: `courses`, `concepts`,
`questions`, `sessions`, `attempts` (cascade deletes; deleting a course removes all
derived data). WAL mode for concurrent dev-server reads.

Schema evolution is versioned with `PRAGMA user_version` and an ordered, append-only
migration list (`src/lib/db.ts`). On open, the schema version is checked BEFORE any
persistent database state is changed: a database written by a newer schema version is
refused with a clear error while the file remains byte-for-byte untouched (journal mode
included). New databases then apply all migrations once and are stamped at the current
version; existing databases migrate forward, one transaction per migration (schema change
+ version stamp commit atomically), so a failed migration rolls back fully and the
database stays honestly at its previous version. Applied migration entries are never
rewritten; there is no destructive reset in normal startup.

## Local network boundary

ExamForge is a local, single-user application with no auth layer, so the normal dev and
production entrypoints (`npm run dev`, `npm start`) bind the HTTP server to loopback
(`127.0.0.1`) by default. The app is not reachable from other machines unless a user
deliberately overrides the host. There is no account/auth subsystem; the loopback default
plus local SQLite is the privacy boundary. `/api/health` returns only `{ ok: true }` — no
local paths or material-derived data.

## Deterministic generation

Generation is deterministic and local — the MVP has **no external LLM runtime path, no
API-key configuration and no provider fallback**. `provider/deterministic.ts` exposes one
synchronous entry point, `generateDeterministic(text) → ProviderOutput`, which runs
extraction → question generation → canonical validation in-process. The same input always
produces the same output.

The `provider/` module boundary survives not as a provider framework (there is no
interface, registry, mode selection or fallback) but because it keeps the two
generation-adjacent trust concerns in one place: the deterministic generator itself, and
`sanitize.ts`'s instruction-like content filtering, which protects extraction and
validation from untrusted material regardless of how generation is implemented.

Answer-key authority is fully system-owned: every persisted answer key is produced by
deterministic source-grounded generation logic and passes the validation gates above.
There is no code path in which an external model chooses an answer key.

The `provider_used` / `provider_notice` columns remain in the `courses` table for schema
compatibility; new courses record `provider_used = "deterministic"` and a null notice, and
no domain type or UI surface reads them.

## Testing strategy

- **Unit** (`tests/unit`): extraction, schemas, validation gates, grading, mastery,
  readiness, sampling, ingestion (incl. generated PDF fixtures), injection, and the
  deterministic-only generation contract (stale provider env vars are inert; generation
  makes no network requests; output is deterministic and schema-valid).
- **Integration** (`tests/integration`): full bundled-demo flow over the real service
  layer + scratch SQLite file — diagnostic → weak topics → practice → mock → readiness →
  persistence, plus lock/consistency rules.
- **E2E** (`tests/e2e`): the bundled-demo journey through the real UI with Playwright
  against a loopback-only dev server on a dedicated port, using a disposable SQLite
  database (temp dir via `EXAMFORGE_DB_PATH`); generation is deterministic and local, so
  no keys or network are involved. Servers are never reused and real learner data is
  never touched. A separate production smoke suite
  (`playwright.prod-smoke.config.ts`, `npm run test:smoke:prod`) verifies the production
  build/start path with the same isolation rules.

## UI structure

Five course pages map to the stepper (`Material → Diagnostic → Practice → Mock Exam →
Readiness`); a shared `SessionRunner` renders all three session kinds (immediate feedback
for diagnostic/practice, deferred for mock). The dashboard always shows a computed
"next study action" so the user always knows what to do next.
