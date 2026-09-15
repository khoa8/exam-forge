# Security Policy

## Supported Versions

ExamForge is currently under active development and has not yet established multiple supported release lines.

Security fixes are applied to the current version on the `main` branch. Older commits, branches, forks, and unofficial distributions are not separately supported.

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

ExamForge is a local-first, single-user application. Its normal development and production entrypoints bind to the loopback interface (`127.0.0.1`) by default, and course data and progress are stored locally in SQLite.

Security reports are especially relevant when they involve areas such as:

* unintended exposure of local study material or learner progress;
* bypass of the documented loopback/local-data boundary;
* unsafe handling of uploaded or pasted study material;
* arbitrary code execution or unsafe file processing;
* path traversal or unintended filesystem access;
* leakage of answer keys before the product contract permits them;
* prompt-injection or untrusted-material handling that crosses a documented trust boundary;
* credentials, secrets, or sensitive data being exposed through logs, files, APIs, or build artifacts;
* dependency vulnerabilities with a reachable impact on ExamForge.

Product limitations, assessment-quality suggestions, feature requests, and ordinary bugs without a security or privacy impact should be reported through the normal GitHub issue tracker.

## Disclosure

Please allow the maintainer a reasonable opportunity to investigate and address a reported vulnerability before public disclosure.

No fixed response or remediation SLA is currently promised.
