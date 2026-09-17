# Software factory, rung 0: a controller in front of the unchanged code-fixer

Date: 2026-09-16
Status: approved 2026-09-16; amended once during planning (offline layer 2 deferred, see "Amendment")
Program document: [b4.run Software Factory RFC 001](2026-09-16-software-factory-rfc.md)
Source snapshot: `8b40b8b33c1cdf6933bfb66a2e6f762b96a711ba`

## Decision

Build the software factory as a ladder of small, separately proven increments.
This specification covers only rung 0: an application-owned work-order
controller that drives the existing `examples/code-fixer/server` application,
unchanged, over the Agent Protocol. Rung 0 exists to prove the one seam the
framework does not provide today, controller-to-worker dispatch with recorded
child threads, operation-scoped approval, cancellation and restart recovery,
before anything is built on top of it.

The RFC's central separation is kept: agents propose and implement,
verification produces evidence, application policy authorizes progression,
humans authorize delivery. Rung 0 implements the application-policy layer and
reuses code-fixer for the other three.

## Amendment: the offline replay layer is deferred

Planning found that the testing package's `aimock` fixtures are static and
matched on user message and turn index (`packages/testing/src/fixture-builder.ts`).
The worker's `exportForReview` call carries a candidate that only exists after
`prepareReview` runs in the same turn, so the single-turn protocol below cannot
be replayed offline against the real code-fixer. Brian's decision: keep the
approved single-turn protocol and defer the offline replay layer. In rung 0 the
real worker is exercised by the recorded live demonstration with a real model;
the fake-worker layer carries every invariant. An offline real-worker lane is a
candidate for rung 1, where the controller owns verification and the worker no
longer needs to call `exportForReview` at all.

## What the code survey changed

The RFC proposed the controller as a named `graph` route on LangGraph. On this
commit that is not viable, so rung 0 departs from the RFC in one way and the
departure is deliberate.

- Only `agent` routes receive a checkpointer, thread id, interrupts, resume,
  reattach and in-band cancellation. A `graph` route is a one-shot
  `invoke(input, ctx)` with an abort signal
  (`packages/cli/src/lib/runtime/execute-route-core.ts`, checkpointer wrapped
  only for `kind === "agent"`; streaming short-circuits for every other kind).
- There is no in-process API for starting a child run on its own thread.
  Subagents run on the parent's thread and their interrupts surface there. The
  only documented dispatch path with separate thread ids is the Agent Protocol
  over HTTP (`apps/web/content/docs/recipes/dispatch-from-route.mdx`), which
  also documents that cancellation does not cross that boundary by itself.
- The tool-approval interrupt carries a `detail.argsPreview` truncated to 500
  characters (`packages/core/src/capabilities/permission-gate.ts`,
  `buildArgsPreview`). A candidate's `receiptDigest` cannot be read reliably
  from the interrupt envelope.
- `aimock` fixtures are static and matched on `userMessage`, `turnIndex` and
  `hasToolResult`; see the amendment above. The turn 1 prompt is still an
  exported constant so a future replay lane can key fixtures to it.
- The provider-owned workspace lifecycle, source bundles, `baseline: "git"`
  and `environmentLinks` are shipped and used by code-fixer, despite two 9/14
  specs still carrying "proposed" status. Nothing in rung 0 waits on them.

Consequence: the controller is plain application code with its own durable
registry, and workers are `agent` routes reached over the Agent Protocol.
Business state lives in the registry, exactly as RFC section 7.1 requires;
LangGraph checkpoints remain the worker's execution continuation only.

## The increment ladder

Each rung is its own specification, plan and pull request. A rung is complete
when its proof passes, not when its code merges. Later rungs are listed so rung
0 can be judged against what it must not preclude; they are not designed here.

| Rung | Adds | Proof |
|---|---|---|
| 0 | Controller in front of the unchanged code-fixer. Registry, closed state machine, loopback Agent Protocol dispatch, child thread recorded before dispatch, approval as a factory command, cancel, restart reconciliation. | One `cli-flags` work order runs intake to exported receipt through the factory against a scripted fake worker, and once live against the real code-fixer. Restart, cancel, stale approval and duplicate command invariants pass. |
| 1 | Controller-owned verification and review bundle. Verification leaves the worker's tools; receipts come from the trusted harness; approval binds to the bundle digest; export is a factory delivery command. | A candidate passing visible tests but failing independent checks cannot reach review-ready. Only the exact approved bytes export. |
| 2 | Worker retargeted at the b4run monorepo: pinned image with the pnpm dependency closure baked in, source capture of an allowlisted package, per-package checks, resources sized for turbo. | Baseline, build and test one `packages/*` member in the sandbox; a scripted repair of a known past defect verifies. |
| 3 | First dogfood work order: a bounded b4run fix from a prepared spec with a live model. | Exported patch applies to main and passes `ci:validate`. |
| 4 | Draft pull request delivery with outbox and reconciliation. | Lost-response and duplicate-command tests; one real draft PR. |

