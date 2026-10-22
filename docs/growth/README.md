# Growth signals: operations guide

How the site's engagement signals are emitted, defined, checked, and what they
can and cannot tell you. The design lives in
[`docs/superpowers/specs/2026-10-20-growth-lifecycle-design.md`](../superpowers/specs/2026-10-20-growth-lifecycle-design.md).

## Ownership

| Piece | Owner | Responsibility |
|---|---|---|
| `apps/web/app/lib/analytics/` | the site | Emits the eight typed site events to PostHog (US cloud, `b4run` project), behind a production-host gate. |
| `scripts/posthog/` | operators | Defines the event contract (`contract.ts`), the insights (`insights/*.json`) and dashboards (`dashboards/*.json`), and the live quality check. |
| `apps/web/app/lib/growth/` | the site | The Postgres contact control plane: contacts, stops, signed tokens, and webhook mapping. |
| `apps/web/app/updates/`, `apps/web/app/api/growth/forms/founder-updates`, `apps/web/app/api/growth/unsubscribe`, `apps/web/app/api/growth/webhooks/resend` | the site | The founder-updates page and form route, the one-click unsubscribe route, and the verified Resend webhook. |
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
pnpm --dir apps/web growth:control stop --email <address>        # stop all email to the contact
pnpm --dir apps/web growth:control delete --email <address>      # delete the contact, keeping only the minimum
pnpm --dir apps/web growth:report journey --email <address>      # one contact's recorded journey
pnpm --dir apps/web growth:report counts                         # aggregate counts
pnpm --dir apps/web test:growth-db                                  # real-Postgres tests (needs Docker)
```

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
| `NEXT_PUBLIC_POSTHOG_KEY` | the site build | Project capture key. Without it nothing is emitted. |
| `NEXT_PUBLIC_POSTHOG_CAPTURE_ANYWHERE` | the site build | Escape hatch: bypasses the production-host gate so non-production hosts (for example local dev) emit. Leave unset in production. |
| `POSTHOG_PERSONAL_API_KEY` | `posthog:plan`, `posthog:apply`, `posthog:quality` | Personal API key. `apply` needs write scope; `plan` and `quality` only need read. |
| `POSTHOG_PERSONAL_API_KEY_READONLY` | GitHub Actions secret | Read-only key; the workflow maps it to `POSTHOG_PERSONAL_API_KEY`. |
| `POSTHOG_PROJECT_ID` | all `posthog:*` commands | Numeric project id. |
| `POSTHOG_HOST` | all `posthog:*` commands | Defaults to `https://us.i.posthog.com`. |
| `GROWTH_DATABASE_URL` | `growth:*` commands, the form, unsubscribe, and webhook routes | Postgres connection string. Required. |
| `GROWTH_EMAIL_HMAC_SECRET` | same as above | Keys the email fingerprint. Required. |
| `GROWTH_TOKEN_SECRET` | same as above | Signs unsubscribe tokens. Required. |
| `GROWTH_ENVIRONMENT` | same as above | One of `production`, `preview`, `test`. Required. |
| `GROWTH_PUBLIC_ORIGIN` | same as above | Origin used in links. Defaults to `https://b4.run`. |
| `RESEND_WEBHOOK_SECRET` | the Resend webhook route | Verifies webhook signatures. |
| `B4_CALL_URL` | the `/call` redirect in `next.config.ts` | Booking page; when unset the redirect goes to `/updates`. |
| `B4_TEST_GROWTH_DB` | `test:growth-db` | Set to `1` by the script to enable the gated database tests. |

The `/updates` form and its links (footer, blog call to action) appear only once `GROWTH_DATABASE_URL`, `GROWTH_EMAIL_HMAC_SECRET`, `GROWTH_TOKEN_SECRET` and `GROWTH_ENVIRONMENT` are all set at build; until then `/updates` says it is not open yet.

There is no root `.env.example`; set these in your shell or in the Actions
secrets (`POSTHOG_PERSONAL_API_KEY_READONLY`, `POSTHOG_PROJECT_ID`).

## Contacts and stops

- `approved_at` is the only send-authorisation field.
- A stop clears it and is never reversed by a later form.
- Reapproval is the founder command only.
- Tagged Resend events must match `GROWTH_ENVIRONMENT`; an event whose environment tag differs is ignored.
- Untagged Resend events are processed only when `GROWTH_ENVIRONMENT` is `production`.
- Deletion keeps only the email HMAC, the stop, and the deletion timestamp.

## CLI signals

The `b4` CLI reports two events of its own, `cli:command_completed` and `cli:dev_first_run_completed`, from development-time commands only (`dev`, `build`, `add`, `check`, `typegen`, `verify`, `eval`). `b4 start`, the runtime packages, and `create-b4-app` never report. The CLI posts to an ingest route on the site, which forwards to PostHog. That route does not exist yet. Until it does, the CLI gets a 404 and ignores it.

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

- Accept 1 to 10 events per request.
- Reject the request with 400 when `schema` is not `1`, `usage_id` is not a UUID, or any event name is unknown.
- Drop properties outside the event's allowlist.
- Reject an event whose known property has the wrong type or an out-of-range value: `command` must be one of the seven command names, `outcome` one of `ok`, `error`, `cancelled`, `duration_bucket` one of the five buckets, `route_kind` one of the four route kinds, `node_major` an integer, and strings at most 128 characters.
- Forward to PostHog with `distinct_id` set to `usage_id`, `$ip` set to `null`, and `$process_person_profile` set to `false`.
- Reply 202 with an empty body.

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
- These are counts, not funnels. Events are aggregated per surface, path, or id;
  they are not stitched into per-visitor journeys.
- The live PostHog project contains PostHog's own starter dashboard and
  insights. `posthog:plan` lists them as orphans. Plain `posthog:apply` leaves
  them alone; `posthog:apply --delete-orphans` would delete them and must not
  be used casually.
