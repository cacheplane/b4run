# Growth and lifecycle management for B4.run

Status: approved 2026-10-21. Nothing here is built yet.

Prior art: Threadplane's growth stack in `~/repos/angular-agent-framework`
(`docs/growth/README.md`, `docs/gtm/taxonomy.md`, `libs/growth`,
`apps/lifecycle`, `tools/posthog`). This design keeps its principles and its
three-email founder sequence and cuts everything that existed to serve
enrichment.

## Intent

B4.run has no way to see how developers move from the website to a running
app, no way to hear from them, and no way to follow up. The repo's own
precedent is strict: a scaffold "should not phone home before its author has
written a line of code" (`packages/devkit/test/template-telemetry-off.test.ts`),
and two specs defer analytics to "a separate consented project". This is that
project.

Four outcomes, in priority order:

1. **Observability of the developer journey.** Which pages, docs, and blog
   posts get read, which calls to action get clicked, and whether the CLI is
   being used. Answered in PostHog, with dashboards defined in git.
2. **Persistence of who we may email.** One Postgres database that is the
   only truth for contacts, consent, suppression, and what was sent.
3. **Analytics that are honest.** Dashboards state what they do not prove
   (a copied install command is not an install). Event contracts are checked
   in CI against live data.
4. **A founder-led email series.** Three plain-text emails from Brian,
   scheduled by our database, delivered by Resend, stopped by any
   unsubscribe, bounce, complaint, or founder action.

## Vocabulary

The word *tracking* does not appear in code, docs, copy, or event names.
Use *signals* for what the website and CLI emit, *observability* for reading
them, and *lifecycle* for the contact and email state machine. The CLI feature
is *anonymous usage reporting*.

## Goals, non-goals, anti-goals

**Goals**

- A PostHog project receiving website signals and anonymous CLI signals, with
  every dashboard and insight as JSON in the repo and a sync script.
- A `/privacy` page that describes the categories collected, published before
  any signal is emitted.
- One capture form on the site that asks for an email with a versioned
  disclosure covering both product updates and a personal founder follow-up.
- A Neon Postgres control plane with three tables (contacts, activity ledger,
  sends) and a migration runner.
- The founder sequence: step 1 at 07:00 Pacific the next weekday, step 2
  three business days after step 1 is accepted by the provider, step 3 five
  business days after step 2. Weekday 07:00–08:00 send window.
- Durable stops: one-click unsubscribe (`List-Unsubscribe-Post`), Resend
  webhooks for bounce, complaint, and suppression, and a signed founder stop
  link. A stop is never reversed by a later form submission.
- A daily plain-text founder digest and a `growth:report` command, so the
  state of the lifecycle is readable without a database client.
- Everything behind explicit switches, defaulting off, so each phase can
  deploy dark.

**Non-goals (deliberately not in this project)**

- Company research or any enrichment: no page capture, no scraper, no
  research agent, no artifacts, no evidence angles. Every contact gets the
  same three generic emails.
- Deterministic lead scoring and tiering.
- Postinstall scripts of any kind. No package in the fixed release group
  gains an install hook, and no git identity is ever read.
- Runtime signals from `@b4run/*` packages in a user's app. The runtime stays
  silent; only the `b4` CLI reports, and only in development commands.