## Rung 0 scope

In scope:

- A new workspace member `examples/software-factory/server`
  (`@b4-example/software-factory-server`, private).
- A `node:sqlite` registry, a closed work-order state machine, a command layer
  with operation keys, and startup reconciliation.
- A worker client that speaks only the seven Agent Protocol calls listed
  below to a configured base URL.
- A CLI and a minimal HTTP API exposing the same commands.
- One always-on test layer against a scripted fake worker, and one recorded live demonstration against the real code-fixer.

Out of scope, recorded so nobody mistakes their absence for an oversight:

- Any change to `examples/code-fixer`. The worker is used exactly as shipped,
  including its in-worker verification and its own export tool.
- Authentication. The factory binds to loopback only and its README carries
  the same trusted-sole-operator caveat as the research example.
- The repair loop, token or model-call budgets, multiple attempts, more than
  one worker kind, any UI, and the b4run monorepo as a target.
- A `b4` route of any kind inside the factory. Rung 0 is not a b4 application;
  it is a consumer of one.

## Architecture

### Two processes, one host

```text
operator (CLI or HTTP on 127.0.0.1)
        |
factory service            examples/software-factory/server
  registry.sqlite          work orders, events, commands, approvals, deliveries
  state machine + commands
  worker client  ----------- Agent Protocol over loopback HTTP ---------+
                                                                        |
code-fixer server          examples/code-fixer/server, unchanged        v
  /fix#agent route, Docker sandbox, prepareReview, exportForReview
  .b4/code-fixer/review-outbox/<receiptDigest>.json
```

