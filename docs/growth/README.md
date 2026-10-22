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

There is no root `.env.example`; set these in your shell or in the Actions
secrets (`POSTHOG_PERSONAL_API_KEY_READONLY`, `POSTHOG_PROJECT_ID`).

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

- Reply 415 unless `Content-Type` is `application/json`, and 413 when the body exceeds 16 KiB.
- Accept 1 to 10 events per request.
- Reject the request with 400 when the body is not JSON, `schema` is not `1`, `usage_id` is not a UUID, or any event name is unknown.
- Drop properties outside the event's allowlist.
- Drop an event whose known property has the wrong type or an out-of-range value, or that lacks a required property: `command` must be one of the seven command names, `outcome` one of `ok`, `error`, `cancelled`, `duration_bucket` one of the five buckets, `route_kind` one of the four route kinds, `node_major` an integer, and strings at most 128 characters. The other events in the request are still accepted; a request with no event left is rejected with 400.
- Forward to PostHog's `/batch/` endpoint after replying, with `distinct_id` set to the lowercased `usage_id`, `timestamp` set to the time the site received the request (the client's `sent_at` is ignored), `$ip` set to `null`, `$geoip_disable` set to `true`, and `$process_person_profile` set to `false`. A failed forward is logged by status only and never changes the reply.
- Reply 202 with an empty body. No reply echoes the request.

### Environment

| Variable | Used by | Notes |
|---|---|---|
| `B4_TELEMETRY_DISABLED` | the `b4` CLI | Set to `1` to turn CLI usage reporting off. Honoured from the shell before any file write, and from a project `.env` for every send (a project `.env` loads after the command starts, so the first-run id file and notice can still appear). |
| `DO_NOT_TRACK` | the `b4` CLI | Set to `1` to turn CLI usage reporting off. Honoured from the shell before any file write, and from a project `.env` for every send (a project `.env` loads after the command starts, so the first-run id file and notice can still appear). |
| `B4_SIGNALS_URL` | the `b4` CLI | Overrides the ingest URL, for example to point at a local test server. Read from the shell environment at startup only, never from a project `.env`. |

The CLI is also inert when a common CI variable is set, before any file write or network call.

## Measurement limits

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
