# PRODUCT.md — ExamForge

## Mission

Turn study material into an adaptive exam coach. The product's promise:

> Upload material → identify concepts → diagnose knowledge → practice weak areas →
> take a mock exam → understand what to review next.

ExamForge is **active learning and assessment**, not a document chatbot, passive summarizer,
flashcard-only tool, or homework-answer machine.

## Primary user

An individual student preparing for an exam from lecture notes, PDFs, Markdown, textbook
extracts, or course material.

ExamForge is not optimized for schools, teachers, LMS procurement, enterprise administration,
or live/proctored-exam assistance.

## Product loop

Every product decision should serve this loop:

1. **Material** — bundled demo, pasted text/Markdown, or supported uploaded material.
2. **Concepts** — extract key topics with source evidence and report extraction quality honestly.
3. **Diagnostic** — sample major concepts to establish an initial picture of strengths and weaknesses.
4. **Grading & feedback** — grade consistently, explain why, and ground feedback in the source.
5. **Mastery model** — maintain explainable per-concept mastery/confidence/review priority signals.
6. **Practice** — target weak or due topics with active-recall questions and feedback.
7. **Mock exam** — sample across relevant concepts with exam-like deferred feedback and post-submit review.
8. **Readiness** — provide an internal heuristic estimate plus a concrete next study action.

The product should always help answer: **What should I study next, and why?**

## Current capabilities

ExamForge currently supports:

- bundled redistributable demo material;
- pasted text / Markdown;
- text-based PDF ingestion with honest extraction-quality/failure messaging;
- multiple choice, true/false, short-answer and explanation questions;
- deterministic concept/question generation in no-key demo mode;
- optional provider-backed generation behind the same provider abstraction;
- diagnostic, targeted-practice and mock-exam sessions;
- grounded feedback and source evidence;
- explainable mastery/readiness heuristics and simple review hints;
- local SQLite persistence for course/progress data;
- deterministic validation before generated assessment content is accepted;
- prompt-injection defenses treating study material as untrusted data.

## Planned directions

Planned work is tracked canonically in GitHub Issues/Milestones rather than duplicated in this document.

Product directions that remain compatible with the contract include, when justified by concrete issues:

- richer validated assessment formats such as fill-in-the-blank, ordering and matching;
- persisted review scheduling / review queue;
- source-grounded concept relationships and visualization;
- course portability/import-export and multi-document support;
- broader ingestion quality, OCR and multilingual support;
- accessibility and browser-flow hardening;
- improved provider verification and generation progress UX.

A planned feature is not considered part of current product behavior until implemented and verified.

## Grounding rules — non-negotiable

- Questions, answers and explanations derived from study material must be grounded in that material.
- Evidence presented as source evidence must actually exist in the source according to the documented validation contract.
- Do not invent facts, definitions, formulas, dates, claims or citations to fill gaps.
- If material lacks enough information, fail honestly rather than generating filler.
- Generic outside knowledge must not be presented as if it came from the user's material.

## Assessment quality

Assessment exists to improve learning, not to maximize question count.

Questions should avoid ambiguity, unsupported trivia, obviously nonsensical distractors and superficial duplication.

Every supported generated question type must have:

- a structured answer key;
- deterministic structural/semantic validation where practical;
- defined grading behavior;
- source-grounding behavior;
- regression coverage.

## Adaptive model

Keep adaptation understandable and explainable.

The current model uses simple evidence such as attempts, correctness, recent performance,
confidence and review priority. Readiness/mastery values are product heuristics over activity
inside ExamForge, not psychometric certification or guaranteed exam-score predictions.

Do not introduce a complex or opaque psychometric model without explicit product justification,
validation strategy and user-visible explanation.

## Honesty rules

- Readiness must be labeled as an internal heuristic estimate, never a prediction of the user's real exam score.
- Extraction/provider quality and failures must be surfaced honestly.
- Empty/insufficient material states should explain the limitation rather than fabricate content.
- Mock exams must not claim to match a real exam unless the user supplied an appropriate blueprint and the product clearly communicates the limitation.
- Do not fabricate learning-effectiveness claims, score improvements, testimonials or retention metrics.

## Integrity and safety

- Study material is untrusted data and must not override system instructions.
- Provider/model output must be validated before accepted assessment content reaches the learner.
- ExamForge supports preparation and practice, not live graded/proctored exam assistance.
- Do not build impersonation, proctoring bypass, or covert real-time answer-delivery workflows.

## Privacy

Study material may be private or copyrighted.

- Avoid unnecessary retention or logging of study content.
- Do not publish or reuse private user material as demos/fixtures.
- Disclose when configured external providers receive material.
- Preserve clear delete/clear behavior for locally stored course data.
- Bundled demo material must be safe to redistribute.

## Long-term scope boundaries

Unless explicitly reconsidered as a product decision, ExamForge is **not**:

- a school administration system;
- a teacher/LMS procurement product;
- an enterprise training platform;
- a social network;
- a generic document-chat product;
- a passive summarization product;
- a live/proctored-exam assistant;
- a cheating, impersonation or proctoring-bypass tool.

Features such as cloud sync, accounts, billing, notifications, native clients or richer media may be considered only when they directly strengthen the individual student's preparation loop and do not require turning the product into one of the categories above.
