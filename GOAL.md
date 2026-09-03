# GOAL.md

## Autonomous execution mode

This repository is being developed in an autonomous implementation sprint.

Read `AGENTS.md` first. `AGENTS.md` is the repository's durable engineering contract.
Then read this file and use it as the current execution goal and acceptance criteria.

Work autonomously. Do not stop merely to ask what to do next when a safe, reasonable
next step can be inferred from `AGENTS.md`, this goal, the repository state, and test results.

The previous 08:40 / 09:00 time cutoff is obsolete and must be ignored.
There is no longer a time-based feature freeze or clock-based stopping condition.

The Goal should end because important achievable work has been verified complete,
not because a particular time of day has been reached.

### Safety boundaries for autonomous execution

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

### Execution and completion policy

Continue working autonomously while this Goal is active and model quota is available.

Prioritize work in this order:

1. Complete all achievable P0 acceptance criteria.
2. Verify and stabilize P0.
3. Complete the highest-value unfinished P1 work.
4. Run meaningful tests and repair discovered defects.
5. Inspect and improve the actual user experience.
6. Improve onboarding and documentation.
7. Perform release hardening and adversarial review.
8. Do P2 work only when P0 and important P1 work are genuinely stable.

Do not add low-value or speculative features merely to consume model quota.

Do not intentionally idle.

When all important achievable P0 and high-value P1 work are genuinely complete and verified,
perform final validation and create or update `FINAL_REPORT.md`.

### Autonomous loop

Repeat until the important achievable completion conditions are met:

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

### Token/quota interruption resilience

Assume the model/provider may run out of quota or execution may be interrupted unexpectedly.

Therefore:
- never leave the repository unnecessarily broken between milestones;
- work in small coherent increments;
- prefer completing and validating one vertical slice before starting another;
- before beginning a risky multi-file refactor, ensure the current verified working state is committed locally when practical;
- after every meaningful working milestone, run targeted validation, repair failures, update `PROJECT_STATUS.md`, and create a local Git checkpoint when appropriate.

`PROJECT_STATUS.md` should record:
- current verified state;
- last known working commit;
- current uncommitted work;
- validation commands and results;
- unfinished Goal criteria;
- next highest-value action.

If execution is interrupted, another model/provider should be able to recover from the current repository, Git history, `AGENTS.md`, `GOAL.md`, and `PROJECT_STATUS.md` without restarting the project.

### Recovery behavior

If a command or approach fails:
- inspect the error;
- attempt a reasonable repair;
- try an alternative implementation when appropriate;
- document a real blocker only after practical local alternatives are exhausted.

Do not repeatedly retry the same failing action without changing the approach.

If existing work is partially complete:
- preserve completed working code;
- do not blindly reset or discard uncommitted changes;
- repair and finish interrupted work when practical;
- otherwise revert only the incomplete portion to the last verified working state.

### Finalization

Before stopping:
- run all applicable lint/typecheck/test/build/e2e checks;
- verify the bundled demo;
- inspect the main UI;
- remove obvious debug artifacts;
- ensure README claims match reality;
- update `PROJECT_STATUS.md`;
- create/update `FINAL_REPORT.md` with exact validation results and next steps.

Finalization should happen only after important achievable P0 and high-value P1 work are stable,
or when further progress is genuinely blocked by something that cannot reasonably be solved locally.

---

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
