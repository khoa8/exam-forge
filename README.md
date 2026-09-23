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

Try the [ExamForge beta](https://examforge-beta.kay8nand.workers.dev). First use
creates an anonymous identity for that browser after a verification check. Study
material and progress are stored in the hosted ExamForge database. The identity has
no email, password, backup, or account recovery. Clearing site data or using a
different browser/device can make old courses inaccessible. Deleting a course removes
its material and derived progress.

The beta allows 10 courses per browser identity and five generation attempts per
hour. Material is capped at 200,000 characters; text-based PDFs are capped at 20 MB.
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
Function handles authenticated course and assessment APIs; Supabase Auth and Postgres
hold anonymous identities and learner data. Use a dedicated Supabase project and
Cloudflare Worker. The SQL migrations in `supabase/migrations/` must be applied in
order to a clean project. See [ARCHITECTURE.md](ARCHITECTURE.md) for the ownership,
answer-key, and transaction boundaries.

Configuration names (supply your own values, never commit them):

| Location | Name | Purpose |
| --- | --- | --- |
| Hosted Vite build | `VITE_SUPABASE_URL` | Supabase project URL |
| Hosted Vite build | `VITE_SUPABASE_PUBLISHABLE_KEY` | Public Supabase key |
| Hosted Vite build | `VITE_TURNSTILE_SITE_KEY` | Public Cloudflare Turnstile site key |
| Edge Function secret | `EXAMFORGE_PUBLISHABLE_KEY` | Supabase public key for JWT verification |
| Edge Function secret | `EXAMFORGE_SECRET_KEY` | Privileged server-only Supabase secret key |
| Edge Function secret | `EXAMFORGE_ALLOWED_ORIGINS` | Comma-separated exact hosted origins |
| Supabase Auth config environment | `EXAMFORGE_TURNSTILE_SECRET` | Private Turnstile verification secret |

Supabase supplies `SUPABASE_URL` to the Edge Function. Enable anonymous Auth with
Turnstile CAPTCHA and an appropriate signup rate limit; configure the Turnstile
secret in Supabase Auth, and allow the dedicated Worker domain in the widget. For
local hosted-app development, allow `localhost`/`127.0.0.1` as needed. Keep the
privileged key and Turnstile secret in provider secret stores only.

```bash
npx supabase login
npx supabase link --project-ref <dedicated-project-ref>
npx supabase config diff
npx supabase config push --project-ref <dedicated-project-ref>
npx supabase db push --linked
npx supabase functions deploy examforge --project-ref <dedicated-project-ref>
npm run build:hosted
npx wrangler deploy
```

Review `config diff` before pushing so a generated default does not overwrite an
intentional setting. Set the Edge Function secrets in Supabase's secret store before
deploying the function; provide the Turnstile secret as an environment variable when
pushing Auth configuration. The function's JWT is checked inside the handler. Its CORS allowlist and
`private, no-store` response headers must match the deployed Worker URL. Update
`wrangler.jsonc`'s dedicated Worker name for a new environment. Deployment does not
create a custom domain or paid service.

## Scripts

```bash
npm run dev              # local Next.js server
npm run build            # local production build
npm start                # local production server
npm run build:hosted     # hosted static assets
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
