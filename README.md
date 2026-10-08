# ExamForge

**Turn study material into an adaptive exam coach.**

Load the bundled sample, paste notes, or upload a text-based PDF. ExamForge extracts
grounded concepts and leads you through the learning loop:

> Material → Diagnostic → Practice → Mock Exam → Readiness

![Course dashboard](docs/screenshots/02-course-dashboard.png)

Questions, grading, and study signals are deterministic. No material goes to an
external AI service and no model API key is needed. Readiness is an internal study
heuristic, not a prediction of a real exam score.

## Hosted beta

Try the [ExamForge beta](https://exam.kohalabs.com/), the preferred public hostname. First use
creates an anonymous identity for that browser after a verification check. Study
material and progress are stored in the hosted ExamForge database. The identity has
no email, password, backup, or account recovery. Clearing site data or using a
different browser/device can make old courses inaccessible. Deleting a course removes
its material and derived progress.

The [legacy Workers address](https://examforge-beta.ka-labs.workers.dev) remains
supported for existing browsers. Each origin has separate site storage: moving to
the custom hostname creates a separate anonymous session and does not carry over
old courses. Use the original hostname/browser to access that session's history.

The beta allows 10 courses per browser identity, five generation attempts per
hour, and 100 study sessions per course. At the session limit, existing progress
remains available; delete a course to start a new study cycle. Written answers
are limited to 2,000 characters. Material is capped at 200,000 characters;
text-based PDFs are capped at 20 MB.
Scanned PDFs need OCR and are not supported. PDF text extraction happens in your
browser; the original PDF is not stored by ExamForge. Extraction from complex layouts
can be incomplete, and insufficient material fails without invented questions.
Free-tier infrastructure has no paid availability guarantee.

## Local development

Requires Node.js **22.13+**. The local Next.js mode uses SQLite and binds to
`127.0.0.1`; its data stays on this machine. The hosted beta has a separate
Supabase database and does not use local SQLite.

```bash
npm install
npm run dev            # http://127.0.0.1:3000
```

Click **Load bundled demo material** to try the full loop. Local progress is stored
in `.data/examforge.sqlite`. No credentials are required for local mode.

## Hosted deployment

The hosted browser app is static assets on Cloudflare Workers. One Supabase Edge
Function handles authenticated course and assessment APIs; a separate narrow
maintenance function performs scheduled database reads. Supabase Auth and Postgres
hold anonymous identities and learner data. Use a dedicated Supabase project and
Cloudflare Worker. The SQL migrations in `supabase/migrations/` must be applied in
order to a clean project. See [ARCHITECTURE.md](ARCHITECTURE.md) for the ownership,
answer-key, and transaction boundaries.

The hosted build copies `public/_headers` to `dist-hosted/_headers`. Cloudflare
Workers Static Assets applies its anti-framing headers to the SPA shell and
fallback routes. Keep this file in the deployed asset directory.

Configuration names (supply your own values, never commit them):

| Location | Name | Purpose |
| --- | --- | --- |
| Hosted Vite build | `VITE_SUPABASE_URL` | Supabase project URL |
| Hosted Vite build | `VITE_SUPABASE_PUBLISHABLE_KEY` | Public Supabase key |
| Hosted Vite build | `VITE_TURNSTILE_SITE_KEY` | Public Cloudflare Turnstile site key |
| Edge Function secret | `EXAMFORGE_PUBLISHABLE_KEY` | Supabase public key for JWT verification |
| Edge Function secret | `EXAMFORGE_SECRET_KEY` | Privileged server-only Supabase secret key |
| Edge Function secret | `EXAMFORGE_ALLOWED_ORIGINS` | Comma-separated exact hosted origins |
| Both provider secret stores | `EXAMFORGE_KEEPALIVE_TOKEN` | Dedicated maintenance token: 32 random bytes as 64 lowercase hex characters |
| Cloudflare Worker binding | `EXAMFORGE_SUPABASE_URL` | HTTPS Supabase project origin for scheduled requests; distinct from browser build config |
| Supabase Auth config environment | `EXAMFORGE_TURNSTILE_SECRET` | Private Turnstile verification secret |

Supply all three public `VITE_*` values through the shell or an untracked Vite
environment file (such as `.env.production.local`) before `npm run build:hosted`
or `npm run deploy:hosted`. The hosted build fails if any value is missing or
unusable. These browser values are distinct from the server-only secrets.

Supabase supplies `SUPABASE_URL` to the Edge Function. Enable anonymous Auth with
Turnstile CAPTCHA and an appropriate signup rate limit; configure the Turnstile
secret in Supabase Auth, and allow both `exam.kohalabs.com` and the supported legacy
Worker hostname in the existing widget. Verify the deployed `VITE_TURNSTILE_SITE_KEY`
belongs to that widget before rebuilding; a hostname change alone needs no new key. For
local hosted-app development, allow `localhost`/`127.0.0.1` as needed. Keep the
privileged key and Turnstile secret in provider secret stores only.

```bash
npx supabase login
npx supabase link --project-ref <dedicated-project-ref>
npx supabase config diff
npx supabase config push --project-ref <dedicated-project-ref>
npx supabase db push --linked
npx supabase functions deploy examforge --project-ref <dedicated-project-ref>
# After provisioning the maintenance token in both stores (see below):
npx supabase functions deploy examforge-keepalive --project-ref <dedicated-project-ref>
npm run build:hosted
npx wrangler deploy
```

Review `config diff` before pushing so a generated default does not overwrite an
intentional setting. Set the Edge Function secrets in Supabase's secret store before
deploying the function; provide the Turnstile secret as an environment variable when
pushing Auth configuration. The learner function keeps `verify_jwt = true` and also
checks each user JWT inside the handler. Preserve the exact CORS allowlist
`https://examforge-beta.ka-labs.workers.dev,https://exam.kohalabs.com`
(no trailing slashes or wildcards) and its `private, no-store` responses. Update
`wrangler.jsonc`'s dedicated Worker name for a new environment. Deployment does not
create a custom domain or paid service.

### Scheduled database activity (operator setup)

`wrangler.jsonc` schedules one small read at **00:00, 08:00 and 16:00 UTC** each
day. The existing Worker keeps assets-first routing without `run_worker_first`.
Matched assets and browser navigations bypass its script; any request reaching
`fetch()` passes unchanged to the `ASSETS` binding, preserving SPA fallbacks and
`_headers` even when a client sends no navigation header.
Review cadence in `triggers.crons`. Cron changes can take up to 15 minutes to propagate.

The Worker sends `POST /functions/v1/examforge-keepalive` with a dedicated
`X-ExamForge-Keepalive-Token`. The function rejects missing/invalid configuration,
wrong tokens and browser origins before creating a privileged client. It makes
one uncached PostgREST read of `ef_courses` (`select=id&limit=1`), checks the
database result, and returns only `{ "ok": true }` with `no-store`. An empty table
still succeeds. No rows are written, no IDs returned and no learner activity is
fabricated. Query and network deadlines are 10 and 15 seconds respectively;
failures reject the scheduled task with a sanitized operational message.

Only this separate maintenance function uses `verify_jwt = false`; its handler
requires the dedicated token. This avoids relying on unverified deployment-specific
publishable-key gateway compatibility on the learner function. No Supabase API key
is needed in the Worker; `EXAMFORGE_SECRET_KEY` stays in Supabase's secret store.
See [Supabase authorization headers](https://supabase.com/docs/guides/functions/auth-headers).

These steps change live configuration and must be performed by an authorized
operator; a repository change alone does not activate the schedule:

1. Confirm the intended project and Worker. Securely provision the same token in
   both stores, without shell tracing. This example creates a private temporary
   file and never prints the token or puts it in command arguments. Keep a secure
   copy for verification/rotation if needed.

   ```bash
   umask 077
   keepalive_secrets=$(mktemp)
   printf 'EXAMFORGE_KEEPALIVE_TOKEN=' > "$keepalive_secrets"
   openssl rand -hex 32 >> "$keepalive_secrets"
   npx supabase secrets set --env-file "$keepalive_secrets" --project-ref <dedicated-project-ref>
   sed 's/^EXAMFORGE_KEEPALIVE_TOKEN=//' "$keepalive_secrets" | npx wrangler secret put EXAMFORGE_KEEPALIVE_TOKEN
   rm "$keepalive_secrets"
   npx wrangler secret put EXAMFORGE_SUPABASE_URL
   # At the prompt, supply https://<project-ref>.supabase.co (no path/query).
   ```

   Confirm the existing Supabase-only database key and learner API public key/CORS
   secrets are still configured. Never copy the privileged key into Cloudflare,
   Vite, Git, CI or a PR. Rotate the maintenance token in both stores together;
   mismatches fail closed.
2. Deploy `examforge-keepalive` first with the command above. Confirm its JWT check
   is off while `examforge` remains on. Run `npm run deploy:hosted` with the three
   real public `VITE_*` values. Verify the existing custom-domain route still
   targets `examforge-beta` and the legacy hostname stays enabled. Local validation
   does not change routes/DNS/secrets.
3. Review `supabase config diff` and live Auth URL Configuration separately. The
   repository Site URL is `https://exam.kohalabs.com`; reconcile the live value
   deliberately without overwriting Turnstile/CAPTCHA or other Auth settings.
   `additional_redirect_urls` stays empty because anonymous sign-in uses no redirect
   flow. Legacy access needs its exact CORS origin and widget hostname, not an
   invented OAuth redirect or wildcard.
4. Test one maintenance invocation with a private mode-0600 header file containing
   `X-ExamForge-Keepalive-Token: <matching-token>` (never commit it or enable verbose
   HTTP logging):

   ```bash
   curl --silent --show-error --fail --request POST \
     --header @<private-header-file> \
     https://<project-ref>.supabase.co/functions/v1/examforge-keepalive
   ```

   Require HTTP 200 and only `{ "ok": true }`; delete the header file afterwards.
   Missing/wrong tokens must return 401 and browser origins must be rejected.
   Confirm the matching successful PostgREST GET in Supabase API logs and database
   activity (or an aggregate `pg_stat_statements` call-count increase) at that time.
   Keep row data, tokens and raw errors out of verification evidence.
5. Observe the next actual Cron invocation in Cloudflare Cron Events/Workers Logs.
   Require a successful event and `ExamForge keepalive: database query succeeded.`
   Correlate it with the Supabase database read. A local stub, static HTTP 200,
   Auth call or `GET /api/health` does not prove hosted DB activity. Check later
   runs and pause warnings; for failures check the sanitized status, matching
   token, function deployment and database availability.
6. Verify HTTPS, a deep link, anti-framing headers, Turnstile anonymous signup and
   a bundled-demo diagnostic on both hostnames with disposable browser identities.
   Confirm allowed-origin API/preflight responses and rejection of an unlisted
   origin. This release has no cross-origin identity/history migration.

Local verification uses `npx wrangler deploy --dry-run` and `npx wrangler dev`;
`/cdn-cgi/local/scheduled?format=json` invokes the scheduled handler. Use synthetic
tokens and stub/disposable endpoints, never production credentials. Automated
keepalive tests exercise the real Supabase SDK against test responses; they do not
prove a live gateway, Turnstile configuration or deployed DB activity.

To roll back maintenance, set `triggers.crons` to `[]` and redeploy the Worker.
Once scheduling has stopped, an operator can remove the unused maintenance function
and token from both stores. Keep learner JWT verification, CORS and domain routes
intact; restoring an Auth Site URL is a separate deliberate configuration change.
No database migration or learner-data rollback is needed.

[Supabase Free project pausing](https://supabase.com/docs/guides/platform/free-project-pausing)
depends on sufficient database activity: a few daily queries typically reduce pause
likelihood but are not an uptime guarantee. Until the schedule is deployed and
observed, visit the Supabase project Dashboard or use the existing app to read your
course list as an interim manual action; static HTML or health is insufficient.
If already paused, the operator must resume the project in Supabase first.

Live secret bindings, function versions, Auth Site URL, custom-domain routing,
Turnstile signup, CORS and scheduled database activity must be verified during
release; local checks do not attest to those provider settings.

## Scripts

```bash
npm run dev              # local Next.js server
npm run build            # local production build
npm start                # local production server
npm run build:hosted     # hosted static assets
npm run test:hosted:concurrency # disposable local Postgres lock regression (Docker)
npm run deploy:hosted    # hosted build and Cloudflare deployment
npm test                 # unit and integration tests
npm run test:e2e         # local Playwright journey, disposable SQLite DB
npm run test:smoke:prod  # local production build and smoke test
npm run typecheck
npm run lint
npm run db:reset         # delete local progress
```

Local browser tests and screenshots use disposable SQLite databases; they never use
hosted learner data. The hosted DB and API smoke scripts require a dedicated test
project and two disposable authenticated JWTs when CAPTCHA is enabled.

See [PRODUCT.md](PRODUCT.md) for product behavior, [ARCHITECTURE.md](ARCHITECTURE.md)
for implementation invariants, and [SECURITY.md](SECURITY.md) for private reporting.
