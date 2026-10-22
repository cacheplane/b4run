# Growth Phase 3: Founder Sequence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send the three-email founder sequence to approved contacts, scheduled by our database and delivered by Resend, with a daily founder digest and a one-click founder stop, all behind explicit switches that default off.

**Architecture:** Everything stays in `apps/web` on top of phase 2's control plane (`apps/web/app/lib/growth/`). Pure modules (schedule, templates and checker, message composition) are unit-tested; the database-touching sequence engine is tested with the gated Postgres suite. A Vercel cron calls one route every 30 minutes; that route enrolls, leases, authorises, and submits through a small `fetch`-based Resend client. No email leaves unless `GROWTH_DELIVERY_ENABLED` is exactly `true`.

**Tech Stack:** Next.js 16.3 route handlers (Node runtime), `pg` (phase 2 executor), `fetch` against Resend's REST API, `Intl.DateTimeFormat` for Pacific time, vitest 4, `@testcontainers/postgresql` (phase 2 gated suite).

**Spec:** `docs/superpowers/specs/2026-10-20-growth-lifecycle-design.md` — sections "Founder sequence", "Scheduler", "Stops and webhooks" (the digest and `founder_stop` link), phase 3 of "Phases". Phase 2's plan (`docs/superpowers/plans/2026-10-21-growth-phase-2-persist-contacts.md`) and code are the base this builds on.

**Branch base:** this plan is written on `blove/growth-phase-3-sequence`, cut from phase 2's branch (PR cacheplane/b4run#1070). Execute it after #1070 merges: merge `main` into this branch first, so phase 2 arrives as merged history.

