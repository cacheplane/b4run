# Growth signals: operations guide

How the site's engagement signals are emitted, defined, checked, and what they
can and cannot tell you. The design lives in
[`docs/superpowers/specs/2026-10-20-growth-lifecycle-design.md`](../superpowers/specs/2026-10-20-growth-lifecycle-design.md).

## Ownership

| Piece | Owner | Responsibility |
|---|---|---|
| `apps/web/app/lib/analytics/` | the site | Emits the eight typed site events to PostHog (US cloud, `b4run` project), behind a production-host gate. |
| `apps/web/app/api/signals/v1/cli/` | the site | Validates the `b4` CLI's usage signals and forwards accepted events to PostHog without the caller's IP or a person profile (`apps/web/app/lib/signals/cli-ingest.ts`). |
| `scripts/posthog/` | operators | Defines the event contract (`contract.ts`), the insights (`insights/*.json`) and dashboards (`dashboards/*.json`), and the live quality check. |
| `apps/web/app/lib/growth/` | the site | The Postgres contact control plane: contacts, stops, signed tokens, and webhook mapping. |
| `apps/web/app/updates/`, `apps/web/app/api/growth/forms/founder-updates`, `apps/web/app/api/growth/unsubscribe`, `apps/web/app/api/growth/founder-stop`, `apps/web/app/api/growth/tick`, `apps/web/app/api/growth/webhooks/resend` | the site | The founder-updates page and form route, the one-click unsubscribe route, the digest's founder-stop route, the sequence tick, and the verified Resend webhook. |
| `apps/web/scripts/growth-*.mts` | operators | The migrate, control, and report commands. |
| PostgreSQL (`GROWTH_DATABASE_URL`) | operators | Stores contacts, stops, and events. |
| PostHog | the vendor | Stores events and renders dashboards. It measures engagement and nothing else. |

## Operator commands

Run from the repo root.

```bash
pnpm posthog:plan                  # read-only diff of local definitions vs. the live project
pnpm posthog:apply                 # create/update insights and dashboards; leaves orphans alone
pnpm posthog:apply --delete-orphans   # also deletes live items with no local definition
pnpm posthog:quality --days 7      # check live events against the contract
pnpm posthog:quality --days 7 --limit-per-event 100
```

The contact commands run from the repo root through the `apps/web` package and
need the `GROWTH_*` variables below:

```bash
pnpm --dir apps/web growth:migrate                                  # apply pending database migrations
pnpm --dir apps/web growth:control status --email <address>      # show a contact's state
pnpm --dir apps/web growth:control approve --email <address>     # founder reapproval (the only way to reapprove)
pnpm --dir apps/web growth:control approve --email <address> --force   # also reapprove a contact stopped for complaint or hard_bounce
pnpm --dir apps/web growth:control stop --email <address>        # stop all email to the contact
pnpm --dir apps/web growth:control delete --email <address>      # delete the contact, keeping only the minimum
pnpm --dir apps/web growth:report journey --email <address>      # one contact's recorded journey
pnpm --dir apps/web growth:report counts                         # aggregate counts
pnpm --dir apps/web growth:report sends                          # sends by step and status, by delivery status, and reply processing
pnpm --dir apps/web test:growth-db                                  # real-Postgres tests (needs Docker)
```

