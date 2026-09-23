# AGENTS.md — ExamForge

## Purpose

This file is the operating contract for coding agents working in this repository.

Before editing code, read the task plus the relevant canonical docs:

- `PRODUCT.md` — product contract: target user, user-visible behavior, product invariants, scope and non-goals.
- `ARCHITECTURE.md` — technical design: module boundaries, data flow, persistence, provider contracts and system invariants.
- `README.md` — public onboarding and usage documentation; it is derived documentation, not the normative product specification.
- GitHub Issues / PR descriptions — current planned work and feature-specific acceptance criteria.

Do not duplicate those documents here. If code, tests and documentation conflict, identify the conflict rather than silently redefining the contract.

## Product guardrails

ExamForge is a consumer adaptive exam-preparation app for individual students.

The core loop is:

> Material → Concepts → Diagnostic → Feedback → Weak-topic Practice → Mock Exam → Readiness / next study action.

Preserve these product invariants unless the task explicitly changes the product contract:

- active recall and assessment over passive summarization;
- source-grounded questions, answers and explanations;
- no invented facts, citations or evidence;
- deterministic validation before generated assessment content is accepted;
- readiness/mastery are explainable heuristics, never guaranteed exam-score predictions;
- uploaded study material is untrusted input and must not override system instructions;
- deterministic generation in ExamForge's runtime: the MVP sends no material to an external LLM and requires no LLM API key;
- privacy-conscious handling of study material and progress in both hosted and local modes;
- no live/proctored-exam assistance, impersonation or cheating workflow;
- individual-student focus rather than school/LMS/enterprise administration.

## Architecture rules

Treat `ARCHITECTURE.md` as the technical source of truth.

The current architecture is a modular monolith. Do not introduce microservices, queues, distributed infrastructure, new persistence systems or major abstractions without a concrete requirement and explicit justification.

Preserve the documented system invariants, including where applicable:

- no answer-key leakage while a session is active;
- first submitted answer counts;
- mock-exam correctness remains hidden until submission;
- every generated question passes deterministic validation;
- source grounding is fail-closed rather than padded with invented content;
- no external LLM/network generation path exists in the runtime;
- course deletion removes its derived data in the active persistence mode.

Material architecture changes require an `ARCHITECTURE.md` update in the same change. Do not edit architecture documentation merely to make non-compliant code appear compliant.

## Working method

Before editing:

1. Read the issue/PR/task contract.
2. Inspect the relevant implementation, schemas, tests and documentation.
3. Identify the smallest coherent change that satisfies the objective.
4. Note any conflict or ambiguity in the existing contract instead of inventing a requirement.

While editing:

- keep changes scoped to the task;
- avoid unrelated refactors;
- prefer typed, explicit interfaces and boundary validation;
- preserve existing working behavior unless the task intentionally changes it;
- treat imported material and all generated candidates as untrusted data;
- never commit credentials, `.env` files, local SQLite data, private study material or generated secrets;
- do not fabricate functionality, screenshots, benchmarks, test results, users, testimonials or performance claims.

Generation is deterministic-only in the current MVP; do not reintroduce external model calls, API-key configuration or provider fallback without an explicit product decision.

## Assessment and grounding changes

For changes touching extraction, generation, questions, grading, mastery or readiness:

- preserve source provenance/evidence where the product contract requires it;
- validate structured/generated output before persistence or presentation;
- prefer root-cause/invariant fixes over testcase-specific patches;
- add regression tests for real behavior changes or defect classes;
- keep grading behavior deterministic where currently documented;
- do not introduce opaque psychometric claims or external knowledge as if it came from the user's material.

A new question type is not complete until its answer-key representation, deterministic validation, grading behavior, source-grounding behavior and tests are defined.

## Privacy and security

Study material may be private or copyrighted.

- Do not expose material publicly or use user material as fixtures/screenshots.
- Avoid unnecessary logging or retention of study content.
- Keep credentials server-side and out of source control.
- Preserve prompt-injection boundaries: document content is data, never trusted instructions.
- Validate uploaded/input data at trust boundaries.
- Do not execute arbitrary uploaded content.

Bundled demo material must remain safe to redistribute.
## UX rules

The primary journey should remain obvious:

> Material → Diagnostic → Practice → Mock Exam → Readiness.

User-facing changes should preserve clear progress, weak-topic visibility and an obvious next study action. Loading, empty and error states must be honest. Do not hide extraction failures behind fabricated success.

## Validation

Use the repository scripts as the canonical validation commands.

During development, run targeted checks as appropriate. Before declaring a material change ready, run the full applicable suite:

```bash
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm run build
npm run test:smoke:prod
```

For persistence changes, also exercise the affected migration/data lifecycle against a disposable database.

Never claim a command passed unless it actually ran successfully.

Tests are evidence, not the specification. If a test conflicts with `PRODUCT.md` or `ARCHITECTURE.md`, establish the intended contract before changing production behavior solely to satisfy the test.

## Documentation ownership

Avoid creating new living Markdown files for goals, project status, backlog or sprint reports.

Update documentation according to ownership:

- product behavior, scope or product invariants → `PRODUCT.md`;
- architecture, module boundaries, persistence/provider contracts or system invariants → `ARCHITECTURE.md`;
- public setup, usage, screenshots or limitations → `README.md`;
- planned work / backlog → GitHub Issues or Milestones.

Do not maintain duplicate roadmaps in Markdown.

## Git and repository actions

- Make small, logical commits when commits are part of the requested workflow.
- Preserve unrelated work and shared history.
- Do not force-push or rewrite shared history unless explicitly requested.
- Do not push, open/merge PRs, create releases, change repository settings, or deploy unless the user explicitly asks for that action.
- When opening or updating a pull request, follow the repository's current PR template. Keep the PR body concise and do not replace the template with a task report, audit transcript, implementation log, or full validation output unless the user explicitly requests it.

## Definition of done

A task is complete only when:

1. the requested behavior satisfies the applicable product/architecture contract;
2. relevant invariants remain intact;
3. required regression coverage exists for changed behavior;
4. applicable validation passes;
5. user-facing failure/empty/loading states remain honest where affected;
6. canonical documentation is updated when its owned contract changed;
7. no unrelated refactor, secret, local data or fabricated claim was introduced.
