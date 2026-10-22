# Growth Phase 2: Persist Contacts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give B4.run one Postgres control plane for who we may email, one capture form with a versioned disclosure, durable stops (one-click unsubscribe and Resend bounce/complaint webhooks), a server-side conversion signal, and a founder CLI. No email is sent in this phase.

**Architecture:** Everything lives in `apps/web`. Server code goes under `apps/web/app/lib/growth/` as small framework-free modules that take an injected `SqlExecutor`, so logic is unit-testable with a fake executor and integration-tested against a real Postgres behind a flag. Route handlers under `apps/web/app/api/growth/*` are thin: parse, call a module, respond. Migrations are numbered SQL files applied by a checksum-ledgered runner. PostHog receives one server-side event, `site:contact_accepted`, with no personal data.

**Tech Stack:** Next.js 16.3 route handlers (Node runtime), `pg` 8.x against a Neon pooled connection string (`GROWTH_DATABASE_URL`), `svix` for Resend webhook signature verification, `posthog-node` for the server event, Node `crypto` for HMACs and tokens, vitest 4, `@testcontainers/postgresql` 12.x for the gated database tests, `tsx` for the operator scripts.

**Spec:** `docs/superpowers/specs/2026-10-20-growth-lifecycle-design.md` — sections "Persistence", "Capture surface", "Stops and webhooks", "Event taxonomy" (the `site:form_*` and `site:contact_accepted` rows), the `/call` route under "Capture surface", and phase 2 of "Phases". Phase 3 (the sequence and scheduler) and phase 4 (CLI) are separate plans.

**Deviations from the spec, decided here:**
- The driver is `pg` over Neon's pooled URL rather than `@neondatabase/serverless`, so the same code runs against a local Postgres in tests. Neon's pooled endpoint speaks plain Postgres.
- The spec's `growth_sends` table is created now (phase 3 needs it and stops must cancel pending sends), but nothing enqueues into it in this phase.
- The form appears on its own page `/updates` and is linked from the footer and the blog CTA band; embedding the form inline at the end of every blog post and the Getting Started doc is left for a later polish pass.
- The action token carries a numeric key id `k` (always 1 today) in place of the spec's `key_version` name, so secret rotation can be added without changing the format.
- `/call` redirects to `B4_CALL_URL` read at build time; when unset it redirects to `/updates`, so the link in phase 3's emails is never dead.

## Global Constraints

- The word *tracking* appears nowhere in code, copy, docs, SQL, event names, or test names. Allowed identifiers only: `track(` (the phase 1 client), `DO_NOT_TRACK`, `respect_dnt`, `createEngagedTimeTracker`.
- No personal data reaches PostHog: the server event carries `form` and `email_kind` (`work` | `personal`) only; the client form events carry `form` and `failure_reason` only. Never the email, name, message, or domain.
- `approved_at` is the only send-authorisation field. A stop clears it and sets `stopped_at` and `stop_reason`. A later form submission never re-approves a stopped contact; reapproval is the founder command only.
- A stop is idempotent: repeating it changes nothing and inserts no second activity.
- Deletion keeps only `email_hmac`, `stopped_at`, `stop_reason`, `deleted_at`, and the stop activity; `email`, `display_name`, `posthog_distinct_id` and every `form.accepted` activity's `data` are nulled.
- `email_hmac` = hex `HMAC-SHA-256(GROWTH_EMAIL_HMAC_SECRET, normalised email)`; normalised = trimmed, lowercased, no change to the local part otherwise.
- Action tokens: `base64url(JSON payload) + "." + base64url(HMAC-SHA-256(GROWTH_TOKEN_SECRET, payloadBytes))`; payload `{ v: 1, c: contactId, p: purpose, i: issuedAtSeconds }`; verification is constant-time; `unsubscribe` tokens are valid 5 years, `founder_stop` tokens 7 days; wrong purpose, bad signature, expired, malformed, and unknown contact all yield the same uniform failure.
- Disclosure version `b4_growth_v1.2026-10-20`; disclosure text verbatim: `Occasional B4.run updates from Brian, and I may personally email you once or twice to offer a hands-on session. Unsubscribe with one click, any time.`
- Env never read at module import; every route builds its dependencies lazily inside the handler. `next build` must succeed with no `GROWTH_*` or `RESEND_*` variables set.
- Env names: `GROWTH_DATABASE_URL`, `GROWTH_EMAIL_HMAC_SECRET`, `GROWTH_TOKEN_SECRET`, `GROWTH_ENVIRONMENT` (`production` | `preview` | `test`), `GROWTH_PUBLIC_ORIGIN` (bare https origin, default `https://b4.run`), `RESEND_WEBHOOK_SECRET`, `NEXT_PUBLIC_POSTHOG_KEY` (reused for the server event), `B4_CALL_URL` (build time).
- Request bodies are read with a 4 KiB cap; every failure response from the form route is JSON `{ error: <short code> }`; unsubscribe failures are a uniform HTML page with status 400 and no detail.
- Route files under `app/api/**/route.ts` export only HTTP verbs (Next rejects other exports at build). Every handler and its `Deps` interface lives in `app/lib/growth/routes/<name>.ts`; `route.ts` is one line per verb that calls it with the default dependencies.
- `exactOptionalPropertyTypes` is on. Extensionless relative imports in `apps/web`. Biome style via `pnpm --dir apps/web lint`; never bare `biome check --write`.
- New public routes (`/updates`) need a `STATIC_SEO_PAGES` entry, a lastmod source mapping, and a regenerated manifest after the content commit.
- Every new `site:` event is added to `apps/web/app/lib/analytics/events.ts` AND `scripts/posthog/contract.ts` in the same task (the contract test pins them).
- Database tests run only when `B4_TEST_GROWTH_DB=1`; they skip otherwise and must never be the only coverage of a behaviour that a fake executor can test.

