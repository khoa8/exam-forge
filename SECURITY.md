# Security Policy

## Supported Versions

ExamForge is currently under active development and has not yet established multiple supported release lines.

Security fixes are applied to the current version on the `main` branch and the active hosted beta. Older commits, branches, forks, and unofficial distributions are not separately supported.

## Reporting a Vulnerability

Please do not disclose security vulnerability details in a public GitHub issue, discussion, pull request, or other public channel.

When GitHub private vulnerability reporting is available for this repository, use the repository's **Report a vulnerability** workflow so the report can be discussed privately with the maintainer.

If private vulnerability reporting is not available, open a GitHub issue containing **no vulnerability details** and ask the maintainer for an appropriate private contact method.

A useful vulnerability report should include, where possible:

* a clear description of the issue;
* the affected ExamForge version or commit;
* reproduction steps or a minimal proof of concept;
* the expected and actual behavior;
* the potential security or privacy impact;
* any suggested mitigation, if known.

Do not include real study material, learner data, credentials, API keys, tokens, local database contents, or other private information in a vulnerability report unless a secure private channel has first been established and the information is strictly necessary.

## Security Scope

The public beta serves static assets on Cloudflare and uses Supabase anonymous Auth, an Edge Function, and learner-owned Postgres data. The Edge Function verifies each learner JWT, checks ownership for every course/session ID, and keeps privileged database credentials and answer-bearing question rows server-side. Learner JWTs have no direct ExamForge table or RPC grants; course material and progress are available only through the owner-scoped Edge Function. Its responses are non-cacheable. Turnstile protects anonymous signup. A separate optional local mode binds to `127.0.0.1` and stores data in SQLite.

Security reports are especially relevant when they involve areas such as:

* one learner accessing another learner's material, answers, progress or sessions;
* answer-key or privileged-key exposure through the Data API, Edge Function, browser bundle, or caches;
* bypass of the hosted Auth/RLS/ownership boundary or the local loopback boundary;
* unsafe handling of uploaded or pasted study material;
* arbitrary code execution or unsafe file processing;
* path traversal or unintended filesystem access;
* leakage of answer keys before the product contract permits them;
* prompt-injection or untrusted-material handling that crosses a documented trust boundary;
* credentials, secrets, or sensitive data being exposed through logs, files, APIs, or build artifacts;
* dependency vulnerabilities with a reachable impact on ExamForge.

Product limitations, assessment-quality suggestions, feature requests, and ordinary bugs without a security or privacy impact should be reported through the normal GitHub issue tracker.

The beta has browser-bound anonymous identity and no account recovery or backup. These limitations are disclosed in the product and are not, by themselves, vulnerabilities. Do not include a real JWT or study material in a public reproduction.

## Disclosure

Please allow the maintainer a reasonable opportunity to investigate and address a reported vulnerability before public disclosure.

No fixed response or remediation SLA is currently promised.