`growth:control status` also prints one line per sequence step (`not enrolled`, or its status, delivery status, and due time), and says when a reapproved contact will not be enrolled again. For a stopped contact it says what stopped them: `stopped by: their reply to the sequence` for a [detected reply](#reply-detection), otherwise the recorded provenance (`founder_cli`, `founder_stop_link`, `unsubscribe_link`, `resend:email.bounced`, and so on).

`growth:report sends` also counts submitted sends still `without message id` and inbound receipts by reply status (`inbound reply pending`, `matched`, `unmatched`, `ignored`).

`growth:control approve` sets `approved_at` to now, even for a contact approved earlier, so it deliberately makes a contact approved before `GROWTH_SEQUENCE_START_AT` eligible for enrollment. Enrollment still needs a contact with no send at all, so it never restarts a sequence. The command needs an existing contact; for an unknown address it reports `no contact found for that address`.

Run a tick by hand with the cron secret:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/growth/tick
```

The reply is JSON with counts only: `enrolled`, `leased`, `outcomes`, `digest`, `windowOpen`, `delivery` (`disabled` or `enabled`), `inbound` (`disabled`, or `mailbox` (`ok` or `recovery_required`), `listing` (`complete`, `partial` or `failed`), `admitted`, `bindings` (`bound`, `waiting`, `failed`), `replies` (`matched`, `unmatched`, `ignored`, `pending`), and `forwarded`, `failed` and `retrying` counts; see [Inbound mail](#inbound-mail)), and `sendsHeld: "mailbox_recovery_required"` when a send-window tick sent nothing because the mailbox listing did not complete. `outcomes` counts `held_for_reply` for sends [held for reply processing](#reply-detection). Without the header, or with the wrong secret, it replies 401. When the configuration is invalid (for example `GROWTH_DELIVERY_ENABLED=true` without `RESEND_API_KEY`) it replies 500 `tick_failed` and logs `growth tick failed: config_invalid`; the log never carries the message.

The `growth-db-docker` CI job runs `test:growth-db` and fails unless every
`*.integration.test.ts` file passed at least one test and skipped none. It is
not one of the lanes `validate` requires.

The scheduled workflow `.github/workflows/posthog-quality.yml` runs
`posthog:plan` and `posthog:quality` daily at 14:23 UTC and on manual dispatch
(inputs `days`, default 7, and `limit_per_event`, default 100). It uses the
read-only key and never applies changes.

## Environment

| Variable | Used by | Notes |
|---|---|---|
| `NEXT_PUBLIC_POSTHOG_KEY` | the site build, the CLI ingest route | Project capture key. Without it nothing is emitted. The ingest route reads it at runtime to forward CLI signals. |
| `GROWTH_CLI_SIGNALS_ENABLED` | the CLI ingest route | Set to `true` to forward accepted CLI signals to PostHog. Any other value, or no project key, keeps the route dark: it still validates and replies, and forwards nothing. |
| `NEXT_PUBLIC_POSTHOG_CAPTURE_ANYWHERE` | the site build | Escape hatch: bypasses the production-host gate so non-production hosts (for example local dev) emit. Leave unset in production. |
| `POSTHOG_PERSONAL_API_KEY` | `posthog:plan`, `posthog:apply`, `posthog:quality` | Personal API key. `apply` needs write scope; `plan` and `quality` only need read. |
| `POSTHOG_PERSONAL_API_KEY_READONLY` | GitHub Actions secret | Read-only key; the workflow maps it to `POSTHOG_PERSONAL_API_KEY`. |
| `POSTHOG_PROJECT_ID` | all `posthog:*` commands | Numeric project id. |
| `POSTHOG_HOST` | all `posthog:*` commands, the CLI ingest route | Defaults to `https://us.i.posthog.com`. |
| `GROWTH_DATABASE_URL` | `growth:*` commands, the form, unsubscribe, founder-stop, tick, and webhook routes | Postgres connection string. Required. |
| `GROWTH_EMAIL_HMAC_SECRET` | same as above | Keys the email fingerprint. Required. |
| `GROWTH_TOKEN_SECRET` | same as above | Signs unsubscribe and founder-stop tokens. Required. |
| `GROWTH_TOKEN_KEY_ID` | same as above | Positive integer id of the key `GROWTH_TOKEN_SECRET` holds. Defaults to `1`. |
| `GROWTH_TOKEN_PREVIOUS_KEYS` | same as above | Retired keys that still verify, as comma-separated `id:secret` entries with distinct positive integer ids, none equal to the active id. Empty by default. |
| `GROWTH_ENVIRONMENT` | same as above | One of `production`, `preview`, `test`. Required. |
| `GROWTH_PUBLIC_ORIGIN` | same as above | Origin used in links. Defaults to `https://b4.run`. |
| `RESEND_WEBHOOK_SECRET` | the Resend webhook route | Verifies webhook signatures. |
| `RESEND_INBOUND_WEBHOOK_SECRET` | the Resend inbound route | Verifies `email.received` webhook signatures. Separate from `RESEND_WEBHOOK_SECRET`. Without it the inbound route answers 503. |
| `RESEND_RECEIVING_API_KEY` | the Resend inbound route, the tick route | Full-access Resend key, used to read received mail. Without it the inbound route answers 503 and the tick reports `inbound: disabled`. Independent of both switches. |
| `GROWTH_SEQUENCE_ENABLED` | the tick route | Exactly `true` turns enrollment on. Any other value leaves it off. |
| `GROWTH_SEQUENCE_START_AT` | the tick route | Required when the sequence is enabled; the tick fails without it. An ISO date-time with a UTC offset, such as `2026-10-23T07:00:00-07:00` or ending in `Z`. Only contacts approved at or after it are enrolled. |
| `GROWTH_DELIVERY_ENABLED` | the tick route | Exactly `true` lets mail leave. Any other value sends nothing. |
| `RESEND_API_KEY` | the tick route, the Resend inbound route | Resend sending key. Required when delivery is enabled; without it the tick fails with `config_invalid`. Inbound forwards use it when set, and otherwise `RESEND_RECEIVING_API_KEY`. |
| `CRON_SECRET` | the tick route | Vercel sends it as a Bearer token on each cron call. Without it every call is refused with 401. |
| `GROWTH_FOUNDER_EMAIL` | the tick route | Receives the digest and a BCC of each sequence email. Defaults to `brian@b4.run`. |
| `B4_CALL_URL` | the `/call` redirect in `next.config.ts` | Booking page; when unset the redirect goes to `/updates`. |
| `B4_TEST_GROWTH_DB` | `test:growth-db` | Set to `1` by the script to enable the gated database tests. |

The `/updates` form and its links (footer, blog call to action) appear only once `GROWTH_DATABASE_URL`, `GROWTH_EMAIL_HMAC_SECRET`, `GROWTH_TOKEN_SECRET` and `GROWTH_ENVIRONMENT` are all set at build; until then `/updates` says it is not open yet.

There is no root `.env.example`; set these in your shell or in the Actions
secrets (`POSTHOG_PERSONAL_API_KEY_READONLY`, `POSTHOG_PROJECT_ID`).

## Contacts and stops

- `approved_at` is the only send-authorisation field.
- A stop clears it and is never reversed by a later form.
- Reapproval is the founder command only.
- Every email B4 sends carries the Resend tag `app=b4`. The Resend account is shared with other products, and Resend delivers every event in the account to every webhook endpoint, so the webhook ignores any event without `app=b4` before it reads the database. Another product's bounce or complaint never stops a B4 contact, even when the recipient address matches.
- Resend events tagged with an environment must match `GROWTH_ENVIRONMENT`; an event whose environment tag differs is ignored.
- Events without an environment tag are processed only when `GROWTH_ENVIRONMENT` is `production`.
- Deletion keeps only the email HMAC, the stop, and the deletion timestamp.

## Founder sequence

Three plain-text emails go to each approved contact, from `Brian at B4.run <brian@b4.run>`, with the founder address on BCC. Each carries `List-Unsubscribe` and one-click headers and an unsubscribe link in the footer.

- **Schedule.** Step 1 is due at 07:00 Pacific on the next weekday after approval. Step 2 is due three business days after step 1 was accepted by Resend, and step 3 five business days after step 2. Business days are Pacific Monday to Friday; holidays are not excluded.
- **Window.** Sends go out only on Pacific weekdays between 07:00 and 07:59. The cron runs every 10 minutes (`apps/web/vercel.json`), so a due send goes on the first tick inside the window. A tick stops starting sends after 40 seconds and paces them under Resend's rate limit; the rest wait for the next tick.
- **Once per contact.** Enrollment needs a contact with no send at all, so reapproving a contact never restarts the sequence. A stop, deletion, or lost approval cancels any send not yet submitted.
- **Switches.** `GROWTH_SEQUENCE_ENABLED` and `GROWTH_DELIVERY_ENABLED` are independent and each is on only when exactly `true`. With the sequence off the tick enrolls no one. No mail leaves while `GROWTH_DELIVERY_ENABLED` is not exactly `true`: a tick then only enrolls, reports `delivery: disabled`, and sends neither sequence emails nor the digest.
- **Retries.** A send gets three attempts, 10 minutes apart: a retryable failure (timeout, network, 5xx) at 07:00 retries on the 07:10 and 07:20 ticks, inside the morning window. The retry delay is tied to the cron interval; lengthening either pushes later attempts to the next weekday morning. A 429 waits 60 seconds and does not use an attempt. Retries use one idempotency key per step (`seq:v1:<contactId>:step:<n>`) and stop 23 hours after the first attempt, ending the send as `idempotency_window_expired`, so Resend's 24-hour memory of the key is never outrun. If Resend answers that the key already holds a different body, an earlier attempt was accepted, so the send is recorded as `submitted` with delivery status `unknown` and the next step is scheduled.
- **Replies stop the sequence.** A contact who replies to a sequence email is stopped with `reply_received`, and their next step is held until any reply that could be theirs is processed. See [Reply detection](#reply-detection).
- **Failures end the sequence.** A send that fails with `idempotency_window_expired`, with `lease_expired` (a tick died while holding its last attempt), with a rejection, or after its last retryable attempt schedules no later step, so that contact's sequence ends there. Watch `growth:report sends` for `failed`.
- **Founder mailbox.** Keep the BCC mailbox (`GROWTH_FOUNDER_EMAIL`) healthy. The BCC copy shares the sequence email's provider id, and the webhook matches bounces and complaints by that id, so a permanent bounce or a complaint from the founder mailbox stops the contact the email was sent to.
- **Digest.** On a Pacific weekday inside the window, once a day, the founder gets an email listing contacts approved since the last digest and every sequence in flight, with one stop link per in-flight contact. It is sent only when there is something to report. Stop links work for seven days. Its idempotency key is `digest:<environment>:<date>`.

### Migrations

Run `pnpm --dir apps/web growth:migrate` against each database. Migration `0002` adds `growth_sends.first_attempted_at`, which the tick reads when it leases and sends. Migration `0003` adds `growth_inbound_receipts`; run it before setting `RESEND_RECEIVING_API_KEY`, or the inbound route and the tick's recovery fail. Migration `0004` adds `growth_sends.rfc_message_id` and the reply-processing columns on `growth_inbound_receipts`; deploy only after it runs, because the tick, both webhooks and every send read them. Deploying before migrating is safe while `GROWTH_DELIVERY_ENABLED` is off; with delivery on, ticks inside the send window fail until the migration runs.

### Rotating the token key

Tokens carry the id of the key that signed them, so links already sent keep working while you change keys.

1. Move the current secret to `GROWTH_TOKEN_PREVIOUS_KEYS` as `<id>:<secret>`.
2. Set `GROWTH_TOKEN_SECRET` to a new secret and `GROWTH_TOKEN_KEY_ID` to a new, unused integer.
3. Drop a previous key only once no link signed with it can still be clicked.

### Turning on the sequence

This order mails only the founder until the last step. Every environment change in Vercel takes effect only after a redeploy.

1. Run `pnpm --dir apps/web growth:migrate` against each database. Deploying before this is safe while `GROWTH_DELIVERY_ENABLED` is off; it is required before delivery, or ticks inside the window fail.
2. Set `B4_CALL_URL`, `RESEND_API_KEY` and `CRON_SECRET` in Vercel Production, leave both switches off, and redeploy. `B4_CALL_URL` is read at build time by the `/call` redirect. Vercel runs crons only on Production deployments, and a 10-minute schedule needs the Pro plan.
3. Confirm a tick runs every 10 minutes: the Vercel cron log shows 200 with zero counts (401 before `CRON_SECRET` is set).
4. Set `GROWTH_SEQUENCE_START_AT` to now and `GROWTH_SEQUENCE_ENABLED=true`, and redeploy. Enroll only Brian's address with `pnpm --dir apps/web growth:control approve --email <address>`, not the form: the form never resets an existing `approved_at`, so an address approved before the start time would never enroll. (If the address is not yet a contact, submit it on `/updates` first; `approve` needs an existing contact.) Within 10 minutes, confirm enrollment with `growth:control status --email <address>`.
5. Set `GROWTH_SEQUENCE_ENABLED=false` and redeploy, so no other signup is enrolled during the test. Check that `growth:report sends` shows exactly one send, `step 1 pending: 1`.
6. Set `GROWTH_DELIVERY_ENABLED=true` and redeploy. Receive step 1 at 07:00 Pacific on the next weekday. Check the BCC, the `List-Unsubscribe` header and the footer link, the Resend webhook updating the delivery status, and the digest with its stop link. Steps 2 and 3 follow over about eight business days.
7. Set `GROWTH_SEQUENCE_START_AT` to the launch time and `GROWTH_SEQUENCE_ENABLED=true`, and redeploy. The launch time must be later than the test: moving it earlier would enroll every contact approved before the launch.

## Inbound mail

Resend receives mail for the `b4.run` root domain. Mail to exactly `brian@b4.run` is forwarded to the fixed address `brian@cacheplane.ai`; no message can choose another destination. Mail to any other address is ignored: it is never stored, forwarded, or retried. Each admitted message is also checked for a contact's reply to the sequence, which stops that contact (see [Reply detection](#reply-detection)); forwarding and reply processing never depend on each other.

- **Admission.** A message is admitted when `brian@b4.run` appears, case-insensitively and with or without a display name, in its `to`, `cc`, `bcc` or `received_for` recipients. `hello@b4.run`, `brian@sub.b4.run` and every other address are not. The same check runs on the webhook payload, on recovery's listing, and again on the full message fetched from Resend before the forward is sent.
- **Webhook.** In Resend, add an endpoint `https://b4.run/api/growth/webhooks/resend-inbound` subscribed to `email.received`, and put its signing secret in `RESEND_INBOUND_WEBHOOK_SECRET`. An unsigned or wrongly signed call gets 401; another event type gets 202 `ignored_type`; another recipient gets 200 `ignored_recipient` with no database write. An admitted message is recorded, then forwarded: 200 when it is forwarded (or already was, or can never be), 500 when forwarding failed in a way a retry can fix, so Resend retries. Missing configuration answers 503 and logs `resend inbound unavailable: inbound_disabled` or `config_invalid`.
- **The forward.** From `Brian at B4.run <brian@b4.run>` to `brian@cacheplane.ai`, Reply-To the original sender, subject `Fwd: <original subject>` (or `(no subject)`), the original text and HTML bodies, and the raw message attached as `original.eml`. It carries `Auto-Submitted: auto-generated`, `X-B4-Forwarded: <received id>`, and the Resend tags `app=b4`, `environment`, and `kind=forward`; the delivery webhook ignores `kind=forward` events, so a bounce of a forward never stops a contact. The raw download is HTTPS only, follows no redirect, and is capped at 20 MiB; a larger original is forwarded without the attachment, with a note. A received message that is itself a B4 forward is ignored.
- **Once only.** The Idempotency-Key is `b4:<environment>:inbound-forward:<received id>`. The first-attempt time is committed before the send, and the send runs under the receipt's row lock, so a webhook and a recovery racing on one message send once. Retries stop 23 hours after the first attempt; the receipt then ends `failed` with `idempotency_window_expired`. A rejection by Resend also ends it `failed`.
- **Recovery.** Each tick, when `RESEND_RECEIVING_API_KEY` is set, first lists received mail newest first, stops at messages older than three days, and records any `brian@b4.run` message the webhook missed; then it runs the reply pass below, before any send. After sends and the digest it retries up to five unforwarded receipts, starting no forward after 30 seconds. Recovery runs independent of `GROWTH_SEQUENCE_ENABLED` and `GROWTH_DELIVERY_ENABLED`. The tick reply reports counts only.
- **Privacy.** `growth_inbound_receipts` holds the Resend received-email id, the received time, the forward status (`pending`, `forwarded`, `failed`, `ignored`), attempt count, first-attempt time, the forward's provider id, a short error code, and the reply-processing fields described below. It never stores an address, subject, body, or header value; the forward is rebuilt from Resend's copy on each attempt. Logs carry codes only.

### Reply detection

Sequence emails go out From and Reply-To `Brian at B4.run <brian@b4.run>`, so a contact's reply arrives on the inbound path above. B4 then stops that contact, exactly as `growth:control stop --reason reply_received` would, and cancels their open sends.

- **Outbound binding.** Each sequence send records the RFC Message-ID Resend gave it in `growth_sends.rfc_message_id`. The delivery webhook binds it from `email.sent` and `email.delivered` events tagged `app=b4` and `kind=sequence`, which carry `message_id`; the tick backfills any submitted send still missing one by reading `GET /emails/{id}` with the full-access key, at most 10 per tick, stopping at a rate limit. A binding is set once: a different id for the same send, or an id another send already holds, is refused and logged as a code.
- **Matching.** For each admitted message, B4 reads Resend's copy (the authoritative headers), takes the ids in `In-Reply-To` and then the most recent 50 in `References` (malformed ids are dropped), and looks them up in `growth_sends.rfc_message_id`. An `In-Reply-To` match wins over a `References` match. The ids must lead to exactly one contact, and the message's sender must be that contact's address, compared through the same normalisation and HMAC lookup the form uses. Subject or sender alone never stops anyone.
- **What stops.** A match stops the contact with `reply_received`, provenance `mailbox_reply`, in the same transaction that marks the receipt `matched`; the contact row is locked before the receipt, the order `stopContact` and the send path use, so a webhook and a recovery racing on one reply stop the contact once. Out-of-office and other automatic replies are treated like any reply: they stop the contact too. Use `growth:control approve` to restart one by hand.
- **What does not.** B4's own mail (from `brian@b4.run` or `brian@cacheplane.ai`: the digest, the founder BCC copy of each sequence email, the founder writing in) is `ignored` at admission. B4's forwards and mail no longer addressed to `brian@b4.run` are `ignored` too. No references, references that match nothing, references to several contacts, a sender who is not the matched contact, a message Resend no longer holds, or a matched send whose Message-ID can never be bound (`binding_unavailable`, which also holds that contact's next step until you act) end `unmatched` with a code. A deleted contact's reply is `ignored`.
- **Pending.** A receipt stays `pending`, with a code, while it could still be a reply: Resend could not be read (`receiving_timeout`, `receiving_http_5xx` and so on), or no stored id matches but the sender is a contact with a submitted send whose Message-ID is not bound yet (`binding_pending`). The webhook processes each receipt right after forwarding it; the tick retries up to 10 pending receipts per run.
- **Send gate.** Before mailing step 2 or 3, the send path holds the send, without using an attempt and 60 seconds later, when any earlier send of that contact has no Message-ID (`reply_binding_pending`) or any receipt anywhere is `pending` (`reply_processing_pending`). The hold is global because an unprocessed message could belong to anyone, which is acceptable at B4's volume. Admission and the send's check share an advisory lock, so a message admitted before a send's check always holds it. A held send goes out on a later tick inside the window once the hold clears. A tick whose mailbox listing failed or ran out of budget sends nothing (`sendsHeld: mailbox_recovery_required`). Step 1 has no earlier send, so only pending receipts and the listing can hold it.
- **Stored.** On a receipt: `reply_status` (`pending`, `matched`, `unmatched`, `ignored`), `reply_attempts`, `reply_error_code`, and, only when matched, `contact_id` and `matched_send_id`. On a send: `rfc_message_id`. Nothing else from the reply is kept; references are re-read from Resend on each attempt. Receipts admitted before migration `0004` start `pending` and are processed by the next tick.
- **A stuck receipt.** A receipt that stays `pending` holds every step 2 and 3. Check `growth:report sends`, then the receipt's `reply_error_code` and the message in Resend. Resolve the cause (a Resend outage clears itself; a missing binding fills in on a later tick) rather than editing receipts. A send recorded as submitted after an `idempotency_mismatch` has no provider id, so its Message-ID can never be bound and that contact's next step stays held (`reply_binding_pending`); decide by hand, by stopping the contact or by checking the email in Resend. Without `RESEND_RECEIVING_API_KEY` there is no reply processing and no backfill: only the delivery webhook binds Message-IDs, and nothing else holds sends.

### Turning on inbound mail

1. Run `pnpm --dir apps/web growth:migrate` so `0003` is applied.
2. In Resend, enable receiving on the `b4.run` domain and add the receiving MX record it shows to DNS. Create a full-access API key for `RESEND_RECEIVING_API_KEY`; keep the sending-only key in `RESEND_API_KEY`.
3. Add the inbound webhook endpoint for `email.received` and copy its signing secret.
4. Set `RESEND_RECEIVING_API_KEY` and `RESEND_INBOUND_WEBHOOK_SECRET` in Vercel Production and redeploy.
5. Send a test message to `brian@b4.run` and one to another `b4.run` address. The first arrives at `brian@cacheplane.ai` with `original.eml`; the second does not. The next tick reports `inbound` counts instead of `disabled`.
6. For reply detection, run `growth:migrate` so `0004` is applied, and make sure the delivery webhook endpoint (`RESEND_WEBHOOK_SECRET`) is subscribed to `email.sent` and `email.delivered`. Reply to a sequence email from the enrolled test address; `growth:control status` then shows `stopped: reply_received` and `stopped by: their reply to the sequence`.

## CLI signals

The `b4` CLI reports two events of its own, `cli:command_completed` and `cli:dev_first_run_completed`, from development-time commands only (`dev`, `build`, `add`, `check`, `typegen`, `verify`, `eval`). `b4 start`, the runtime packages, and `create-b4-app` never report. The CLI posts to an ingest route on the site, `apps/web/app/api/signals/v1/cli`, which validates each request and forwards accepted events to PostHog. Forwarding stays off until `GROWTH_CLI_SIGNALS_ENABLED=true` is set alongside the project key; until then the route validates and replies 202 without forwarding.

### Request contract

```
POST https://b4.run/api/signals/v1/cli        (override: B4_SIGNALS_URL)
Content-Type: application/json
User-Agent: b4-cli
No credentials. Timeout 3 s. The CLI ignores the status and the body.

{
  "schema": 1,
  "usage_id": "<uuid v4 from ~/.b4/usage-id>",
  "sent_at": "<ISO 8601 UTC>",
  "events": [
    { "event": "cli:command_completed",
      "properties": { "command": "build", "cli_version": "0.14.0", "node_major": 24,
                      "os": "darwin", "outcome": "ok", "duration_bucket": "1s_to_10s",
                      "error_class": "B4_E1006" } },
    { "event": "cli:dev_first_run_completed",
      "properties": { "cli_version": "0.14.0", "route_kind": "graph" } }
  ]
}
```

The CLI sends one event per request today. The contract allows up to ten.

### Ingest route rules

- Reply 400 unless `User-Agent` starts with `b4-cli`, 415 unless `Content-Type` is `application/json`, and 413 when the body exceeds 16 KiB (counted in bytes). The user-agent check is not a credential; it keeps crawlers and scanners out of the counts.
- Accept 1 to 10 events per request.
- Reject the request with 400 when the body is not JSON, `schema` is not `1`, `usage_id` is not a UUID, an event is not an object with a string `event`, or any event name is unknown.
- Drop properties outside the event's allowlist.
- Drop an event whose known property has the wrong type or an out-of-range value, or that lacks a required property: `command` must be one of the seven command names, `outcome` one of `ok`, `error`, `cancelled`, `duration_bucket` one of the five buckets, `route_kind` one of the four route kinds, `os` one of Node's `process.platform` values, `cli_version` a version number, `error_class` a `B4_E` code, a built-in error name, or `unknown`, `node_major` an integer from 0 to 999, and strings at most 128 characters. No property accepts free text, so a hand-written request cannot carry a name, path, or email into PostHog. The other events in the request are still accepted; a request with no event left is rejected with 400.
- Forward to PostHog's `/batch/` endpoint after replying, with `distinct_id` set to the lowercased `usage_id`, `timestamp` set to the time the site received the request (the client's `sent_at` is ignored), `$ip` set to `null`, `$geoip_disable` set to `true`, and `$process_person_profile` set to `false`. A failed forward is logged with the HTTP status or the error class name only, never the usage id or a property, and never changes the reply.
- Reply 202 with an empty body. No reply echoes the request.

### Turning it on

1. Set `GROWTH_CLI_SIGNALS_ENABLED=true` for the production environment of the `b4-run` Vercel project. `NEXT_PUBLIC_POSTHOG_KEY` is already set there.
2. Add a Vercel Firewall rate-limit rule for `/api/signals/v1/cli`, for example 60 requests per minute per IP, so a flood cannot run up PostHog usage.
3. In the `b4run` PostHog project, turn on "Discard client IP data". Events reach PostHog from the Vercel function, so the address PostHog would otherwise record is the function's egress IP, not the developer's; discarding it keeps every signal free of addresses, site events included.
4. Release the CLI only after the route forwards in production.

### Environment

| Variable | Used by | Notes |
|---|---|---|
| `B4_TELEMETRY_DISABLED` | the `b4` CLI | Set to `1` to turn CLI usage reporting off. Honoured from the shell before any file write, and from a project `.env` for every send (a project `.env` loads after the command starts, so the first-run id file and notice can still appear). |
| `DO_NOT_TRACK` | the `b4` CLI | Set to `1` to turn CLI usage reporting off. Honoured from the shell before any file write, and from a project `.env` for every send (a project `.env` loads after the command starts, so the first-run id file and notice can still appear). |
| `B4_SIGNALS_URL` | the `b4` CLI | Overrides the ingest URL, for example to point at a local test server. Read from the shell environment at startup only, never from a project `.env`. |

The CLI is also inert when a common CI variable is set, before any file write or network call.

## Measurement limits

- A form acceptance is not a verified person. The address is stored as typed;
  nothing confirms that its owner submitted it.
- A copied install command is not an install. The copy events record intent to
  install, never that anyone ran the command.
- Engaged time is visible seconds: time the tab is visible, not time spent
  reading or understanding.
- CLI counts can be inflated by anyone. The ingest route takes any well-formed request, and the PostHog capture key is public by design, so CLI events are a signal of activity, not an audit. The route's validation keeps personal data out; it does not prove a request came from a real `b4`.
- These are counts, not funnels. Events are aggregated per surface, path, or id;
  they are not stitched into per-visitor journeys.
- The live PostHog project contains PostHog's own starter dashboard and
  insights. `posthog:plan` lists them as orphans. Plain `posthog:apply` leaves
  them alone; `posthog:apply --delete-orphans` would delete them and must not
  be used casually.