## Review Focus

1. A visitor who submits the form twice with the same email expects one contact and no error; the second submission is recorded as another `form.accepted` activity. Pinned in Task 4.
2. A stopped contact who fills in the form again must stay stopped and must not be told they are "subscribed"; the route still returns success so the stop is not disclosed. Pinned in Task 4 and Task 7.
3. A one-click unsubscribe POST from a mail client arrives with `Content-Type: application/x-www-form-urlencoded` and body `List-Unsubscribe=One-Click`, no cookies, no JS; it must stop the contact and return 200 with no redirect. Pinned in Task 8.
4. A Resend webhook replayed twice, or arriving for the other environment's tag, must not double-stop or cross environments. Pinned in Task 9.
5. An email with uppercase letters or surrounding whitespace is the same contact as its lowercase form, and a personal-mailbox domain is classified `personal`. Pinned in Task 2.

---

### Task 1: Database executor, migration runner, and the schema

**Files:**
- Modify: `apps/web/package.json` (dependencies `pg` `^8.22.0`; devDependencies `@types/pg` `^8.20.0`, `@testcontainers/postgresql` `^12.0.4`, `tsx` at the root's pinned version so the package scripts can find it; scripts `growth:migrate`, `test:growth-db`)
- Create: `apps/web/app/lib/growth/database.ts`
- Create: `apps/web/app/lib/growth/migrations.ts`
- Create: `apps/web/app/lib/growth/migrations/0001_growth_control_plane.sql`
- Create: `apps/web/scripts/growth-migrate.mts`
- Create: `apps/web/app/lib/growth/test-support/postgres.ts` (Testcontainers helper, skipped without the flag)
- Modify: `apps/web/vitest.config.ts` (`include` gains `app/lib/growth/**/*.integration.test.ts`; the existing glob already matches them, so only confirm)
- Test: `apps/web/app/lib/growth/migrations.test.ts`, `apps/web/app/lib/growth/schema.integration.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // database.ts
  export interface SqlQueryResult<Row> { readonly rows: readonly Row[]; readonly rowCount: number }
  export interface SqlTransaction { query<Row extends Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<SqlQueryResult<Row>> }
  export interface SqlExecutor extends SqlTransaction { transaction<T>(fn: (tx: SqlTransaction) => Promise<T>): Promise<T>; end(): Promise<void> }
  export function createPgExecutor(databaseUrl: string): SqlExecutor   // pg.Pool, max 3, SSL when the URL host is not localhost
  export function loadGrowthDatabaseUrl(env?: NodeJS.ProcessEnv): string // throws Error("GROWTH_DATABASE_URL is not set") when missing
  // migrations.ts
  export interface Migration { readonly name: string; readonly checksum: string; readonly sql: string }
  export function discoverMigrations(directory: string): Promise<Migration[]>   // files matching /^\d{4}_[a-z0-9_]+\.sql$/, sorted
  export function applyMigrations(input: { directory: string; executor: SqlExecutor }): Promise<{ applied: string[]; skipped: string[] }>
  // ledger table growth_schema_migrations(name text pk, checksum text, applied_at timestamptz); one transaction per migration under pg_advisory_xact_lock(hashtext('b4-growth-migrations')); an applied name whose checksum differs throws Error(`Migration ${name} changed after it was applied`)
  // test-support/postgres.ts
  export const GROWTH_DB_TESTS_ENABLED = process.env.B4_TEST_GROWTH_DB === "1"
  export async function withMigratedDatabase<T>(fn: (executor: SqlExecutor) => Promise<T>): Promise<T>  // starts postgres:16 via Testcontainers, applies migrations, runs fn, truncates nothing (fresh container per file)
  ```

- [ ] **Step 1: Write the failing tests**

`migrations.test.ts` (no database; a fake `SqlExecutor` that records `query` calls and answers the ledger select from an in-memory map):
```ts
it("discovers migrations in name order and ignores other files", ...)       // temp dir with 0002_b.sql, 0001_a.sql, notes.md → ["0001_a.sql","0002_b.sql"]
it("applies each migration once and skips it on the next run", ...)        // second applyMigrations returns applied: [], skipped: both
it("refuses an applied migration whose checksum changed", ...)             // rewrite 0001 → rejects with "changed after it was applied"
```
`schema.integration.test.ts` (`describe.skipIf(!GROWTH_DB_TESTS_ENABLED)`):
```ts
it("creates exactly the three growth tables, the ledger, and the citext extension", ...)
// information_schema.tables where table_name like 'growth_%' → ["growth_activity","growth_contacts","growth_schema_migrations","growth_sends"]
it("enforces the status and delivery_status checks on growth_sends", ...)  // insert with status 'bogus' rejects
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --dir apps/web exec vitest --run app/lib/growth`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the migration**

`0001_growth_control_plane.sql` creates `citext` and `pgcrypto` extensions and exactly these tables with these columns:
```
growth_contacts(id uuid pk default gen_random_uuid(), email citext unique, email_hmac text not null unique,
  display_name text, source text not null, disclosure_version text not null, approved_at timestamptz,
  stopped_at timestamptz, stop_reason text, posthog_distinct_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz)
growth_activity(id bigint generated always as identity pk, event_key text not null unique,
  contact_id uuid references growth_contacts(id), kind text not null, occurred_at timestamptz not null,
  data jsonb not null default '{}', created_at timestamptz not null default now())
  index growth_activity_contact_time (contact_id, occurred_at desc)
growth_sends(id uuid pk default gen_random_uuid(), contact_id uuid not null references growth_contacts(id),
  step smallint not null check (step between 1 and 3), idempotency_key text not null unique,
  status text not null check (status in ('pending','leased','submitted','completed','failed','cancelled')),
  due_at timestamptz not null, lease_until timestamptz, lease_token uuid, attempts integer not null default 0,
  provider_email_id text unique, delivery_status text not null default 'not_submitted'
    check (delivery_status in ('not_submitted','submitted','delivered','bounced','complained','suppressed','failed','unknown')),
  last_error_code text, created_at timestamptz not null default now(), updated_at timestamptz not null default now())
  index growth_sends_due (due_at, id) where status = 'pending'
  index growth_sends_contact (contact_id, step)
```
plus a `growth_set_updated_at()` trigger on `growth_contacts` and `growth_sends`.

- [ ] **Step 4: Implement `database.ts`, `migrations.ts`, `test-support/postgres.ts`, and `scripts/growth-migrate.mts`**

The script loads the URL via `loadGrowthDatabaseUrl()`, applies migrations from `app/lib/growth/migrations`, prints `applied: …` / `skipped: …`, and exits non-zero on error. Scripts: `"growth:migrate": "tsx scripts/growth-migrate.mts"`, `"test:growth-db": "B4_TEST_GROWTH_DB=1 vitest --run --config vitest.config.ts app/lib/growth"`.

- [ ] **Step 5: Run tests (with and without Docker), typecheck, lint**

Run: `pnpm --dir apps/web exec vitest --run app/lib/growth` (unit green, integration skipped) and `pnpm --dir apps/web test:growth-db` (needs Docker), then `pnpm --dir apps/web typecheck && pnpm --dir apps/web lint`.
Expected: PASS; a second `applyMigrations` on the same container applies nothing.

- [ ] **Step 6: Commit**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(growth): Postgres executor, migration runner, and the control-plane schema"
```

---

### Task 2: Email normalisation, HMAC, classification, and action tokens

**Files:**
- Create: `apps/web/app/lib/growth/email.ts`
- Create: `apps/web/app/lib/growth/tokens.ts`
- Test: `apps/web/app/lib/growth/email.test.ts`, `apps/web/app/lib/growth/tokens.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // email.ts
  export function normalizeEmail(input: string): string | undefined   // trim, lowercase; undefined unless /^[^\s@]+@[^\s@]+\.[^\s@]+$/ and length ≤ 320
  export function emailLookupHmac(secret: string, normalizedEmail: string): string   // hex
  export type EmailKind = "work" | "personal"
  export function emailKind(normalizedEmail: string): EmailKind   // personal when the domain is in PERSONAL_DOMAINS or ends with one of its entries prefixed by "."
  export const PERSONAL_DOMAINS: readonly string[]  // gmail.com, googlemail.com, yahoo.com, ymail.com, hotmail.com, outlook.com, live.com, msn.com, icloud.com, me.com, mac.com, aol.com, proton.me, protonmail.com, pm.me, gmx.com, gmx.net, mail.com, fastmail.com, hey.com, yandex.com, zoho.com
  // tokens.ts
  export type ActionTokenPurpose = "unsubscribe" | "founder_stop"
  export const TOKEN_MAX_AGE_SECONDS: Readonly<Record<ActionTokenPurpose, number>>   // unsubscribe 157_680_000, founder_stop 604_800
  export function createActionToken(input: { secret: string; contactId: string; purpose: ActionTokenPurpose; issuedAt: Date }): string
  export function verifyActionToken(input: { token: string; secret: string; purpose: ActionTokenPurpose; now: Date }): { ok: true; contactId: string } | { ok: false }
  export function unsubscribeUrl(publicOrigin: string, token: string): string   // `${origin}/api/growth/unsubscribe?token=${token}`
  export function normalizePublicOrigin(value: string): string   // accepts only https://host[:port]; throws on path, query, http
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// email.test.ts
it.each([["  Brian@B4.RUN ", "brian@b4.run"], ["x@y", undefined], ["", undefined]])("normalizeEmail(%j)", ...)
it("produces the same hmac for equivalent spellings and a different one per secret", ...)
it.each([["a@gmail.com","personal"],["a@mail.proton.me","personal"],["a@cacheplane.ai","work"]])("emailKind(%s)", ...)
// tokens.test.ts
it("round-trips a token for the same purpose and secret", ...)
it.each(["wrong purpose","tampered signature","expired by one second","malformed (no dot)","payload not JSON"])("rejects %s uniformly", ...)  // every rejection is exactly { ok: false }
it("uses constant-time comparison", ...)   // spy on crypto.timingSafeEqual being called once per verify
it.each(["http://b4.run","https://b4.run/x","https://b4.run?x"])("normalizePublicOrigin rejects %s", ...)
```

- [ ] **Step 2: Run tests to verify they fail** — `pnpm --dir apps/web exec vitest --run app/lib/growth/email app/lib/growth/tokens`

- [ ] **Step 3: Implement** both modules with Node `crypto` only.

- [ ] **Step 4: Run tests, lint; commit**

```bash
git add apps/web/app/lib/growth
git commit -m "feat(growth): email normalisation, lookup hmac, email kind, and signed action tokens"
```

---

### Task 3: Contacts: accept a form, stop, reapprove, delete

**Files:**
- Create: `apps/web/app/lib/growth/contacts.ts`
- Create: `apps/web/app/lib/growth/fake-executor.ts` (test support: an in-memory `SqlExecutor` is NOT attempted; instead this file exports `recordingExecutor()` whose `query` returns scripted results in order and records every call, for route and module tests that only need call verification)
- Test: `apps/web/app/lib/growth/contacts.integration.test.ts` (the behavioural coverage; gated), `apps/web/app/lib/growth/contacts.test.ts` (pure helpers: event keys, stop reason validation)

**Interfaces:**
- Consumes: `SqlExecutor`, `normalizeEmail`, `emailLookupHmac`, `emailKind`.
- Produces:
  ```ts
  export const STOP_REASONS = ["unsubscribe", "complaint", "hard_bounce", "provider_suppression", "manual_suppression", "reply_received", "deletion"] as const
  export type StopReason = (typeof STOP_REASONS)[number]
  export const DISCLOSURE_VERSION = "b4_growth_v1.2026-10-20"
  export interface AcceptFormInput { readonly email: string; readonly message?: string; readonly posthogDistinctId?: string; readonly disclosureVersion: string; readonly submissionId: string; readonly now: Date }
  export interface AcceptFormResult { readonly contactId: string; readonly approved: boolean; readonly emailKind: EmailKind; readonly created: boolean }
  export function acceptFounderUpdatesForm(executor: SqlExecutor, secret: string, input: AcceptFormInput): Promise<AcceptFormResult>
  // in one transaction: upsert by email_hmac (insert with source 'founder_updates', or update updated_at only);
  // insert activity kind 'form.accepted', event_key `form:${submissionId}`, data { form: 'founder_updates', message, disclosure_version, email_kind };
  // if stopped_at is null and approved_at is null → set approved_at = now, insert 'contact.approved' with event_key `approved:${contactId}:${now.toISOString()}`;
  // if stopped_at or deleted_at is set → approved stays false, the activity data carries only { form, disclosure_version, email_kind } (no message), and posthog_distinct_id is NOT stored; otherwise posthog_distinct_id is stored when given and currently null
  export interface StopInput { readonly contactId: string; readonly reason: Exclude<StopReason, "deletion">; readonly provenance: string; readonly now: Date }
  export function stopContact(executor: SqlExecutor, input: StopInput): Promise<{ applied: boolean }>
  // applied=false when stopped_at is already set (idempotency is decided by stopped_at, not by the activity key); otherwise clears approved_at, sets stopped_at/stop_reason, inserts activity `stop.${reason}` with event_key `stop:${contactId}:${reason}:${now.toISOString()}` (a contact reapproved and stopped again gets a second, distinct activity), cancels growth_sends with status in ('pending','leased') for the contact
  export function reapproveContact(executor: SqlExecutor, input: { contactId: string; provenance: string; now: Date }): Promise<{ applied: boolean }>  // only when deleted_at is null; clears stopped_at/stop_reason, sets approved_at, activity 'contact.reapproved'
  export function deleteContact(executor: SqlExecutor, input: { contactId: string; now: Date }): Promise<{ applied: boolean }>  // applied=false when deleted_at already set; clears approved_at; sets stopped_at/stop_reason = 'deletion' only when stopped_at is null (an existing stop and its reason are kept); sets deleted_at; nulls per Global Constraints; cancels pending/leased sends; activity 'contact.deleted'
  export function findContactByEmail(executor: SqlExecutor, secret: string, email: string): Promise<ContactRow | undefined>
  export interface ContactRow { readonly id: string; readonly email: string | null; readonly approvedAt: Date | null; readonly stoppedAt: Date | null; readonly stopReason: string | null; readonly deletedAt: Date | null; readonly createdAt: Date }
  export function contactJourney(executor: SqlExecutor, contactId: string): Promise<readonly { kind: string; occurredAt: Date; data: Record<string, unknown> }[]>
  ```

- [ ] **Step 1: Write the failing integration tests** (`describe.skipIf(!GROWTH_DB_TESTS_ENABLED)`, one container per file via `withMigratedDatabase`)

```ts
it("creates and approves a new contact and records both activities", ...)
it("accepts the same email twice as one contact with two form.accepted activities", ...)   // Review Focus 1
it("treats differently-cased and padded spellings as one contact", ...)                    // Review Focus 5
it("never re-approves a stopped contact on a later form", ...)                              // approved: false, stopped_at unchanged
it("stop is idempotent and cancels pending sends", ...)                                     // insert a pending growth_sends row first; second stop applied=false; one activity
it("reapprove clears the stop and records provenance", ...)
it("delete keeps only the hmac and the stop", ...)                                          // email null, display_name null, posthog_distinct_id null, form.accepted data = {}
it("delete on an already-stopped contact keeps the original stop reason", ...)
it("a later form for a deleted contact stores no message and no distinct id", ...)
it("stop after reapproval records a second stop activity", ...)
```

- [ ] **Step 2: Run to verify they fail** — `pnpm --dir apps/web test:growth-db`

- [ ] **Step 3: Implement `contacts.ts`** with parameterised SQL only (no string interpolation of values).

- [ ] **Step 4: Run integration tests green, typecheck, lint; commit**

```bash
git add apps/web/app/lib/growth
git commit -m "feat(growth): contact acceptance, stops, reapproval, and deletion"
```

---

### Task 4: The form route and the server-side conversion signal

**Files:**
- Modify: `apps/web/package.json` (dependency `posthog-node`, latest 5.x pinned exact)
- Modify: `apps/web/app/lib/analytics/events.ts` (events `siteFormSubmit: "site:form_submit"`, `siteFormSuccess: "site:form_success"`, `siteFormFail: "site:form_fail"`, `siteContactAccepted: "site:contact_accepted"`; `SignalProperties` gains `form?: "founder_updates"`, `failure_reason?: string`, `email_kind?: "work" | "personal"` written as literals, since `events.ts` ships to the browser and must not import the server-side `email.ts`)
- Modify: `apps/web/app/lib/analytics/client.ts` (`SIGNAL_PROPERTY_KEYS` gains `form`, `failure_reason`, `email_kind`)
- Modify: `scripts/posthog/contract.ts` (the four events: `site:form_submit|success|fail` required `form`, allowed `form, failure_reason, source_page`, breakdowns `form, failure_reason`; `site:contact_accepted` required `form, email_kind`, allowed the same, breakdowns the same)
- Create: `apps/web/app/lib/growth/env.ts`
- Create: `apps/web/app/lib/growth/forms.ts`
- Create: `apps/web/app/lib/growth/rate-limit.ts`
- Create: `apps/web/app/lib/growth/signals.ts`
- Create: `apps/web/app/lib/growth/routes/founder-updates.ts` (handler + deps) and `apps/web/app/api/growth/forms/founder-updates/route.ts` (`export const POST = …` only)
- Test: `apps/web/app/lib/growth/forms.test.ts`, `rate-limit.test.ts`, `signals.test.ts`, `apps/web/app/lib/growth/routes/founder-updates.test.ts`, extend `scripts/posthog/contract.test.ts` expectations if it enumerates events

**Interfaces:**
- Consumes: `acceptFounderUpdatesForm`, `DISCLOSURE_VERSION`, `createPgExecutor`, `loadGrowthDatabaseUrl`.
- Produces:
  ```ts
  // env.ts
  export interface GrowthEnv { readonly databaseUrl: string; readonly emailHmacSecret: string; readonly tokenSecret: string; readonly environment: "production" | "preview" | "test"; readonly publicOrigin: string; readonly resendWebhookSecret?: string; readonly posthogKey?: string }
  export function loadGrowthEnv(env?: NodeJS.ProcessEnv): GrowthEnv   // throws naming the first missing required variable; environment must be one of the three exactly
  // forms.ts
  export type FounderUpdatesSubmission = { readonly email: string; readonly message?: string; readonly posthogDistinctId?: string; readonly disclosureVersion: string; readonly submissionId: string }
  export type ParseResult = { ok: true; value: FounderUpdatesSubmission } | { ok: false; error: "invalid_body" | "invalid_email" | "message_too_long" | "stale_disclosure" | "honeypot" }
  export function parseFounderUpdatesSubmission(body: unknown): ParseResult
  // body: { email: string; message?: string; website_url?: string (honeypot; non-empty → "honeypot"); disclosure_version: string; submission_id: uuid; posthog_distinct_id?: string ≤ 128 }; message ≤ 1000 chars after trim
  export const FOUNDER_UPDATES_DISCLOSURE = "Occasional B4.run updates from Brian, and I may personally email you once or twice to offer a hands-on session. Unsubscribe with one click, any time."
  // rate-limit.ts
  export function createRateLimiter(input: { limit: number; windowMs: number; now?: () => number }): { allow(key: string): boolean }   // sliding window per key, in memory; prune on each call
  export const FORM_RATE_LIMIT = { limit: 5, windowMs: 10 * 60_000 }   // per serverless instance, best effort (the spec accepts this for v1); Vercel sets x-forwarded-for itself, so its first value is the client
  // signals.ts
  export interface ServerSignalClient { capture(input: { distinctId: string; event: "site:contact_accepted"; properties: { form: "founder_updates"; email_kind: EmailKind } }): Promise<void> }
  export function createPosthogServerClient(key: string): ServerSignalClient   // posthog-node, host https://us.i.posthog.com, flushAt 1; capture called with { distinctId, event, properties: { form, email_kind, $process_person_profile: false }, disableGeoip: true }; awaits shutdown/flush after capture; never throws
  export function noopSignalClient(): ServerSignalClient
  // routes/founder-updates.ts
  export interface FounderUpdatesRouteDeps { loadEnv(): GrowthEnv; createExecutor(url: string): SqlExecutor; createSignals(key: string | undefined): ServerSignalClient; limiter: { allow(key: string): boolean }; now(): Date; randomUUID(): string }
  export function handleFounderUpdatesPost(request: Request, deps: FounderUpdatesRouteDeps): Promise<Response>
  export function defaultFounderUpdatesDeps(): FounderUpdatesRouteDeps   // builds env, executor (one pg pool per process, memoised), signals, limiter lazily
  // api route: export const POST = (request: Request) => handleFounderUpdatesPost(request, defaultFounderUpdatesDeps())
  ```
  Route behaviour: reject non-JSON or > 4096 bytes with 400 `{ error: "invalid_body" }`; a honeypot hit returns 200 `{ ok: true }` without touching the database; rate-limit key is the trusted client IP (`x-forwarded-for` first value, else `"unknown"`), over limit → 429 `{ error: "rate_limited" }`; on success call `acceptFounderUpdatesForm` then `captureContactAccepted` with `distinctId = posthogDistinctId ?? randomUUID()`, respond 200 `{ ok: true }` whether or not the contact was approved (a stop is never disclosed); database errors → 503 `{ error: "unavailable" }` with the cause logged to stderr once.

- [ ] **Step 1: Write the failing tests**

`forms.test.ts`: each error code has one case; a valid body parses with trimmed message. `rate-limit.test.ts`: sixth call in a window is refused, the window slides. `signals.test.ts`: the posthog-node client is constructed with the pinned options and `capture` is called with properties exactly `{ form, email_kind, $process_person_profile: false }` and `disableGeoip: true`; a thrown capture is swallowed. `route.test.ts` with a stubbed `deps`:
```ts
it("accepts a valid submission, stores it, and emits site:contact_accepted with email_kind only", ...)   // assert the captured properties object has exactly form and email_kind
it("returns 200 and skips the database for a honeypot hit", ...)
it("returns 200 for a stopped contact without re-approving", ...)   // acceptFounderUpdatesForm stub returns approved:false → still 200 { ok: true }  (Review Focus 2)
it("returns 429 past the rate limit", ...)
it("returns 503 when the database throws and never leaks the message", ...)
it("rejects a body over 4 KiB", ...)
```

- [ ] **Step 2: Run to verify they fail** — `pnpm --dir apps/web exec vitest --run app/lib/growth app/api/growth` and `pnpm exec vitest --run --config scripts/posthog/vitest.config.ts` (contract pin reds until both sides match)

- [ ] **Step 3: Implement** the modules and the route; add the events on both sides.

- [ ] **Step 4: Run both suites, typecheck, lint, `pnpm --filter @b4run/web build` with no env; commit**

```bash
git add apps/web scripts/posthog pnpm-lock.yaml
git commit -m "feat(growth): founder-updates form route and the server-side contact_accepted signal"
```

---

### Task 5: The `/updates` page, form island, footer and blog links, `/call`

**Files:**
- Create: `apps/web/content/updates.mdx` (the page copy above the form: what you get, the disclosure, link to `/privacy`)
- Create: `apps/web/app/updates/page.tsx`
- Create: `apps/web/app/updates/FounderUpdatesForm.tsx` (`"use client"`)
- Modify: `apps/web/app/seo/types.ts` (`WebPageSeoPage.routeKind: "home" | "legal" | "page"`), `apps/web/app/seo/registry.ts` (`UPDATES_SEO_PAGE`, path `/updates`, title `Updates from the founder`, description `Get occasional B4.run updates from Brian, and an offer of a hands-on session to get your agent into production.`), `apps/web/app/seo/resolve.ts` (inventory after `/privacy`), `apps/web/app/sitemap.ts` (`page` → monthly, 0.5), `apps/web/scripts/generate-seo-lastmod.mjs` (`/updates` → `[app/updates/page.tsx, app/updates/FounderUpdatesForm.tsx, content/updates.mdx]`), `apps/web/app/seo/seo.test.ts` and `apps/web/app/sitemap.test.ts` (96 routes; `/updates` after `/privacy`; one `"page"` kind)
- Modify: `apps/web/app/components/Footer.tsx` (Product column gains `{ label: "Updates", href: "/updates", ctaId: "footer_updates" }`), `apps/web/app/components/blog/BlogCta.tsx` (second link `Get updates from Brian` → `/updates`, `data-cta-id="blog_cta_updates"`), `apps/web/app/lib/analytics/events.ts` (`CTA_IDS` gains `footer_updates`, `blog_cta_updates`)
- Modify: `apps/web/next.config.ts` (`redirects()` gains `{ source: "/call", destination: process.env.B4_CALL_URL ?? "/updates", permanent: false }`)
- Test: `apps/web/app/updates/updates.test.tsx` (jsdom), extend `footer.test.tsx`, `blog-cta.test.tsx`, `signal-attributes.test.tsx`, `production-build-config.test.ts`

**Interfaces:**
- Consumes: `FOUNDER_UPDATES_DISCLOSURE`, `DISCLOSURE_VERSION` (import from a tiny shared module `app/lib/growth/disclosure.ts` created here so the client bundle never imports `contacts.ts`; move the two constants there and re-export from `contacts.ts` and `forms.ts`), `track`, `SIGNAL_EVENTS`.
- Form island behaviour: fields email (required, `type="email"`), message (optional textarea, maxLength 1000), hidden honeypot `website_url` (visually hidden, `tabIndex={-1}`, `autoComplete="off"`), the disclosure paragraph beside the button, submit posts JSON with `submission_id = crypto.randomUUID()` and `posthog_distinct_id` from `posthog.get_distinct_id()` only when posthog-js is loaded (`posthog.__loaded`) and `posthog.has_opted_out_capturing()` is false (all in try/catch; otherwise the field is omitted); emits `site:form_submit` on click, `site:form_success` on 200, `site:form_fail` with `failure_reason` = the error code or `"network"` otherwise; success replaces the form with `Thanks. Watch for a note from Brian.`; failure shows a one-line retry message.

- [ ] **Step 1: Write the failing tests**

```tsx
// updates.test.tsx (jsdom; mock ../lib/analytics/client and global fetch)
it("posts the submission with the current disclosure version and reports submit then success", ...)  // fetch called once with JSON including disclosure_version === DISCLOSURE_VERSION; track called with site:form_submit then site:form_success { form: "founder_updates" }; email never appears in any track call
it("reports site:form_fail with the server's error code", ...)   // fetch → 429 { error: "rate_limited" } → failure_reason "rate_limited"
it("renders the disclosure text verbatim and links /privacy", ...)
```
Footer and blog-cta tests assert the new links and ids; `signal-attributes.test.tsx` picks the new ids up automatically. `production-build-config.test.ts` asserts the `/call` redirect falls back to `/updates` when `B4_CALL_URL` is unset.

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Implement**, register the route, regenerate the manifest after committing content:

```bash
git add apps/web && git commit -m "feat(web): updates page with the founder-updates form"
pnpm --dir apps/web seo:lastmod && pnpm --dir apps/web seo:lastmod:routes
git add apps/web/app/seo/lastmod.generated.json && git commit -m "chore(web): record /updates in the SEO lastmod manifest"
```

- [ ] **Step 4: Full web suite, typecheck, lint, build** — all green.

---

### Task 6: Unsubscribe route

**Files:**
- Create: `apps/web/app/lib/growth/routes/unsubscribe.ts` (handlers + deps) and `apps/web/app/api/growth/unsubscribe/route.ts` (`GET`, `POST` only)
- Create: `apps/web/app/lib/growth/unsubscribe-page.ts` (pure HTML renderers)
- Test: `apps/web/app/lib/growth/routes/unsubscribe.test.ts`, `apps/web/app/lib/growth/unsubscribe-page.test.ts`

**Interfaces:**
- Consumes: `verifyActionToken`, `stopContact`, `loadGrowthEnv`, `createPgExecutor`.
- Produces:
  ```ts
  // unsubscribe-page.ts
  export function renderConfirmPage(input: { token: string }): string   // minimal HTML: heading, a <form method="post"> with hidden token and one button "Unsubscribe", no scripts, token HTML-escaped
  export function renderDonePage(): string
  export function renderFailurePage(): string   // uniform text "This link is not valid."
  // routes/unsubscribe.ts
  export interface UnsubscribeRouteDeps { loadEnv(): GrowthEnv; createExecutor(url: string): SqlExecutor; now(): Date }
  export function handleUnsubscribeGet(request: Request, deps: UnsubscribeRouteDeps): Promise<Response>   // ?token= present and verifies → 200 confirm page; else 400 failure page. GET never mutates.
  export function handleUnsubscribePost(request: Request, deps: UnsubscribeRouteDeps): Promise<Response>
  // token from JSON { token }, urlencoded `token=…`, or the ?token= query (one-click mail clients post `List-Unsubscribe=One-Click` with the token in the URL); verifies with purpose "unsubscribe"; stopContact(reason "unsubscribe", provenance "unsubscribe_link"); 200 done page whether applied was true or false; any verification failure → 400 failure page; no redirects, no cookies
  export function defaultUnsubscribeDeps(): UnsubscribeRouteDeps
  ```
  Every response carries `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and `X-Robots-Tag: noindex`; the tests assert all three on GET and POST.

- [ ] **Step 1: Write the failing tests**

```ts
it("GET with a valid token renders the confirmation without calling stopContact", ...)
it("GET with a bad token renders the uniform failure with 400", ...)
it("POST one-click (urlencoded List-Unsubscribe=One-Click, token in the query) stops the contact and returns 200", ...)   // Review Focus 3
it("POST with a JSON token stops the contact", ...)
it("POST for an already-stopped contact still returns 200 done", ...)
it("POST with a founder_stop token is rejected (wrong purpose)", ...)
it("escapes the token in the confirmation page", ...)
```

- [ ] **Step 2: Run to verify they fail** — [ ] **Step 3: Implement** — [ ] **Step 4: Tests, typecheck, lint; commit**

```bash
git add apps/web/app/api/growth/unsubscribe apps/web/app/lib/growth
git commit -m "feat(growth): signed one-click unsubscribe route"
```

---

### Task 7: Resend webhook route

**Files:**
- Modify: `apps/web/package.json` (dependency `svix`, the version `resend` 6.x pins, exact)
- Create: `apps/web/app/lib/growth/webhooks.ts`
- Create: `apps/web/app/lib/growth/routes/resend-webhook.ts` (handler + deps) and `apps/web/app/api/growth/webhooks/resend/route.ts` (`POST` only)
- Test: `apps/web/app/lib/growth/webhooks.test.ts`, `apps/web/app/lib/growth/routes/resend-webhook.test.ts`, `apps/web/app/lib/growth/webhooks.integration.test.ts`

**Interfaces:**
- Consumes: `stopContact`, `findContactByEmail`, `loadGrowthEnv`.
- Produces:
  ```ts
  // webhooks.ts
  export type ResendEventType = "email.sent" | "email.delivered" | "email.delivery_delayed" | "email.bounced" | "email.complained" | "email.suppressed" | "email.failed"
  export interface ParsedResendEvent { readonly type: ResendEventType; readonly occurredAt: Date; readonly providerEmailId: string; readonly to: readonly string[]; readonly tags: Readonly<Record<string, string>>; readonly bounceType?: "permanent" | "transient" | "unknown" }
  export function parseResendEvent(payload: unknown): ParsedResendEvent | undefined   // undefined for unsupported types or malformed shape; tags come from data.tags (array of {name,value} or object)
  export type WebhookOutcome = "ignored_environment" | "ignored_type" | "updated_delivery" | "stopped" | "already_stopped" | "no_contact"
  export function processResendEvent(executor: SqlExecutor, input: { event: ParsedResendEvent; environment: GrowthEnv["environment"]; emailHmacSecret: string; now: Date }): Promise<WebhookOutcome>
  // tags.environment present and !== environment → ignored_environment (no transaction opened); tags.environment absent → processed only when environment === 'production' (a preview deployment never receives untagged production events), else ignored_environment
  // email.sent/delivered/delivery_delayed/failed → update growth_sends.delivery_status by provider_email_id with precedence (submitted 0 < delivered 1 = failed 1 < bounced 2 < suppressed 3 < complained 4; never downgrade) → updated_delivery, or no_contact when no send matches
  // email.bounced with bounceType permanent → stop hard_bounce; email.complained → stop complaint; email.suppressed → stop provider_suppression; transient bounce → updated_delivery only
  // the contact for a stop is resolved by growth_sends.provider_email_id first, then by every `to` address via findContactByEmail (each matching contact is stopped; outcome 'stopped' if any applied, 'already_stopped' if all were, 'no_contact' if none matched)
  // routes/resend-webhook.ts
  export interface ResendWebhookRouteDeps { loadEnv(): GrowthEnv; createExecutor(url: string): SqlExecutor; verify(input: { payload: string; headers: { id: string; timestamp: string; signature: string }; secret: string }): unknown; now(): Date }
  export function handleResendWebhook(request: Request, deps: ResendWebhookRouteDeps): Promise<Response>
  // missing svix headers or failed verify → 401 { error: "unverified" }; verified but unparseable → 202 { outcome: "ignored_type" }; otherwise 200 { outcome }
  export function defaultResendWebhookDeps(): ResendWebhookRouteDeps   // verify = new Webhook(secret).verify(payload, { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": signature }) from "svix"
  ```

- [ ] **Step 1: Write the failing tests**

`webhooks.test.ts` (parse only): Resend's documented payload shapes for `email.delivered`, `email.bounced` (with `bounce.type`), `email.complained`; tags as array and as object; unknown type → undefined. `route.test.ts` with stub deps: 401 without headers; 401 when verify throws; 200 with outcome. `webhooks.integration.test.ts` (gated):
```ts
it("stops a contact on a permanent bounce and is idempotent on replay", ...)   // Review Focus 4: second call → already_stopped, one activity
it("ignores an event tagged for the other environment", ...)                    // Review Focus 4
it("processes an untagged event only in production", ...)
it("upgrades delivery_status and never downgrades it", ...)
it("resolves the contact by recipient address when no send matches", ...)
```

- [ ] **Step 2: Run to verify they fail** — [ ] **Step 3: Implement** — [ ] **Step 4: Tests (unit + gated), typecheck, lint; commit**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(growth): verified Resend webhook mapping bounces and complaints to stops"
```

---

### Task 8: Founder CLI and operator report

**Files:**
- Create: `apps/web/scripts/growth-control.mts` (`status | approve | stop | delete --email <address>`; `stop` takes `--reason manual_suppression|reply_received`, default `manual_suppression`; `approve` = `reapproveContact` with provenance `founder_cli`)
- Create: `apps/web/scripts/growth-report.mts` (`journey --email <address>` prints the contact row without the email and its activities; `counts` prints totals: contacts, approved, stopped by reason, deleted)
- Modify: `apps/web/package.json` (scripts `growth:control`, `growth:report`)
- Test: `apps/web/app/lib/growth/control.test.ts` (the command functions live in `app/lib/growth/control.ts` so they are testable; the `.mts` files only parse argv and call them)

**Interfaces:**
- Produces: `app/lib/growth/control.ts` exporting `runControl(executor, env, args: { command: "status" | "approve" | "stop" | "delete"; email: string; reason?: StopReason; now: Date }): Promise<string>` (a printable summary; never includes the email hmac or secret) and `runReport(executor, env, args: { command: "journey" | "counts"; email?: string }): Promise<string>`.

- [ ] **Step 1: Write the failing tests** with `recordingExecutor()` from Task 3 for argument/SQL-shape checks and one gated integration case per command.
- [ ] **Step 2: Run red** — [ ] **Step 3: Implement** — [ ] **Step 4: Green, lint; commit**

```bash
git add apps/web
git commit -m "feat(growth): founder control and report commands"
```

---

### Task 9: CI lane, docs, and the privacy page addendum

**Files:**
- Modify: `.github/workflows/ci.yml` (new job `growth-db-docker` modeled on `postgres-storage-docker`: same triggers and guards, `pnpm install`, `pnpm build`, then `pnpm --dir apps/web test:growth-db -- --reporter=json --outputFile.json="$RUNNER_TEMP/growth-db.json"`, then a receipt step `node -e` that reads that JSON and fails unless at least one `*.integration.test.ts` file reports `numPassingTests > 0` and no file is skipped, so the lane cannot pass by skipping; not added to `validate`'s required lanes)
- Modify: `scripts/release/test/fixtures/workflow-entrypoints.json` and `workflow-safe-executables.json` (transcribe the new job's steps; every workflow change must be audited there, see CONTRIBUTORS.md "Workflow entrypoints and executable steps have exact fixtures")
- Modify: `docs/growth/README.md` (Ownership rows for `app/lib/growth`, the routes, and the scripts; Operator commands `growth:migrate`, `growth:control`, `growth:report`; Environment: the eight variables and which command/route needs which; a "Contacts and stops" section stating the authorisation rules verbatim from Global Constraints; measurement limit: a form acceptance is not a verified person)
- Modify: `apps/web/content/privacy.mdx` (the email section now describes the form and the stops exactly as built: what is stored, one-click unsubscribe, bounce/complaint handling, deletion by email to `brian@b4.run`; also add that the website honours Do Not Track and records Core Web Vitals, the deferred phase 1 item; bump "Last updated"), then regenerate the lastmod manifest
- Test: `node --test scripts/release/test/workflow-contracts.test.mjs`, `node scripts/check-docs.mjs`, `pnpm --dir apps/web seo:lastmod:routes`

- [ ] **Step 1: Make the changes** — [ ] **Step 2: Run the three checks plus `pnpm lint`** — [ ] **Step 3: Commit content, regenerate manifest, commit manifest**

```bash
git add .github docs scripts/release/test/fixtures apps/web/content && git commit -m "docs(growth): phase 2 operations, privacy addendum, and the growth database CI lane"
pnpm --dir apps/web seo:lastmod && git add apps/web/app/seo/lastmod.generated.json && git commit -m "chore(web): record the privacy update in the SEO lastmod manifest"
```

---

### Task 10: Full validation and owner handoff

- [ ] **Step 1:** `pnpm ci:validate` green on the head (the sandbox bounded-filesystem timeouts under full-suite load are a known unrelated flake; confirm the file passes alone if they appear). Also `pnpm --dir apps/web test:growth-db` green locally with Docker.
- [ ] **Step 2: PR description handoff list** — owner actions outside the repo, in order:
  1. Create the Neon project with two branches or databases (preview, production); set `GROWTH_DATABASE_URL` (pooled URL) in Vercel for Production and Preview separately.
  2. Generate `GROWTH_EMAIL_HMAC_SECRET` and `GROWTH_TOKEN_SECRET` (32 random bytes each, base64), set them in Vercel for both targets; set `GROWTH_ENVIRONMENT` to `production` / `preview` per target; set `GROWTH_PUBLIC_ORIGIN=https://b4.run` for Production.
  3. Run `pnpm --dir apps/web growth:migrate` once per database with that database's URL.
  4. In Resend, add `b4.run` as a verified sending domain, create a webhook to `https://b4.run/api/growth/webhooks/resend` for the seven event types, and set `RESEND_WEBHOOK_SECRET` in Vercel Production.
  5. Set `B4_CALL_URL` in Vercel to the Google Calendar appointment page so `/call` stops falling back to `/updates`.
  6. Verify in preview: submit the form with a controlled address, run `pnpm --dir apps/web growth:report journey --email …` against the preview database, open the unsubscribe URL from `growth:control status`, and confirm the stop.
- [ ] **Step 3:** Open the PR with superpowers:finishing-a-development-branch.