The code-fixer server runs as its own b4 runtime, started by the operator or by
the test harness, on a loopback port. The factory is configured with
`FACTORY_WORKER_URL` (the worker's base URL), `FACTORY_WORKER_ROUTE`
(`/fix#agent`), `FACTORY_WORKER_OUTBOX` (the absolute path of the worker's
review outbox directory) and `FACTORY_STATE_DIR` (where `registry.sqlite`
lives). Ports are never hard-coded.

Reading the worker's outbox from disk is a rung 0 shortcut that is only valid
because both processes share a host. Rung 1 replaces it with a
controller-issued delivery receipt.

### Worker client: the Agent Protocol subset

The client uses exactly these endpoints and nothing else. Every request body
and response shape follows `apps/web/content/docs/dev-server/agent-protocol.mdx`.

| Purpose | Call |
|---|---|
| Create child thread | `POST /threads` with `{ metadata: { factoryWorkOrderId } }` |
| Start run | `POST /threads/:id/runs/stream` with `{ route, input }`, consumed as SSE |
| Reattach | `GET /threads/:id/runs/stream`, first frame is `event: state` |
| Read parked prompts | `GET /threads/:id/pending_interrupts` |
| Resolve approval | `POST /threads/:id/resume` with `{ resume: [{ interruptId, status: "resolved", payload }], route }` |
| Cancel | `POST /threads/:id/cancel` |
| Thread status | `GET /threads/:id` |

`payload` is `"once"` or `"deny"`. The client never sends `"always"`; a
persistent grant for export is prohibited by RFC section 8.3. The resume body
must name every pending interrupt exactly once, so the client resolves the
whole set returned by `pending_interrupts` and refuses if more than one is
pending or if the pending id differs from the recorded one.

### Work-order states

Closed union. No other value may be stored.

| State | Meaning |
|---|---|
| `received` | Registered; no external effect yet |
| `dispatched` | Child thread created and recorded; run not yet confirmed started |
| `running` | Run stream open or known live |
| `awaiting_approval` | Worker parked on the `exportForReview` tool approval; interrupt id and candidate digest recorded |
| `exporting` | Approval recorded and resume sent; receipt not yet observed |
| `exported` | Receipt observed whose filename equals the recorded candidate digest |
| `denied` | Operator denied; worker resumed with `deny` |
| `cancel_requested` | Cancel recorded; worker cancel sent or pending |
| `cancelled` | Worker run confirmed ended after cancel |
| `blocked` | Cannot proceed without operator action; `reason` recorded |
| `failed` | Worker reported a route failure or the run ended without reaching approval |

Terminal states: `exported`, `denied`, `cancelled`, `failed`. `blocked` is not
terminal; the only exits are `cancel` and `deny` where a pending interrupt
exists.

### Transition table

Every transition is a row here. The command layer refuses anything else.

| From | Event | To |
|---|---|---|
| `received` | `dispatch` committed thread id | `dispatched` |
| `dispatched` | stream opened, or `GET /threads/:id` shows a run | `running` |
| `dispatched`, `running` | interrupt frame: kind `tool`, `toolName` `exportForReview`, and a candidate digest is recorded | `awaiting_approval` |
| `dispatched`, `running` | interrupt frame for `exportForReview` but no candidate digest recorded | `blocked` (reason `candidate_digest_unknown`) |
| `dispatched`, `running` | any other interrupt kind | `blocked` (reason `unexpected_interrupt`) |
| `running` | `done` frame with `output.error` | `failed` |
| `running` | `done` frame without interrupt and without receipt | `failed` (reason `ended_without_candidate`) |
| `awaiting_approval` | `approve` validated and resume sent | `exporting` |
| `awaiting_approval` | `deny` validated and resume sent | `denied` |
| `exporting` | receipt file `<candidateDigest>.json` observed | `exported` |
| `exporting` | resume stream ends with `output.error` or no receipt within the export wait | `blocked` (reason `export_unconfirmed`) |
| any non-terminal | `cancel` recorded | `cancel_requested` |
| `cancel_requested` | worker reports run ended, or `cancel` returns `409 no_run_in_flight` and no interrupt pending | `cancelled` |
| `cancel_requested` | interrupt still pending after cancel | the client resumes it with `deny`, then `cancelled` (the operator's intent was cancel, not a verdict on the candidate) |
| any non-terminal | wall-clock budget exceeded | `cancel_requested`, then `blocked` (reason `budget_exhausted`) once the run ends |

Every transition increments `revision`. Writes are compare-and-swap on
`(id, revision)`; a lost race is a refused command, never a silent overwrite.

### Where the candidate digest comes from

The interrupt cannot carry it. The controller watches the run stream for the
`tool_result` frame of `prepareReview`, parses its JSON content, and records
`candidate.receiptDigest` in the registry as `candidate_digest` together with
the `verification.passed` boolean and the event sequence.

The binding is the receipt filename. Code-fixer names its receipt by the
candidate digest and re-verifies before writing it, so `exported` is only
reached when a file named by the recorded digest appears. If the stream was
lost before `prepareReview` was observed and the thread is parked, the work
order becomes `blocked` with `candidate_digest_unknown`; the operator may
`deny`, but `approve` is refused. Rung 1 removes this limitation by making the
controller own verification.

### Commands

Every command takes an `operationKey` (client-supplied, or derived
deterministically by the CLI as `<command>:<workOrderId>:<revision>`). The
command layer first looks the key up in `commands`; a hit returns the recorded
result without touching the worker. A miss commits the intended transition and
event in one SQLite transaction, then performs the external call, then commits
the outcome under the same key. A crash between the two commits leaves a
committed intent that reconciliation inspects on restart.

| Command | Preconditions | Effect |
|---|---|---|
| `create` | task id in the allowlist (`cli-flags` only in rung 0) | Row in `received` with limits |
| `dispatch` | `received` | `POST /threads`, commit thread id, then start the stream |
| `approve` | `awaiting_approval`; supplied `revision` matches; approval not expired; supplied `candidateDigest` equals the recorded one | Approval row, resume `once`, move to `exporting`, then watch for the receipt |
| `deny` | `awaiting_approval`, or `blocked` with a pending interrupt | Resume `deny`, move to `denied` |
| `cancel` | any non-terminal | `POST cancel`, move to `cancel_requested`, then reconcile |
| `show`, `list`, `events` | none | Read-only |

`approve` requires the operator to pass the candidate digest they are
approving. This is the RFC's "approval authorizes an exact candidate", made
literal at the CLI. Approvals expire after `FACTORY_APPROVAL_TTL` (default 15
minutes) measured from the moment the work order entered `awaiting_approval`;
an expired work order must be denied or cancelled.

### Startup reconciliation

On boot the factory walks every non-terminal work order in registry order and
applies these rules before accepting commands. It never dispatches on its own.

1. A `commands` row with intent committed but no outcome: inspect the worker
   (`GET /threads/:id`, `pending_interrupts`, outbox) and record the outcome the
   evidence supports. Only if the intent was `dispatch` and no thread id was
   committed is it safe to mark the command failed and leave the work order in
   `received`.
2. `dispatched` or `running`: if `pending_interrupts` returns the
   `exportForReview` prompt and a digest is recorded, move to
   `awaiting_approval`; if no digest is recorded, `blocked`. If the thread
   shows a live run, reattach with `GET runs/stream`. If the thread is idle
   with no interrupt and no receipt, `failed` with `ended_without_candidate`.
3. `exporting`: if the receipt exists, `exported`; otherwise `blocked` with
   `export_unconfirmed`.
4. `cancel_requested`: apply the cancel rows of the transition table.
5. `awaiting_approval`: confirm the interrupt is still pending; if not,
   `blocked` with `interrupt_vanished`.

Reconciliation results are events like any other, so the operator can see what
the factory concluded and why.

### Budgets

Rung 0 enforces two limits per work order: `maxCandidateAttempts = 1` (there
is no repair loop, so a `failed` work order is final) and
`maxActiveMilliseconds` (default 20 minutes) counted only while the state is
`dispatched`, `running` or `exporting`. Time spent in `awaiting_approval` or
`blocked` is not active time. Exceeding the active limit triggers `cancel`.
Token, model-call and cost limits are not observable through the Agent
Protocol and are explicitly deferred.

## Registry schema

One SQLite file, `registry.sqlite`, opened with `node:sqlite` in WAL mode. The
factory owns it entirely; it never opens the worker's `.b4/*.sqlite` files.

```sql
create table work_orders (
  id text primary key,
  revision integer not null,
  state text not null,
  task_id text not null,
  worker_route text not null,
  worker_thread_id text,
  interrupt_id text,
  candidate_digest text,
  candidate_verified integer,
  blocked_reason text,
  failure_reason text,
  max_candidate_attempts integer not null,
  max_active_ms integer not null,
  active_ms integer not null default 0,
  awaiting_since text,
  created_at text not null,
  updated_at text not null
);

create table events (
  seq integer primary key autoincrement,
  work_order_id text not null references work_orders(id),
  type text not null,
  payload text not null,
  at text not null
);

create table commands (
  operation_key text primary key,
  work_order_id text not null,
  command text not null,
  intent text not null,
  outcome text,
  at text not null
);

create table approvals (
  id text primary key,
  work_order_id text not null,
  interrupt_id text not null,
  candidate_digest text not null,
  decision text not null,
  decided_by text not null,
  decided_at text not null,
  expires_at text not null
);

create table deliveries (
  work_order_id text primary key,
  candidate_digest text not null,
  receipt_path text not null,
  observed_at text not null
);
```

`payload`, `intent` and `outcome` are JSON text validated with zod on read.
The implementation adds `active_started_at` to `work_orders` (the open active
interval the budget ticker measures) and `interrupt_id` to `approvals`, and
declares `references work_orders(id)` on `approvals.work_order_id` and
`deliveries.work_order_id` as well as on `events`; `commands.work_order_id` is
deliberately unreferenced so a command intent can be recorded before its work
order exists. `failure_reason` records why a work order is `failed`, mirroring
`blocked_reason`.
Schema changes ship with a migration and a version row; the factory refuses to
open a registry written by a newer schema.

## Proof

### Layer 1, always on: fake worker

An in-process fake Agent Protocol server implements the seven calls in the
worker client table with the documented status codes and SSE frames, and
nothing more. Each test scripts it: emit `prepareReview` then an
`exportForReview` interrupt; hang after the interrupt; close the stream
mid-turn; return `409 run_in_flight`; return `409` on a second resume; return
`404` for an unknown thread; write or withhold a receipt file. The fake is
written from the protocol document, not from what the controller happens to
send, and its frames are checked against the same zod schemas the real client
uses, so a shape the fake accepts but the runtime would not is a test failure.

### Layer 2, offline replay against the real code-fixer: deferred

See the amendment. Not built in rung 0. The live demonstration below is the
only real-worker exercise, and it is manual and recorded, not a CI lane.

### Invariants

| Scenario | Required outcome |
|---|---|
| Happy path | `received` to `exported`; exactly one receipt; thread id committed before the run starts (asserted from event order) |
| `approve` with stale revision, wrong digest, or after expiry | Refused; no resume on the wire; state and revision unchanged |
| `approve` twice, or any command retried with the same operation key | Second call returns the recorded result; exactly one resume on the wire |
| `deny` | Resume `deny` sent; `denied`; outbox empty |
| Factory restarts while worker is `awaiting_approval` | Reconciles to `awaiting_approval` from `pending_interrupts`; no second `POST /threads` |
| Factory restarts after resume, before receipt observed | `exported` if the receipt exists, else `blocked` with `export_unconfirmed`; never re-dispatches |
| Factory dies between intent commit and the external call | On restart the committed intent is inspected against the worker; a `dispatch` with no committed thread id is marked failed and the work order stays `received` |
| `cancel` while `running` | `POST cancel` reaches the worker; `cancelled` only after the run is confirmed ended |
| Active budget exceeded | Controller cancels; `blocked` with `budget_exhausted`; no further worker calls |
| Stream disconnects mid-run | Registry unchanged by the disconnect; controller reattaches or reconciles |
| Interrupt arrives before `prepareReview` was observed | `blocked` with `candidate_digest_unknown`; `approve` refused; `deny` works |
| Unexpected interrupt kind | `blocked` with `unexpected_interrupt`; never auto-resolved |

### Live demonstration

Once, with a real model against `cli-flags`, the happy path is run through the
factory CLI and its event log, worker thread id, candidate digest and receipt
path are saved to a dated runbook under `docs/superpowers/runbooks/` named `software-factory-rung0-live`
in the style of the code-fixer evaluation ledger. It is evidence the seam
works with a real worker, not a measurement of anything.

### What the proof does not claim

Nothing about repair correctness, token budgets, multi-attempt behaviour,
authentication, or any target other than the shipped `cli-flags` fixture.

## Repository layout

```text
examples/software-factory/
  README.md                         what rung 0 is and is not; operator caveats
  server/
    package.json                    @b4-example/software-factory-server
    tsconfig.json  biome.json  vitest.config.ts
    src/
      cli.ts                        create | dispatch | approve | deny | cancel | show | list | events
      http.ts                       same commands on 127.0.0.1, JSON in and out
      config.ts                     FACTORY_* environment, validated
      domain/
        states.ts                   closed union, terminal set, transition table
        work-order.ts               zod schemas for rows, events, intents, outcomes
      registry/
        db.ts                       node:sqlite open, WAL, migrations, version row
        work-orders.ts              compare-and-swap writes, event append
        commands.ts                 operation-key lookup and two-phase commit
      controller/
        commands.ts                 create, dispatch, approve, deny, cancel
        stream.ts                   SSE consumer; prepareReview and interrupt observers
        reconcile.ts                startup reconciliation rules
        budget.ts                   active-time accounting and cancel trigger
      worker/
        client.ts                   the seven Agent Protocol calls, zod-validated
        outbox.ts                   receipt observation by digest
    test/
      fake-worker.ts                scripted Agent Protocol fake (node:http)
      *.test.ts                     one file per module plus factory-* scenario files
```

The factory imports nothing from `examples/code-fixer` and nothing from
`@b4run/cli/runtime`. Its only b4 dependency at runtime is the wire protocol;
it has no b4 dependency in tests at all in rung 0.

## Risks accepted for rung 0

- **Shared-host outbox read.** The factory trusts a file the worker wrote.
  Acceptable only because rung 1 replaces it and code-fixer itself re-verifies
  before writing.
- **Digest from a worker tool result.** The recorded candidate digest comes
  from the worker's own `prepareReview` output. It is an identifier for
  matching the receipt, not evidence of correctness. Rung 1 makes the
  controller compute it.
- **Loopback without authentication.** Identical to the research example's
  documented posture. Documented in the README; not to be exposed.
- **One worker, one fixture.** Generality is not claimed.

## Success criteria for rung 0

1. All layer 1 scenarios pass in CI on every push.
2. The live demonstration ledger exists and shows one `exported` work order
   with matching candidate digest and receipt filename, produced by the real
   code-fixer with a real model through the factory CLI, including one factory
   restart while the work order was `awaiting_approval`.
3. The offline real-worker lane is recorded as deferred, with the reason, in
   this spec and the README.
4. `pnpm ci:validate` is green with the new workspace member included in lint,
   typecheck and test.
5. `examples/code-fixer` has no diff.
