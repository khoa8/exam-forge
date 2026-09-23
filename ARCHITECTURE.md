# ARCHITECTURE.md — ExamForge

ExamForge has two deployment entrypoints over shared deterministic learning modules:

- **Hosted beta:** Vite-built React assets on Cloudflare Workers Static Assets;
  Supabase Auth creates anonymous browser identities; one Supabase Edge Function runs
  the assessment service over learner-owned Supabase Postgres data.
- **Local:** Next.js 15 App Router and `node:sqlite` on loopback. This remains useful
  for offline development and single-user use.

The domain/service modules remain a modular monolith. The hosted Edge Function is one
server boundary for the existing service rules, not a second implementation of them.

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
│   ├── hosted-db.ts    # Owner-scoped Postgres access for the hosted service
│   ├── hosted-service.ts # Async orchestration using shared assessment modules
│   ├── presentation.ts # Shared answer-key stripping and summaries
│   ├── api-client.ts   # Hosted authenticated API / local same-origin transport
│   ├── util.ts         # Seeded RNG, normalization, similarity metrics
│   └── provider/
│       ├── deterministic.ts # The only generation path: deterministic concept +
│       │                    #   question generation from the material (no model,
│       │                    #   no network, no API key)
│       └── sanitize.ts      # Untrusted-material filtering: instruction-like
│                            #   content detection for extraction/validation
├── app/                # Next.js routes (pages + REST API under /api)
├── hosted/             # Vite browser entry, anonymous auth gate, route shims
├── components/         # Stepper, MasteryBar, SessionRunner, RunnerGate
└── sample/material.ts  # Bundled original demo material

supabase/functions/examforge/  # Single authenticated hosted API boundary
supabase/migrations/           # Postgres schema, constraints and server-only RPCs
wrangler.jsonc                 # Cloudflare static-asset deployment
```

## Data flow (learning loop)

```
material text
   │ ingest.ts (normalize / PDF extract / quality warnings)
   ▼
deterministic generation (provider/deterministic.ts)
   │ extract concepts → generate questions → validate (schemas + grounding + duplicates)
   ▼
course acceptance gate (assessment viability: ≥3 validated questions, ≥1 diagnostic-eligible)
   │
   ▼
atomic insertCourse()  (courses, concepts, questions)
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

1. **No answer key reaches the client while a session is active** — shared `presentation.ts` strips
   `correctOptionId`, `correctAnswer`, `acceptedAnswers`, `keyTerms`, `modelAnswer`, and
   `explanation` from every question sent to the browser (tested).
2. **First answer counts** — enforced by a unique `(session_id, question_id)`
   constraint in both databases; Postgres serializes answer and finish transitions
   with a session row lock. Retries cannot improve a score.
3. **Mock exams hide correctness until submission** — the API returns `grade: null`
   during mock sessions (tested). That protection belongs to the mock's *questions*, not
   to the mock's own response: while a mock is unsubmitted, no other session in the same
   course may grade those questions or disclose their correctness, answer key,
   explanation or answer-equivalent topic — whether that other session is a concurrent
   Diagnostic/Practice session or a session that already answered the same persisted
   question. Such views report the withheld questions and withhold the session summary,
   which aggregates correctness; answering one through another session is rejected with a
   `409` conflict. Course-level signals follow the same rule: attempts for protected
   questions are excluded from every learner-visible derivative (mastery, status,
   confidence, review priority, weak/strong/untested classification, next action and
   practice target selection) so the aggregate cannot become a correctness oracle, while
   the stored attempts are untouched and count normally again once the mock is submitted.
   At most one mock exam may be active per course — a second mock would protect the same
   deterministic question set and withhold the first mock's post-submit review, so
   `startSession` rejects it with a `409` conflict while Diagnostic/Practice coexistence
   stays allowed. Hosted Postgres also enforces this with a partial unique index and
   serializes mock starts with submissions using a course advisory lock.
   Hosted overview, practice targeting, and completed-session views derive
   session status, protected question IDs, and dependent attempts from one
   `ef_course_state` SQL statement. Postgres gives that statement one MVCC
   snapshot; a response can linearize before or after a concurrent mock
   transition, but cannot mix its protection and attempt states. Course
   concepts and questions are immutable after creation, so they can be read
   separately. Automatic practice targeting sends the snapshot's active-mock
   ID to `ef_start_practice_session`; under the course advisory lock it checks
   that identity again before inserting. If a mock started or changed between
   target selection and insertion, the server reselects from a fresh snapshot
   or returns a conflict without creating a session. Grading and readiness
   remain in TypeScript.
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
   dropped, never repaired. Course acceptance is gated on assessment viability before
   persistence: at least 3 validated questions AND at least one question eligible for
   the Diagnostic flow under the real sampling rules (auto-gradable types) are required,
   otherwise course creation fails honestly with a controlled error instead of padding
   with filler (tested).
6. **Injection-filtered extraction** — instruction-like content can never become a
   concept candidate via headings, bold terms, definition sentences or repeated
   capitalized phrases, and instruction-like candidate fields are rejected at the
   trust boundary (tested with injected fixtures).