**Deviations from the spec, decided here:**
- **No Resend SDK.** `resend` 6.x depends on `svix` 1.88.0, which pulls `uuid@10`, which the repo's dependency-security test forbids (and forbids overriding). The sender calls `POST https://api.resend.com/emails` with `fetch`.
- **`CRON_SECRET`, not `GROWTH_CRON_SECRET`.** Vercel attaches `Authorization: Bearer <value>` to cron requests only from a variable named `CRON_SECRET`.
- **No form nudge.** Step 1 is due at 07:00 Pacific on the next weekday, so a tick within 30 minutes of the form adds nothing; the cron alone drives enrollment.
- **Batches of 10, looped.** A route has 60 seconds; the tick leases ten at a time and keeps going until nothing is due or 40 seconds have passed, pacing sends 600 ms apart for Resend's rate limit.
- **Digest sends only when there is something to report** (new contacts or in-flight sequences), once per Pacific weekday.
- **Once per contact.** Enrollment requires that the contact has no `growth_sends` row, so a contact who was stopped and later reapproved by the founder is not re-enrolled (the spec's "once per contact"); `growth:control status` says so.
- **Byte-identical retries.** Every token embedded in an email is minted from a stable time (a send's `created_at`; a digest's Pacific date at 07:00), so a retry under the same `Idempotency-Key` carries the same body and Resend can reconcile it instead of answering 409.

## Global Constraints

- Everything from phase 2's Global Constraints still binds (no "tracking" wording; no personal data to PostHog; `approved_at` is the only send-authorisation field; stops are idempotent and never reversed by a form; env read lazily, never at import; `next build` passes with no growth env; parameterised SQL only; route files export only HTTP verbs and segment config; `exactOptionalPropertyTypes`; extensionless imports in `apps/web`; Biome via `pnpm --dir apps/web lint`).
- Pacific time zone `America/Los_Angeles`. Send window: Monday–Friday, local hour 7 (07:00–07:59). Step 1 due 07:00 next weekday after approval; step 2 three business days after step 1 is accepted; step 3 five business days after step 2 is accepted. Weekends skipped; holidays not excluded.
- Sender exactly `Brian at B4.run <brian@b4.run>`; Reply-To the same; BCC `GROWTH_FOUNDER_EMAIL` (default `brian@b4.run`); plain text only.
- Headers on every sequence email: `List-Unsubscribe: <{unsubscribeUrl}>`, `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, `X-B4-Send-ID: {sendId}`. Resend tags: `environment={GROWTH_ENVIRONMENT}`, `kind=sequence`, `step={1|2|3}` (the phase 2 webhook ignores events whose `environment` tag differs).
- `Idempotency-Key` header on every Resend request: `seq:v1:{contactId}:step:{n}` for sequence mail, `digest:{YYYY-MM-DD}` for the digest.
- Switches, all exact-string: `GROWTH_SEQUENCE_ENABLED=true` enables enrollment and requires `GROWTH_SEQUENCE_START_AT` (ISO 8601, immutable launch time; only contacts with `approved_at >= START_AT` are ever enrolled); `GROWTH_DELIVERY_ENABLED=true` enables leasing and sending. Anything else means off.
- The draft checker is a port of Threadplane's `campaignDraftViolations` (`~/repos/angular-agent-framework/apps/lifecycle/src/campaign/templates.ts`): subject ≤ 80 chars, no newline, no URL in the subject; body ≤ 120 words and ≤ 1200 chars; at most one `?` and one link; links only from the approved set `https://b4.run/call`, `https://b4.run/docs/getting-started`; no HTML, no Markdown links or images, no injected headers, no email addresses, no calendar hosts, no `utm_` or click-wrapper markup, no relative/protocol-relative/dot-relative links, no non-http(s) schemes, no surveillance phrases (same pattern as Threadplane's, plus the word "tracking").
- The unsubscribe footer is appended after the checker runs, so it never counts against the one-link limit: `\n\n--\nUnsubscribe with one click: {unsubscribeUrl}`.
- Never log an email address, a token, or a secret. Logs carry send ids, contact ids, steps, and error codes only.

## Review Focus

1. A stop (unsubscribe, bounce, founder stop) that lands while a tick is mid-send must win: no email to that contact after the stop commits, and the next step is cancelled. Pinned in Task 5 with a concurrent stop-versus-send test.
2. A tick that runs twice inside one window (Vercel retries, two ticks at :00 and :30) must not send any step twice. Pinned in Task 5 (lease idempotency) and Task 4 (Idempotency-Key header).
3. A send that times out after Resend may have accepted it must not double-send on retry and must not schedule the next step twice. Pinned in Task 5 (same idempotency key on retry; next step inserted `on conflict do nothing`).
4. Approvals that cross a DST change or land on Friday evening Pacific must still schedule step 1 at 07:00 local on the next weekday. Pinned in Task 1.
5. A contact approved before `GROWTH_SEQUENCE_START_AT` must never be enrolled, even after the switch flips. Pinned in Task 5.

---

### Task 1: Pacific schedule

**Files:**
- Create: `apps/web/app/lib/growth/schedule.ts`
- Test: `apps/web/app/lib/growth/schedule.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const SEQUENCE_TIME_ZONE = "America/Los_Angeles"
  export function businessMorningAfter(anchor: Date, businessDays: number): Date   // 07:00 local on the Nth weekday after the anchor's local date; throws for businessDays outside 1..366 or an invalid date
  export function isSendWindow(now: Date): boolean                                   // weekday and local hour === 7
  export function pacificCalendarDate(now: Date): { date: string; weekday: boolean } // "YYYY-MM-DD" in Pacific
  export const STEP_DELAY_BUSINESS_DAYS: Readonly<Record<2 | 3, number>>             // { 2: 3, 3: 5 }
  ```
  Port Threadplane's `campaign-schedule.ts` (read it); keep its DST-safe hour correction.

- [ ] **Step 1: Write the failing tests**

```ts
it("schedules a Monday-noon approval for Tuesday 07:00 PDT", ...)        // 2026-10-19T19:00Z → 2026-10-20T14:00Z
it("schedules a Friday-evening approval for Monday 07:00", ...)          // 2026-10-23T03:00Z (Thu 20:00 PDT) → Fri 2026-10-23T14:00Z; 2026-10-24T02:00Z (Fri 19:00 PDT) → Mon 2026-10-26T14:00Z
it("keeps 07:00 local across the November DST change", ...)              // anchor 2026-10-30T18:00Z (Fri), 1 day → Mon 2026-11-02T15:00Z (PST)
it("counts three and five business days for steps 2 and 3", ...)         // Tue 2026-10-20T14:05Z +3 → Fri 2026-10-23T14:00Z; +5 → Tue 2026-10-27T14:00Z
it.each([[0],[367],[1.5]])("rejects an offset of %s", ...)
it("opens the window only on weekdays during local hour 7", ...)         // 2026-10-20T14:00Z true; 2026-10-20T15:00Z false; 2026-10-24T14:30Z (Sat) false; 2026-11-02T15:30Z (PST Mon) true
it("reports the Pacific calendar date across UTC midnight", ...)         // 2026-10-21T05:00Z → "2026-10-20", weekday true
```

- [ ] **Step 2: Run red** — `pnpm --dir apps/web exec vitest --run app/lib/growth/schedule.test.ts`
- [ ] **Step 3: Implement** `schedule.ts`.
- [ ] **Step 4: Run green, lint; commit** `feat(growth): Pacific business-day schedule for the founder sequence`

---

### Task 2: Token key rotation

Unsubscribe links in sent mail live five years, so the signing secret must be rotatable before the first send.

**Files:**
- Modify: `apps/web/app/lib/growth/tokens.ts`, `apps/web/app/lib/growth/env.ts`
- Modify: every existing caller of `createActionToken` / `verifyActionToken` (the unsubscribe route, `control.ts`) to pass the keyring; later tasks use the keyring signature from the start
- Test: `apps/web/app/lib/growth/tokens.test.ts`, `env.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface TokenKeyring { readonly active: { id: number; secret: string }; readonly previous: readonly { id: number; secret: string }[] }
  export function createActionToken(input: { keyring: TokenKeyring; contactId: string; purpose: ActionTokenPurpose; issuedAt: Date }): string   // payload k = active.id
  export function verifyActionToken(input: { token: string; keyring: TokenKeyring; purpose: ActionTokenPurpose; now: Date }): { ok: true; contactId: string } | { ok: false }  // picks the secret whose id equals the payload's k; unknown k → { ok: false }
  ```
  `GrowthEnv` gains `tokenKeyring: TokenKeyring` built from `GROWTH_TOKEN_SECRET` (active), `GROWTH_TOKEN_KEY_ID` (positive integer, default `1`), and `GROWTH_TOKEN_PREVIOUS_KEYS` (optional, comma-separated `id:secret`, ids distinct from the active id); `tokenSecret` is removed. Existing tokens (k = 1) keep verifying with the defaults.

- [ ] **Step 1: Write the failing tests**: a token minted under key 1 verifies after rotating to key 2 with key 1 listed as previous; fails once key 1 is dropped; unknown `k` fails uniformly; malformed `GROWTH_TOKEN_PREVIOUS_KEYS` or a duplicate id throws at load.
- [ ] **Step 2: Run red** — [ ] **Step 3: Implement and update callers** — [ ] **Step 4: Growth unit + gated suites, typecheck, lint; commit** `feat(growth): rotatable token signing keys`

---

### Task 3: Sequence configuration, copy, and the draft checker

**Files:**
- Create: `apps/web/app/lib/growth/sequence-env.ts`
- Create: `apps/web/app/lib/growth/sequence-copy.ts`
- Test: `apps/web/app/lib/growth/sequence-env.test.ts`, `apps/web/app/lib/growth/sequence-copy.test.ts`

**Interfaces:**
- Consumes: `GrowthEnv`, `loadGrowthEnv` (phase 2 `env.ts`).
- Produces:
  ```ts
  // sequence-env.ts
  export interface SequenceEnv extends GrowthEnv {
    readonly sequenceEnabled: boolean
    readonly sequenceStartAt?: Date          // required (throws) when sequenceEnabled
    readonly deliveryEnabled: boolean
    readonly resendApiKey?: string            // required (throws) when deliveryEnabled
    readonly cronSecret?: string
    readonly founderEmail: string             // GROWTH_FOUNDER_EMAIL, default "brian@b4.run"
  }
  export function loadSequenceEnv(env?: NodeJS.ProcessEnv): SequenceEnv
  // sequence-copy.ts
  export type SequenceStep = 1 | 2 | 3
  export interface Draft { readonly subject: string; readonly body: string }
  export const APPROVED_LINKS: ReadonlySet<string>   // "https://b4.run/call", "https://b4.run/docs/getting-started"
  export const BOOKING_URL = "https://b4.run/call"
  export const SEQUENCE_DRAFTS: Readonly<Record<SequenceStep, Draft>>
  export function draftViolations(candidate: unknown): string[]
  export function sequenceDraft(step: SequenceStep): Draft    // returns the normalised draft; throws listing violations if any
  ```
  Draft copy (Brian may edit later; the checker enforces the shape):
  - Step 1, subject `Engineer to engineer`: two or three short paragraphs saying he saw they signed up for B4.run updates, he is the founder offering short engineer-to-engineer sessions to get their agent running, no sales; ends `Reply if that would help.` No link.
  - Step 2, subject `Get your agent into production`: a 30-minute hands-on session to fix what is in the way, no sales; ends with `Book a time with me:` and `https://b4.run/call` on its own line.
  - Step 3, subject `One last note from the B4.run founder`: same offer plus a line that the feedback helps him improve B4.run; `https://b4.run/call`; final line `This is my last automated follow-up.`

- [ ] **Step 1: Write the failing tests**

`sequence-env.test.ts`: both switches default off; only exact `true` enables; enabling the sequence without `GROWTH_SEQUENCE_START_AT` throws naming it; an unparseable start time throws; enabling delivery without `RESEND_API_KEY` throws naming it; `founderEmail` defaults to `brian@b4.run`; a blank `CRON_SECRET` yields undefined.
`sequence-copy.test.ts`: all three drafts pass `draftViolations` with `[]`; step 1 contains no link; steps 2 and 3 contain exactly `https://b4.run/call`; one failing case per checker rule (port Threadplane's `templates.spec.ts` cases: long subject, newline in subject, URL in subject, 121 words, two questions, two links, unapproved link, HTML, Markdown link, header injection, email address, calendar host, `utm_source`, relative link, `ftp:` scheme, "I noticed you", "tracking"); `sequenceDraft` throws for a mutated draft.

- [ ] **Step 2: Run red** — [ ] **Step 3: Implement** (port the checker's patterns; adapt `APPROVED_LINKS`) — [ ] **Step 4: Green, lint; commit** `feat(growth): sequence switches, founder copy, and the draft checker`

---

### Task 4: Message composition and the Resend client

**Files:**
- Create: `apps/web/app/lib/growth/mailer.ts`
- Test: `apps/web/app/lib/growth/mailer.test.ts`

**Interfaces:**
- Consumes: `Draft`, `SequenceStep`, `sequenceDraft` (Task 3); `unsubscribeUrl` (phase 2 `tokens.ts`).
- Produces:
  ```ts
  export const SENDER = "Brian at B4.run <brian@b4.run>"
  export interface OutgoingEmail {
    readonly from: string; readonly to: string; readonly replyTo: string; readonly bcc?: string
    readonly subject: string; readonly text: string
    readonly headers: Readonly<Record<string, string>>
    readonly tags: readonly { name: string; value: string }[]
    readonly idempotencyKey: string
  }
  export function composeSequenceEmail(input: { step: SequenceStep; to: string; sendId: string; contactId: string; unsubscribeUrl: string; founderEmail: string; environment: string }): OutgoingEmail
  export function composeDigestEmail(input: { to: string; date: string; text: string; environment: string }): OutgoingEmail   // subject `B4.run founder digest {date}`, no BCC, tags kind=digest, idempotencyKey `digest:{date}`
  export type SendResult =
    | { kind: "accepted"; providerEmailId: string }
    | { kind: "rejected"; code: string }      // 4xx other than 429 and the concurrent-request 409, including 409 invalid_idempotent_request (code "idempotency_mismatch"): permanent, do not retry
    | { kind: "retryable"; code: string }     // 409 concurrent_idempotent_requests, 429 (code "http_429"), 5xx, network error, timeout
  export interface Mailer { send(email: OutgoingEmail): Promise<SendResult> }
  export function createResendMailer(apiKey: string, fetchImpl?: typeof fetch, timeoutMs?: number): Mailer   // default timeout 5000
  ```
  Request: `POST https://api.resend.com/emails`, `Authorization: Bearer {apiKey}`, `Content-Type: application/json`, `Idempotency-Key: {idempotencyKey}`, body `{ from, to: [to], reply_to: replyTo, bcc?: [bcc], subject, text, headers, tags }`. Success is 200 with `{ id }`. A response or error is never logged with addresses; `code` is `http_{status}`, `timeout`, or `network`.

- [ ] **Step 1: Write the failing tests**

```ts
it("composes step 2 with the checked draft, footer, headers, tags, and idempotency key", ...)
// text = draft.body + "\n\n--\nUnsubscribe with one click: <url>"; headers List-Unsubscribe "<url>", List-Unsubscribe-Post "List-Unsubscribe=One-Click", X-B4-Send-ID sendId; tags environment/kind=sequence/step=2; idempotencyKey "seq:v1:<contactId>:step:2"; from and replyTo SENDER; bcc founderEmail
it("posts to Resend with the bearer key and Idempotency-Key and returns the provider id", ...)  // stub fetch; assert URL, method, headers, JSON body shape
it.each([[422,"rejected"],[400,"rejected"],[429,"retryable"],[500,"retryable"]])("maps HTTP %s to %s", ...)
it("maps a 409 concurrent_idempotent_requests to retryable and a 409 invalid_idempotent_request to rejected idempotency_mismatch", ...)  // read the JSON error body's `name`
it("maps a timeout and a thrown fetch to retryable", ...)
it("never includes the recipient address in a result code", ...)
```

- [ ] **Step 2: Run red** — [ ] **Step 3: Implement** with `AbortSignal.timeout(timeoutMs)` — [ ] **Step 4: Green, lint; commit** `feat(growth): plain-text sequence composition and a fetch-based Resend client`

---

### Task 5: The sequence engine — enroll, lease, authorise, send

**Files:**
- Create: `apps/web/app/lib/growth/sequence.ts`
- Test: `apps/web/app/lib/growth/sequence.test.ts` (pure helpers), `apps/web/app/lib/growth/sequence.integration.test.ts` (gated)

**Interfaces:**
- Consumes: `SqlExecutor`; `businessMorningAfter`, `isSendWindow`, `STEP_DELAY_BUSINESS_DAYS` (Task 1); `SequenceEnv` (Task 3); `composeSequenceEmail`, `Mailer`, `SendResult` (Task 4); `createActionToken` with the keyring signature (Task 2), `unsubscribeUrl` (phase 2).
- Produces:
  ```ts
  export const SEND_BATCH = 10
  export const LEASE_SECONDS = 300
  export const MAX_ATTEMPTS = 3
  export const sendIdempotencyKey = (contactId: string, step: SequenceStep) => `seq:v1:${contactId}:step:${step}`
  export function enrollApprovedContacts(executor: SqlExecutor, input: { startAt: Date; now: Date }): Promise<{ enrolled: number }>
  // inserts step 1 (status 'pending', due_at = businessMorningAfter(approved_at, 1)) for contacts with approved_at >= startAt, approved_at not null, stopped_at null, deleted_at null, and no growth_sends row; key sendIdempotencyKey(id, 1) with on conflict do nothing; records activity 'sequence.enrolled' event_key `enrolled:v1:{contactId}`
  export function leaseDueSends(executor: SqlExecutor, input: { now: Date; limit: number; leaseToken: string }): Promise<readonly LeasedSend[]>
  // first marks expired leases with attempts >= MAX_ATTEMPTS as status 'failed', delivery_status 'unknown', last_error_code 'lease_expired' (so a crash on the last attempt is not stranded); then one statement: pending and due, or leased with lease_until <= now; attempts < MAX_ATTEMPTS; order by due_at, id; for update skip locked; sets status 'leased', lease_token, lease_until = now + LEASE_SECONDS, attempts + 1
  export const SEND_PACING_MS = 600   // the tick waits this long between sends (Resend's default limit is about 2 requests per second)
  export interface LeasedSend { readonly id: string; readonly contactId: string; readonly step: SequenceStep; readonly attempts: number; readonly leaseToken: string }
  export type SendOutcome = "sent" | "cancelled_not_authorised" | "rejected" | "retry_later" | "failed_attempts" | "lease_lost"
  export function authoriseAndSend(executor: SqlExecutor, input: { send: LeasedSend; env: SequenceEnv; mailer: Mailer; now: Date }): Promise<SendOutcome>
  ```
  `authoriseAndSend` algorithm (one transaction, so a concurrent stop waits for it and then cancels anything it inserted). Lock order is contact first, then send — the same order `stopContact` uses (it updates the contact, then cancels sends) — so the two can never deadlock:
  1. `select email, approved_at, stopped_at, deleted_at from growth_contacts where id = $1 for update`.
  2. `select … from growth_sends where id = $1 and lease_token = $2 for update` — none → `lease_lost` (this is also what a stop that committed after leasing produces, since `stopContact` cancels leased sends and clears the token).
  3. If not (`approved_at` not null and `stopped_at` null and `deleted_at` null and `email` not null) → set the send `cancelled`, clear the lease → `cancelled_not_authorised`.
  4. Build the unsubscribe URL with an `unsubscribe` token minted with `keyring: env.tokenKeyring` and `issuedAt: send.created_at` (stable across retries, well inside the 5-year max age) and compose; call `mailer.send`.
  5. `accepted` → send `status='submitted'`, `delivery_status='submitted'`, `provider_email_id`, clear the lease, `last_error_code=null`; activity `send.submitted` key `submitted:{sendId}`; if step < 3 insert step+1 `pending` with `due_at = businessMorningAfter(now, STEP_DELAY_BUSINESS_DAYS[step+1])`, key `sendIdempotencyKey(contactId, step+1)`, `on conflict (idempotency_key) do nothing` → `sent`.
  6. `rejected` → `status='failed'`, `last_error_code=code` → `rejected`.
  7. `retryable` with code `http_429` → back to `pending` with the lease cleared and `attempts = attempts - 1` (a rate limit never consumes an attempt) → `retry_later`. Any other `retryable` → if `attempts >= MAX_ATTEMPTS`: `status='failed'`, `delivery_status='unknown'`, `last_error_code=code` → `failed_attempts`; else back to `pending` with the lease cleared and `last_error_code=code` → `retry_later` (the same idempotency key on retry makes a Resend-side duplicate impossible within Resend's 24-hour window).

- [ ] **Step 1: Write the failing tests**

`sequence.test.ts`: `sendIdempotencyKey` format; constants.
`sequence.integration.test.ts` (`describe.skipIf(!GROWTH_DB_TESTS_ENABLED)`, a stub `Mailer` recording calls):
```ts
it("enrolls an approved contact once with step 1 due the next business morning", ...)
it("never enrolls a contact approved before the start time", ...)                 // Review Focus 5
it("never enrolls a stopped or deleted contact", ...)
it("leases each due send once even when two ticks lease concurrently", ...)      // Review Focus 2: Promise.all of two leaseDueSends → disjoint sets
it("reclaims an expired lease and marks an exhausted expired lease failed", ...)
it("a 429 returns the send to pending without consuming an attempt", ...)
it("never re-enrolls a contact who was stopped and reapproved", ...)
it("sends step 1, records the provider id, and schedules step 2 three business days later", ...)
it("schedules step 3 five business days after step 2 and nothing after step 3", ...)
it("cancels instead of sending when the contact was stopped after leasing", ...)
it("a stop that races a send leaves no pending next step and never deadlocks", ...) // Review Focus 1: start authoriseAndSend with a mailer that waits on a promise, issue stopContact concurrently, release; assert neither rejects (no 40P01), the stop applied, the next step cancelled, at most one mailer call
it("a stop that commits between leasing and sending yields lease_lost and no mail", ...)
it("a retryable failure retries with the same idempotency key and a byte-identical email", ...) // Review Focus 3: second attempt's OutgoingEmail deep-equals the first's; next step inserted once
it("a rejected send fails permanently and schedules nothing", ...)
it("never puts an address in last_error_code", ...)
```

- [ ] **Step 2: Run red** (`pnpm --dir apps/web test:growth-db`) — [ ] **Step 3: Implement** — [ ] **Step 4: Green (unit + gated), typecheck, lint; commit** `feat(growth): enroll, lease, authorise, and send the founder sequence`

---

### Task 6: Founder digest and the founder stop link

**Files:**
- Create: `apps/web/app/lib/growth/digest.ts`
- Create: `apps/web/app/lib/growth/routes/founder-stop.ts`
- Create: `apps/web/app/api/growth/founder-stop/route.ts`
- Modify: `apps/web/app/lib/growth/unsubscribe-page.ts` (renderers take the form `action` path and the button label, so both routes share them; the unsubscribe route passes its current values)
- Modify: `apps/web/app/lib/growth/webhooks.ts` (an event whose `kind` tag is `digest` returns `ignored_type` before any contact lookup, so a bounce of the founder's own digest can never stop the founder's contact record) and its tests
- Test: `apps/web/app/lib/growth/digest.test.ts`, `apps/web/app/lib/growth/digest.integration.test.ts` (gated), `apps/web/app/lib/growth/routes/founder-stop.test.ts`, extend `unsubscribe-page.test.ts`

**Interfaces:**
- Consumes: `composeDigestEmail`, `Mailer` (Task 4); `pacificCalendarDate`, `isSendWindow` (Task 1); `createActionToken`, `verifyActionToken` with the keyring signature (Task 2; purpose `founder_stop`, 7-day max age already defined); `stopContact`; phase 2 route conventions and `getSharedExecutor`.
- Produces:
  ```ts
  // digest.ts
  export interface DigestData { readonly date: string; readonly newContacts: readonly { email: string; approvedAt: Date }[]; readonly inFlight: readonly { contactId: string; email: string; nextStep: SequenceStep; dueAt: Date }[] }
  export function readDigestData(executor: SqlExecutor, input: { now: Date; since: Date }): Promise<DigestData>
  export function renderDigestText(data: DigestData, stopUrlFor: (contactId: string) => string): string   // plain text: counts, one line per new contact, one line per in-flight contact with its next step, due time in Pacific, and its stop URL
  export function sendDailyDigest(executor: SqlExecutor, input: { env: SequenceEnv; mailer: Mailer; now: Date }): Promise<"sent" | "nothing_to_report" | "already_sent" | "outside_window" | "failed">
  // stop tokens minted with issuedAt = the digest date at 07:00 Pacific, so a retry is byte-identical; only inside isSendWindow; claims the day by inserting activity 'digest.sent' event_key `digest:{date}` (on conflict do nothing → already_sent) in the same transaction that sends; since = the previous digest activity's occurred_at or now - 24h; nothing to report → no send and no claim
  // routes/founder-stop.ts — same shape as routes/unsubscribe.ts
  export function handleFounderStopGet(request: Request, deps: FounderStopRouteDeps): Promise<Response>
  export function handleFounderStopPost(request: Request, deps: FounderStopRouteDeps): Promise<Response>
  // token purpose "founder_stop"; POST stops with reason "reply_received", provenance "founder_stop_link"; same headers (no-store, no-referrer, noindex), same uniform failure page, form action "/api/growth/founder-stop", button "Stop the sequence"
  ```

- [ ] **Step 1: Write the failing tests**

`digest.test.ts`: `renderDigestText` lists counts, each new contact, each in-flight contact with step and a Pacific due time, and a stop URL per in-flight contact; empty sections say `none`.
`digest.integration.test.ts`: sends once per Pacific date (second call `already_sent`); `nothing_to_report` sends and claims nothing; `outside_window` outside hour 7; `since` advances to the previous digest.
`webhooks.test.ts` / gated: a `kind=digest` bounce, complaint, or suppression returns `ignored_type` and stops nothing even when `to` matches a contact.
`founder-stop.test.ts`: mirrors the unsubscribe route tests for the founder-stop purpose; an `unsubscribe` token is rejected here and a `founder_stop` token is rejected by the unsubscribe route; all three privacy headers asserted.

- [ ] **Step 2: Run red** — [ ] **Step 3: Implement** — [ ] **Step 4: Green (unit + gated), typecheck, lint, build; commit** `feat(growth): daily founder digest with one-click founder stop links`

---

### Task 7: The tick route and the cron

**Files:**
- Create: `apps/web/app/lib/growth/routes/tick.ts`
- Create: `apps/web/app/api/growth/tick/route.ts` (`GET` only; `runtime = "nodejs"`, `dynamic = "force-dynamic"`, `maxDuration = 60`)
- Modify: `apps/web/vercel.json` (add `"crons": [{ "path": "/api/growth/tick", "schedule": "*/30 * * * *" }]`)
- Test: `apps/web/app/lib/growth/routes/tick.test.ts`, extend whichever existing test reads `vercel.json` (or add one in `app/production-build-config.test.ts`) to assert the cron entry

**Interfaces:**
- Consumes: Tasks 1–6; `getSharedExecutor`.
- Produces:
  ```ts
  export interface TickDeps { loadEnv(): SequenceEnv; createExecutor(url: string): SqlExecutor; createMailer(apiKey: string): Mailer; now(): Date; randomUUID(): string; elapsedMs(): number }
  export interface TickReport { readonly enrolled: number; readonly leased: number; readonly outcomes: Readonly<Partial<Record<SendOutcome, number>>>; readonly digest: string; readonly windowOpen: boolean }
  export function handleTick(request: Request, deps: TickDeps): Promise<Response>
  ```
  Behaviour: missing or wrong `Authorization: Bearer {CRON_SECRET}` → 401 (also when `CRON_SECRET` is unset); compare in constant time. Then: enroll when `sequenceEnabled`; when `deliveryEnabled` and `isSendWindow(now)`: repeatedly lease up to `SEND_BATCH` and run `authoriseAndSend` sequentially, waiting `SEND_PACING_MS` between sends, until nothing is due or `elapsedMs() > 40_000` before starting the next send (remaining leases expire and are reclaimed); when `deliveryEnabled`, call `sendDailyDigest`. Respond 200 with the `TickReport` (counts only, no ids or addresses). An exception → 500 `{ error: "tick_failed" }`, message to stderr.

- [ ] **Step 1: Write the failing tests**

```ts
it("rejects a missing, wrong, or unconfigured cron secret with 401", ...)
it("enrolls only when the sequence switch is on", ...)
it("leases and sends nothing when delivery is off", ...)                      // spec: GROWTH_DELIVERY_ENABLED=false leases nothing
it("sends only inside the Pacific window", ...)
it("keeps leasing batches until nothing is due", ...)
it("stops starting sends after 40 seconds", ...)                              // elapsedMs stub crosses 40_000 after the first send
it("reports counts and never addresses", ...)
```
plus the `vercel.json` cron assertion.

- [ ] **Step 2: Run red** — [ ] **Step 3: Implement** — [ ] **Step 4: Green, typecheck, lint, build with no env; commit** `feat(growth): 30-minute tick route driving enrollment, sends, and the digest`

---

### Task 8: Founder CLI and report

**Files:**
- Modify: `apps/web/app/lib/growth/control.ts`, `apps/web/scripts/growth-control.mts`, `apps/web/scripts/growth-report.mts`
- Test: `apps/web/app/lib/growth/control.test.ts`

**Interfaces:**
- `status` prints `not re-enrolled (once per contact)` for a reapproved contact that already has sends.
- `runControl` `approve` refuses a contact whose `stop_reason` is `complaint` or `hard_bounce` unless `force: true` (`--force`), with message `refusing to reapprove a contact stopped for <reason>; pass --force to override`.
- `status` gains a sequence line per step: `step N: <status> <delivery_status> due <ISO>` (or `not enrolled`).
- `runReport` gains `sends`: counts by step × status and by delivery status, plus the date of the last digest.

- [ ] **Step 1: Write the failing tests** (recording-executor shape tests plus a gated end-to-end block) — [ ] **Step 2: Run red** — [ ] **Step 3: Implement** — [ ] **Step 4: Green, typecheck (scripts are included), lint; commit** `feat(growth): founder CLI guards reapproval and reports sequence progress`

---

### Task 9: Honeypot field name

Browser autofill fills fields named like `website_url`; a filled honeypot silently drops a real signup.

**Files:**
- Modify: `apps/web/app/lib/growth/forms.ts`, `apps/web/app/updates/FounderUpdatesForm.tsx`, their tests

- [ ] Rename the honeypot field to `b4_hp` in the parser and the island; give the input `autoComplete="off"`, `tabIndex={-1}`, `aria-hidden`, no `name`-implied semantics (no `type="url"`), and keep it visually hidden. Tests: the parser treats a filled `b4_hp` as a honeypot and ignores an unknown `website_url`; the island renders `b4_hp` with those attributes. Commit `fix(growth): rename the honeypot so autofill cannot fill it`.

---

### Task 10: Docs, validation, and owner handoff

- [ ] `docs/growth/README.md`: Operator commands gain the tick (`curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/growth/tick` for a manual run) and `growth:report sends`; Environment gains `GROWTH_SEQUENCE_ENABLED`, `GROWTH_SEQUENCE_START_AT`, `GROWTH_DELIVERY_ENABLED`, `RESEND_API_KEY`, `CRON_SECRET`, `GROWTH_FOUNDER_EMAIL`, `GROWTH_TOKEN_KEY_ID`, `GROWTH_TOKEN_PREVIOUS_KEYS`; a "Founder sequence" section states the schedule, the window, the switches, and that no mail leaves while `GROWTH_DELIVERY_ENABLED` is not exactly `true`. `node scripts/check-docs.mjs` passes.
- [ ] `pnpm ci:validate` green (verify any load-related timeouts in untouched packages in isolation), and `pnpm --dir apps/web test:growth-db` green.
- [ ] PR description handoff, in order:
  1. Set `RESEND_API_KEY` and `CRON_SECRET` in Vercel Production; leave both switches off and deploy.
  2. Confirm a tick runs (Vercel cron log, 200 with zero counts).
  3. Set `GROWTH_SEQUENCE_START_AT` to now and `GROWTH_SEQUENCE_ENABLED=true`; approve only Brian's own address (submit the form, or `growth:control approve`); confirm enrollment with `growth:control status`.
  4. Set `GROWTH_DELIVERY_ENABLED=true`; receive step 1 at 07:00 Pacific; check the BCC, the unsubscribe header and footer, the Resend webhook updating delivery, and the digest with its stop link.
  5. Move `GROWTH_SEQUENCE_START_AT` to the launch time.
- [ ] Open the PR with superpowers:finishing-a-development-branch.
