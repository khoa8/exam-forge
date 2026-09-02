# GOAL.md

## Autonomous sprint mode

This repository is being developed in an unattended, time-limited sprint.

Read `AGENTS.md` first. `AGENTS.md` is the repository's durable engineering contract.
Then read this file and use it as the current execution goal.

Work autonomously. Do not stop merely to ask what to do next when a safe, reasonable
next step can be inferred from `AGENTS.md`, this goal, the repository state, and test results.

### Safety boundaries for unattended execution

You MAY:
- read and modify files inside this repository;
- install normal project-local dependencies;
- run development servers, tests, linters, typecheckers, builds, and Playwright;
- create local fixtures, screenshots, docs, and Git commits when appropriate.

You MUST NOT:
- push to any remote;
- create a remote repository;
- deploy publicly;
- purchase anything or configure real billing;
- send email/messages;
- create external accounts;
- change system-wide settings;
- use `sudo`;
- modify SSH keys, credential stores, or files outside this repository;
- expose or commit secrets;
- delete unrelated user files;
- run destructive commands outside this repository.

If an external service or credential is unavailable, build a provider interface plus a
deterministic demo/mock path and continue.

### Time discipline

The sprint target is to use the remaining unattended window efficiently.

If local clock access is available:
- continue implementation and repair work until approximately 08:40 Asia/Ho_Chi_Minh;
- at ~08:40 stop starting major new features;
- use the final period for tests, build, UX inspection, cleanup, docs, screenshots, and final report;
- aim to leave the repository in a clean, resumable state before 09:00.

If clock access is unavailable, use milestone completion rather than waiting.

Never intentionally idle just to consume tokens.

### Autonomous loop

Repeat until the completion conditions are met or the sprint window ends:

1. Inspect `PROJECT_STATUS.md`, `TASKS.md`, tests, and current app behavior.
2. Select the highest-value unfinished P0 item.
3. Implement it.
4. Run targeted validation.
5. Fix failures.
6. Inspect the actual user-facing behavior.
7. Update `PROJECT_STATUS.md`.
8. Commit a logical local checkpoint when useful.
9. Continue with the next highest-value item.

When P0 is genuinely complete, continue with high-value P1 work.
Only do P2 work when P0 and important P1 work are stable.

Do not generate large amounts of speculative code or documentation simply to consume quota.

### Recovery behavior

If a command or approach fails:
- inspect the error;
- attempt a reasonable repair;
- try an alternative implementation when appropriate;
- document a real blocker only after practical local alternatives are exhausted.

Do not repeatedly retry the same failing action without changing the approach.

### Finalization

Before stopping:
- run all applicable lint/typecheck/test/build/e2e checks;
- verify the bundled demo;
- inspect the main UI;
- remove obvious debug artifacts;
- ensure README claims match reality;
- update `PROJECT_STATUS.md`;
- create/update `FINAL_REPORT.md` with exact validation results and next steps.


## Product goal — ExamForge

Deliver the strongest possible runnable consumer MVP of:

> **ExamForge — Turn study material into an adaptive exam coach.**

### P0 success criteria

Without a paid model key, a first-time user can:

1. open the app;
2. load bundled study material;
3. see extracted concepts;
4. take a short diagnostic quiz;
5. receive consistent grading and explanations;
6. see weak/strong topic estimates;
7. practice at least one weak topic;
8. take a short mock exam;
9. see a readiness/next-study dashboard;
10. have progress persist through the demo.

Questions and explanations must be grounded in the provided source material.

### Quality target

The product must feel like active exam preparation, not "chat with a PDF."

Prioritize:
- active recall;
- question quality;
- grading correctness;
- source grounding;
- obvious next action.

### High-value P1 after P0

Prioritize:
1. text-based PDF ingestion;
2. real provider adapter plus mock provider;
3. stronger question schema validation;
4. duplicate/ambiguous-question checks;
5. adaptive practice logic;
6. simple spaced-review metadata;
7. concept/readiness visualization;
8. polished demo, README, and real screenshots.

Do NOT build school admin, LMS integrations, live-exam cheating features, billing, or voice until the core learning loop is solid.