7. **Deterministic-only generation** — there is exactly one generation path
   (`provider/deterministic.ts`); no external LLM, network call, API-key configuration
   or provider fallback exists in the runtime. Stale provider environment variables are
   inert, and generation makes no outbound requests (tested).

## Hosted persistence and security boundary

The browser holds a Supabase anonymous session in site storage. The public Supabase
publishable key and Cloudflare Turnstile site key are browser configuration, never
authorization. First visits solve Turnstile, then Supabase Auth issues an anonymous
JWT; the same browser reuses its session. The Edge Function verifies each bearer JWT
with Supabase Auth before instantiating `HostedDb` for that user's ID. Personalized
responses use `private, no-store`, and the Cloudflare deployment serves only static
assets; no personalized content is cached there.

Postgres tables `ef_courses`, `ef_concepts`, `ef_questions`, `ef_sessions`, and
`ef_attempts` hold hosted study state. Courses have an `owner_id` referencing
`auth.users`; all child rows derive ownership through the course foreign key.
Every public ID path in `HostedDb` checks course ownership before privileged reads or
writes. The Supabase secret key exists only in the Edge Function secret store and is
used to call PostgREST as the service role. It is absent from browser bundles and Git.

RLS is enabled on all hosted tables. Authenticated learners have no direct table
or server RPC grants; even course material and concepts are read through the
owner-scoped Edge Function. The answer-bearing question payload is server-only.
The service role bypasses RLS, so its API boundary performs explicit owner checks.
Untrusted request bodies are validated before service calls, and question candidates
pass the same deterministic validation as the local mode.

`ef_create_course` inserts the course, concepts, and questions in one transaction and
serializes the ten-course quota per owner. A separate per-owner row lock limits course
generation attempts to five per hour, including failed material. `ef_start_session`
serializes course mock starts with `ef_submit_attempt`; a partial unique index prevents
two active mocks. `ef_submit_attempt` locks the session and uses a unique attempt key
for first-answer semantics; `ef_finish_session` locks the session for safe completion.
Foreign keys cascade course deletion through all derived state. Session ordering uses
creation timestamp plus a generated sequence as a deterministic tie-breaker.

The hosted persisted-state budget is enforced at the API and database boundaries.
`ef_start_session` serializes a 100-session limit per course and accepts at most
eight question IDs per session. Thus normal hosted APIs can persist at most 800
attempts per course; the unique attempt key can only reduce that count. Answer
requests must match the question type and, for MCQ, an actual option ID. The
hosted request schema limits written answers to 2,000 characters and option IDs
to 64 characters; `ef_submit_attempt` independently validates shape, type,
length and option membership. A table constraint limits serialized answer JSON
to 8,192 bytes even for privileged direct writes. A rejected answer/session
creates no partial row, and reaching the session limit returns an explicit
conflict without deleting study history. The ten-course owner limit also bounds
this progress state per anonymous identity, apart from already bounded course
material and its generated questions.

Anonymous signup requires Cloudflare Turnstile and Supabase's per-IP signup limit.
Request bodies are capped at 500 KB; material is capped at 200,000 characters, PDFs
at 20 MB in the browser, and each anonymous identity at ten courses. The hosted beta
has no account recovery or backup; clearing site data can strand stored courses.
The Edge Function does not log material, answer keys, answers, or evidence quotes.

## Local persistence

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

The optional local mode is single-user with no auth layer, so its dev and production
entrypoints (`npm run dev`, `npm start`) bind the HTTP server to loopback
(`127.0.0.1`) by default. The app is not reachable from other machines unless a user
deliberately overrides the host. Local SQLite plus the loopback default is its
privacy boundary. Both hosted and local `/api/health` return only `{ ok: true }`.

## Deterministic generation

Generation is deterministic in both entrypoints — the MVP has **no external LLM runtime path, no
API-key configuration and no provider fallback**. `provider/deterministic.ts` exposes one
synchronous entry point, `generateDeterministic(text) → ProviderOutput`, which runs
extraction → question generation → canonical validation in-process (on the hosted Edge
Function or local Next server). The same input always produces the same output.

Text-based PDF extraction runs in the hosted browser with `unpdf`, then sends extracted
text over HTTPS to the hosted API. The original PDF is not stored by ExamForge. This
placement follows runtime probes: Cloudflare Workers Free's short CPU allowance did
not fit representative deterministic generation, and a large PDF exhausted the
Supabase Edge Function runtime. The hosted browser can report scanned/no-text PDFs
honestly without sending full PDF bytes to the server.

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
- **Hosted beta:** focused service tests, SQL migration/RLS/constraint probes with
  disposable authenticated identities, and an anonymous browser journey on the deployed Cloudflare
  URL. These verify the separate Auth, Postgres and Edge Function boundaries that local
  SQLite tests cannot prove.

## UI structure

Five course pages map to the stepper (`Material → Diagnostic → Practice → Mock Exam →
Readiness`); a shared `SessionRunner` renders all three session kinds (immediate feedback
for diagnostic/practice, deferred for mock). The dashboard always shows a computed
"next study action" so the user always knows what to do next. Hosted Vite routing
reuses the same page components and shared client API functions; local Next.js keeps
its App Router and same-origin API handlers.
