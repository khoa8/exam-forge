# PRODUCT.md — ExamForge

## Mission

Turn study material into an adaptive exam coach. The product's promise:

> Upload material → identify concepts → diagnose knowledge → practice weak areas →
> take a mock exam → understand what to review next.

ExamForge is **active learning and assessment**, not a document chatbot, summarizer, or
flashcard generator.

## Primary user

An individual student preparing for an exam from lecture notes, PDFs, Markdown, textbook
extracts, or course material. Not schools, teachers, LMS buyers, or enterprises.

## The loop

Every design decision serves this loop:

1. **Material** — bundled demo, pasted text/Markdown, or text-based PDF.
2. **Concepts** — deterministic extraction with source-evidence quotes; quality is
   reported honestly (good/fair/poor).
3. **Diagnostic** — one question per major concept (max 8); calibrates strong vs weak.
4. **Grading & feedback** — deterministic; every wrong answer explains why, quotes the
   source, and states the model answer.
5. **Mastery model** — recency-weighted mastery (0..1) + confidence + review priority per
   concept; statuses weak / developing / strong / untested.
6. **Practice** — targeted sets for a chosen (usually weakest) topic; includes open
   explanation questions graded by key-idea coverage with partial credit.
7. **Mock exam** — balanced sampling across concepts, exam-like deferred feedback, full
   post-submission review.
8. **Readiness** — internal heuristic estimate (0–100%), coverage of the material, an
   ordered "what to study next" plan, and simple spaced-review hints. Clearly labeled as
   a heuristic, never an exam-score prediction.

## Question types

P0 (shipped): multiple choice, true/false, short answer, explanation.
P1 (later): fill-in-the-blank variants beyond the current short-answer blank style,
ordering, matching, oral questions.

Every question carries: an answer key, a grounded explanation, and an evidence quote from
the source material.

## Grounding rules (non-negotiable)

- Questions, answers, and explanations derive from the user's material.
- Evidence quotes must exist verbatim (whitespace-normalized) in the source; this is
  enforced by deterministic validation, not trust.
- Nothing is invented. If the material lacks content, ExamForge says so rather than
  padding.
- Generic outside knowledge is not mixed in.

## Adaptive model (simple on purpose)

- Mastery = blend of Laplace-smooled cumulative accuracy and recency-weighted recent
  accuracy (last 5 attempts weigh more).
- Confidence grows with attempts (n/6, capped).
- Review priority = (1 − mastery) + importance + staleness, capped at 1.
- Next-review hint: weak → today, developing → 2 days, strong → 7 days.

No psychometric engine (no IRT/ELO); every number is explainable to a student.

## Honesty rules

- Readiness is labeled "internal heuristic estimate — not a prediction of your real exam
  score" everywhere it appears.
- Extraction quality is reported (good/fair/poor) with explanations.
- Empty states explain why ("material too short or unstructured…") instead of failing.
- Mock exams never claim to match a real exam unless the user supplied a blueprint.

## Integrity & safety

- Material is untrusted data: prompt-injection patterns are filtered out of concept and
  question sources; LLM prompts wrap material in nonce-delimited untrusted blocks.
- The product supports preparation only — no live-exam assistance, no impersonation.

## Privacy

- Local-only persistence (SQLite file). Deleting a course deletes its material and
  progress. The bundled demo material is original and redistributable.

## Out of scope (MVP)

School admin, teacher dashboards, LMS integration, billing, social features, badges,
native apps, voice tutor.