- Inbound reply detection (Threadplane's Gmail Apps Script poller). Replies
  are handled by Brian reading his BCC copy and clicking the stop link in the
  digest.
- A newsletter broadcast engine, drafting agent, social publishing, or Search
  Console tooling.
- Building the lifecycle as a B4.run app. Threadplane's lifecycle is a Dawn
  app because enrichment needed an agent. Without enrichment there is no
  agent work, so it is route handlers in `apps/web`.

**Anti-goals (would make this a failure even if it works)**

- Any personal data in PostHog. No email, no email domain, no name, no
  message text, no file paths, no project names.
- An email sent to anyone whose approval was cleared, for any reason, at any
  point before provider submission.
- A CLI that reports without the developer having seen a notice saying so and
  how to turn it off.
- Copy in the three emails that reads as surveillance ("I noticed you…").

## Constraints

- `apps/web` is Next.js 16 on Vercel, static today. New server routes must
  not break the static export of existing routes or the SEO lastmod manifest.
  Every new public page (`/privacy`, the form page) needs a registry entry and
  a regenerated manifest.
- The CSP in `apps/web/next.config.ts` has `form-action 'self'`; forms post
  to same-origin routes. PostHog is proxied through a same-origin `/ingest`
  rewrite, so no `connect-src` change is needed.
- The CLI's env namespace is `B4_*`. The opt-out is `B4_TELEMETRY_DISABLED=1`;
  `DO_NOT_TRACK=1` and CI detection are also honoured. (The variable name
  uses the industry-standard word so developers searching for the opt-out
  find it; it is the one place the word appears.)
- The `.changeset` fixed group is patch-only on 0.x. The CLI change needs a
  changeset. Everything under `apps/web` and `scripts/` is not published.
- Secrets reach Vercel through the project's environment; nothing here reads
  the root `.env` in production.
- Postgres migration helpers in `@b4run/postgres-storage` are internal. The
  growth control plane gets its own tiny runner rather than exporting product
  internals for a marketing concern.

## Decisions already made

### Surfaces that emit signals

| Surface | Mechanism | Identity | Default |
|---|---|---|---|
| Website (`apps/web`) | `posthog-js` via a new `/ingest` rewrite to `us.i.posthog.com`; `capture_pageview: 'history_change'`, autocapture on, `person_profiles: 'identified_only'` | PostHog anonymous id | On, after `/privacy` ships |
| `b4` CLI (`packages/cli`) | `POST https://b4.run/api/signals/v1/cli`; the site re-keys to PostHog server-side with `$ip: null` and no person profile | Random UUID in `~/.b4/usage-id`, created on first run | On, with first-run notice and opt-out |
| `create-b4-app` | None. A scaffold does not phone home; the first signal is the author's first `b4 dev`. | — | — |
| Runtime packages, `b4 start` | None | — | — |

The CLI calls the site rather than PostHog so the PostHog key is never in a
published package, the schema is validated server-side, and IP is dropped.
`B4_SIGNALS_URL` overrides the endpoint for self-hosters.

**Which commands report.** Development-time commands only: `dev`, `build`,
`add`, `validate`, `typecheck`, `verify`, `eval`. `start` never reports
because it is the production process. The emitter is one wrapper around the
command dispatch in `packages/cli/src/index.ts`, with an allowlist of command
names; a command not on the list emits nothing. CI detection (`CI`,
`GITHUB_ACTIONS` and the usual set) makes every command inert, so `build` in
a user's pipeline is silent. The emitter lives in `packages/cli` only; no
new package dependency and one changeset.

**PostHog project.** The `POSTHOG_PROJECT_ID` in the root `.env` is the
dedicated `b4run` project on PostHog US cloud, separate from Threadplane's.
`POSTHOG_HOST` defaults to `https://us.i.posthog.com`.

The first-run notice prints once, before any send:

```
B4.run collects anonymous usage signals (command, version, OS, outcome) to
improve the CLI. No code, paths, or identity are collected.
Disable: B4_TELEMETRY_DISABLED=1 or DO_NOT_TRACK=1. Details: https://b4.run/privacy
```

### Event taxonomy

Prefixes: `site:`, `docs:`, `blog:`, `cli:`. Lowercase snake_case, static
names, vary by property. `$pageview` as-is.

| Event | When | Properties |
|---|---|---|
| `site:cta_click` | A tracked call to action | `cta_id`, `surface`, `destination_url?` |
| `site:external_link_click` | Outbound to GitHub, npm | `destination_host`, `surface` |
| `site:install_command_copied` | Copy on the `npm create b4-app` block | `surface` (`home`, `blog`, `docs`) |
| `site:engaged_time` | 10 s and 30 s of visible time | `engaged_seconds`, `source_page` |
| `site:form_submit` / `site:form_success` / `site:form_fail` | Client-observed form lifecycle | `form`, `failure_reason?` |
| `site:contact_accepted` | Server-side, after the database commit | `form`, `email_kind` (`work` or `personal`) |
| `docs:search_open` | The existing `b4:open-docs-search` window event | `source_page` |
| `docs:search_result_click` | Result chosen | `source_page` |
| `docs:copy_code_click` / `blog:copy_code_click` | Copy button | `code_lang?`, `source_page` |
| `cli:command_completed` | An allowlisted `b4` command ends | `command`, `cli_version`, `node_major`, `os`, `outcome` (`ok`, `error`, `cancelled`), `duration_bucket`, `error_class?` |
| `cli:dev_first_run_completed` | First AG-UI run finishes in a `b4 dev` session | `cli_version`, `route_kind` (`agent`, `chain`, `graph`, `workflow`) |

`cli:dev_first_run_completed` is the activation signal. Fires at most once per
`b4 dev` process. Nothing about the route, model, prompt, or messages is sent.

Properties outside the allowlist are dropped at the ingest route; malformed
known properties reject the event. Strings are capped at 128 characters.
Forbidden property names (`email`, `path`, `prompt`, `messages`, `error`,
`threadId`, `runId`) fail the contract test.

### Persistence

One Neon project, env `GROWTH_DATABASE_URL`, driver `@neondatabase/serverless`.
Three tables; migrations are numbered SQL files under `apps/web/growth/migrations`
applied by `pnpm --dir apps/web growth:migrate` with a ledger table and
checksum (an applied file that changed fails the run).

```
growth_contacts
  id uuid pk, email citext unique, email_hmac text unique,
  display_name text null, source text, disclosure_version text,
  approved_at timestamptz null, stopped_at timestamptz null,
  stop_reason text null, posthog_distinct_id text null,
  created_at, updated_at, deleted_at

growth_activity
  id bigint identity pk, event_key text unique, contact_id uuid fk,
  kind text, occurred_at timestamptz, data jsonb, created_at

growth_sends
  id uuid pk, contact_id uuid fk, step smallint (1..3),
  idempotency_key text unique, status text
    (pending | leased | submitted | completed | failed | cancelled),
  due_at timestamptz, lease_until timestamptz null, lease_token uuid null,
  attempts int, provider_email_id text unique null,
  delivery_status text
    (not_submitted | submitted | delivered | bounced | complained |
     suppressed | failed | unknown),
  last_error_code text null, created_at, updated_at
```

- `approved_at` is the only send-authorisation field. A stop clears it and
  sets `stopped_at` and `stop_reason`. A later form submission never
  re-approves a stopped contact; reapproval is a founder command.
- `email_hmac` is `HMAC-SHA-256(GROWTH_EMAIL_HMAC_SECRET, normalised email)`.
  On deletion the row keeps only the HMAC and the stop so the address is never
  emailed again.
- `growth_activity.kind` values: `form.accepted`, `contact.approved`,
  `sequence.enrolled`, `send.submitted`, `send.delivered`, `stop.<reason>`,
  `contact.reapproved`, `contact.deleted`.
- `posthog_distinct_id` is the anonymous website id captured at form submit,
  stored only in Postgres so a contact's journey can be looked up by hand.
  Nothing flows the other way.

### Capture surface

One form, `form = 'founder_updates'`, on a page `/updates` and as a compact
band at the end of blog posts and the Getting Started doc. Fields: email,
optional "what are you building" (never sent to PostHog; stored as
`growth_activity.data.message`). Honeypot field, same-origin POST to
`/api/growth/forms/founder-updates`, server-side validation, per-IP budget.

Disclosure text, versioned as `b4_growth_v1.2026-10-20`, shown beside the
button:

> Occasional B4.run updates from Brian, and I may personally email you once
> or twice to offer a hands-on session. Unsubscribe with one click, any time.

A `/call` route redirects to Brian's Google Calendar appointment page so every
link in email is on `b4.run`.

### Founder sequence

Adapted from Threadplane's `apps/lifecycle/src/campaign/templates.ts`, with
its draft checker ported unchanged: no HTML or Markdown, at most 120 words
and one link and one question, only links from an approved set, no calendar
hosts, no `utm_`, no surveillance phrases, no email addresses, no injected
headers.

| Step | Due | Subject | Shape |
|---|---|---|---|
| 1 | 07:00 PT next weekday after approval | Engineer to engineer | Why they are hearing from me; offer a short session to get their agent running; no link; CTA is a reply |
| 2 | 3 business days after step 1 accepted | Get your agent into production | 30-minute hands-on session, no sales; `https://b4.run/call` |
| 3 | 5 business days after step 2 accepted | One last note from the B4.run founder | Same offer, "This is my last automated follow-up."; `https://b4.run/call` |

Final copy is Brian's to write; the checker enforces the shape. Mail is
plain text, from `Brian at B4.run <brian@b4.run>`, reply-to the same, BCC
Brian, `List-Unsubscribe` and `List-Unsubscribe-Post`, an
`X-B4-Send-ID` header, and a Resend tag `environment` that must equal
`GROWTH_ENVIRONMENT` or the webhook ignores it.

Enrollment is materialised by the scheduler, once per contact, only when
`GROWTH_SEQUENCE_ENABLED=true` and `approved_at >= GROWTH_SEQUENCE_START_AT`.
Pre-launch contacts are never backfilled automatically.

### Scheduler

Vercel cron `*/30 * * * *` (added to `apps/web/vercel.json`; the `b4-run`
project is on the cacheplane team's Pro plan, which allows this cadence)
calls `GET /api/growth/tick` with a bearer `GROWTH_CRON_SECRET`. A form
submission also nudges the tick immediately.
One tick:

1. Enroll newly approved contacts (create the step-1 send).
2. Lease due sends with `FOR UPDATE SKIP LOCKED`, batch of 20, only inside
   the weekday 07:00–08:00 Pacific window for sequence mail.
3. For each lease: re-check `approved_at` inside the transaction, then
   submit to Resend with the idempotency key, store `provider_email_id`,
   and on acceptance schedule the next step.
4. Enqueue the daily founder digest once per Pacific business day.

`GROWTH_DELIVERY_ENABLED=false` leases nothing. Threadplane needed a Node 24
Dawn app for this; here it fits a route handler with a 60-second limit
because no step does model or network work beyond one Resend call.

### Stops and webhooks

- `/api/growth/unsubscribe?token=` renders a confirmation on GET and stops on
  POST; tokens are HMAC-signed `{contact_id, purpose, key_version, iat}`.
- `/api/growth/webhooks/resend` verifies the Svix signature and maps
  `email.bounced`, `email.complained`, `email.suppressed` to stops and
  `email.delivered` to `delivery_status`.
- The digest carries a signed `founder_stop` link per in-flight contact
  (seven-day expiry) so a reply in Brian's inbox becomes a stop in one click.
- `pnpm --dir apps/web growth:control -- status|approve|stop|delete --email`.

### Analytics tooling

Port `tools/posthog` from Threadplane as `scripts/posthog/`: Zod-validated
`dashboards/*.json` and `insights/*.json`, `sync --plan` (CI, read-only key)
and `sync --apply` (local, write key), a `quality` command that samples live
events against the contract, and a `taxonomy` test that fails when a
dashboard references an event not in this document's table. Env names match
what is already in the root `.env`: `POSTHOG_PERSONAL_API_KEY`,
`POSTHOG_PERSONAL_API_KEY_READONLY`, `POSTHOG_PROJECT_ID`, plus
`POSTHOG_HOST`.

Three dashboards to start: *Site and docs engagement*, *Acquisition and
forms*, *CLI usage and activation*. Each description states its limits.

### Privacy page

`/privacy` ships in phase 1 and is a precondition for every emitter. It
describes categories, not an event catalogue: website signals, anonymous
CLI signals and the opt-out, the form and the sequence, subprocessors
(Vercel, Neon, PostHog US, Resend, Google Calendar), retention (contacts
until unsubscribe or deletion request; signals per PostHog project
retention), the controller (Cacheplane, 2843 NW Lolo Dr, Bend, OR), and the
deletion address `brian@b4.run`.

## Phases

Each phase is one PR and deploys dark behind its switch. Verification is
layered, because Vercel crons run only in production and a Resend webhook
points at one URL:

- Unit tests with an injected SQL executor cover the draft checker, cadence
  (DST, weekends), lease concurrency, stop idempotency, and webhook signature
  verification.
- Preview exercises the form, the unsubscribe GET and POST, and a manually
  invoked `/api/growth/tick` with `GROWTH_DELIVERY_ENABLED=false`, against a
  preview Neon branch.
- Production goes live with delivery off, then with delivery on and
  `GROWTH_SEQUENCE_START_AT` set so the only enrolled contact is Brian's own
  address, which also proves the webhook and the stop links. Only then does
  the start timestamp move to the launch time.

1. **Observe the site.** `/privacy`, PostHog client, typed `site:`/`docs:`/
   `blog:` events, `scripts/posthog` with the first dashboards, CI plan check.
2. **Persist contacts.** Neon schema and runner, the form and page, the
   `site:contact_accepted` server event, unsubscribe route, Resend webhook,
   `growth:control`. No sends.
3. **Founder sequence.** Templates and checker, tick route and cron, digest,
   `growth:report`. Preview dogfood with Brian's own address, then enable.
4. **CLI usage reporting.** Notice, opt-out, `~/.b4/usage-id`, the ingest
   route, the two `cli:` events, the third dashboard. Changeset.

Phase 4 is independent of 2 and 3 and can move earlier if the CLI signal
matters more than email.

## Prerequisites outside the repo (owner actions)

- Add `b4.run` as a verified sending domain in Resend (today only
  `threadplane.ai` and `cacheplane.ai` are verified) and a webhook endpoint
  with its signing secret.
- `b4.run` has no MX record, so `brian@b4.run` cannot receive replies. Add
  mail routing (Cloudflare Email Routing or Google Workspace) that forwards to
  Brian's inbox before step 1 goes out.
- Create the Neon project and set `GROWTH_DATABASE_URL` for preview and
  production separately.
- In PostHog, create the project API token (`NEXT_PUBLIC_POSTHOG_KEY`) for
  client capture; the personal keys in `.env` are for the sync tooling only.
- A Google Calendar appointment page for `/call`.

## Left to the builder

- Exact file layout under `apps/web` (suggested: `apps/web/growth/` for
  server code and migrations, `apps/web/app/api/growth/*` for routes,
  `apps/web/app/lib/analytics/` for the typed client).
- The rate-limit store for the form (Upstash exists in `.env`; an in-memory
  budget per instance is acceptable for v1).
- Whether `site:engaged_time` ships in phase 1 or waits for the first
  bounce-rate question.
- Test strategy: the draft checker, scheduler cadence (DST, weekends), lease
  concurrency, stop idempotency, and webhook signature verification all get
  unit tests with an injected SQL executor; a live integration test runs
  behind `B4_TEST_GROWTH_DB=1` against a disposable Neon branch.
- CI lane shape for the PostHog plan check and quality sample (model it on
  `vercel-native`: same-repo PRs, read-only key via a GitHub environment).

## Open decisions for the owner

1. CLI usage reporting is opt-out with a notice. The repo's precedent could
   also justify opt-in. Opt-out is the industry norm (Next.js, Nx, Astro,
   Turborepo) and is the only way the activation dashboard has volume.
2. One form with one disclosure that covers both updates and the founder
   emails. The alternative, a separate updates-only list, needs a broadcast
   engine this project does not build.
3. The founder sequence copy itself.
4. Resolved: the controller named on `/privacy` is Cacheplane,
   2843 NW Lolo Dr, Bend, OR. The deletion contact is `brian@b4.run`, which
   makes the mail-routing prerequisite a blocker for publishing the page,
   and so for phase 1.
