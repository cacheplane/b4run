# Software factory, rung 0: a controller in front of the unchanged code-fixer

Date: 2026-09-16
Status: design approved in conversation; amended once (two-turn worker protocol, see "Amendment"); awaiting written review of the amendment
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

## Amendment: two-turn worker protocol

The first approved draft had the worker call `exportForReview` in its first
turn and park on the approval interrupt; the operator's `approve` resolved that
interrupt. Planning found that this cannot be driven offline: the testing
package's `aimock` fixtures are static and matched by user message and turn
index (`packages/testing/src/fixture-builder.ts`), while the `exportForReview`
arguments contain a candidate that only exists after `prepareReview` runs in
the same turn. The single-turn protocol could only ever be proven with a live
model, which defeats rung 0's purpose.

The amended protocol splits the worker's work into two turns owned by the
controller:

1. **Turn 1, produce.** The controller starts a run whose prompt asks the
   worker to reproduce, repair, verify with `prepareReview`, and stop. The
   controller records the verified candidate from the `prepareReview` result
   frame and, when the turn ends, moves the work order to `candidate_ready`.
2. **Turn 2, submit.** Only after the operator's `approve <digest>` is
   recorded does the controller start a second run on the same thread asking
   the worker to submit exactly that candidate with `exportForReview`. The
   worker's tool-approval interrupt fires; the controller resolves it with
   `once`, because the operator's approval for that digest is already in the
   registry. `exportForReview` re-validates the candidate against the
   workspace, re-verifies it, and writes the receipt named by the digest.

This is closer to the RFC than the first draft. Approval is a factory command
against a recorded candidate, the worker's HITL gate becomes an internal
mechanism the controller satisfies with recorded authority, the controller
drives the worker's phases, and the 500-character interrupt preview is no
longer load-bearing for anything. It also matches how code-fixer's own
integration test already drives export as a second run.

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
  `buildArgsPreview`). Nothing in rung 0 reads a digest from it.
- `aimock` fixtures are static and matched on `userMessage`, `turnIndex` and
  `hasToolResult`. Any prompt the controller sends must be a known constant so
  tests can register the worker's scripted reply for it.
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
| 0 | Controller in front of the unchanged code-fixer. Registry, closed state machine, loopback Agent Protocol dispatch, child thread recorded before dispatch, approval as a factory command, cancel, restart reconciliation. | One `cli-flags` work order runs intake to exported receipt through the factory with replay fixtures. Restart, cancel, stale approval and duplicate command invariants pass. |
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
- Two test layers and one recorded live demonstration.

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
| Start a turn | `POST /threads/:id/runs/stream` with `{ route, input: { messages: [{ role: "user", content }] } }`, consumed as SSE |
| Reattach | `GET /threads/:id/runs/stream`, first frame is `event: state` |
| Read parked prompts | `GET /threads/:id/pending_interrupts` |
| Resolve the worker's export gate | `POST /threads/:id/resume` with `{ resume: [{ interruptId, status: "resolved", payload }], route }` |
| Cancel | `POST /threads/:id/cancel` |
| Thread status | `GET /threads/:id` |

`payload` is `"once"` or `"deny"`. The client never sends `"always"`; a
persistent grant for export is prohibited by RFC section 8.3. The resume body
must name every pending interrupt exactly once, so the client resolves the
whole set returned by `pending_interrupts` and refuses if more than one is
pending or if the pending prompt is not the expected `exportForReview` gate.

### Prompts are constants

The controller sends exactly two prompts, both exported constants so tests can
script the worker's replies to them.

- Turn 1, per task id. For `cli-flags`: "Read TASK.md, reproduce the failure,
  repair the permitted source, verify the preservation requirements, and call
  prepareReview. Do not call exportForReview; the factory will ask for export
  separately."
- Turn 2, a function of the digest: "Export the verified candidate whose
  receiptDigest is `<digest>` by calling exportForReview with the exact
  candidate object returned by prepareReview."

### Work-order states

Closed union. No other value may be stored.

| State | Meaning |
|---|---|
| `received` | Registered; no external effect yet |
| `dispatched` | Child thread created and recorded; turn 1 not yet confirmed started |
| `running` | Turn 1 stream open or known live |
| `candidate_ready` | Turn 1 ended after a `prepareReview` result with `verification.passed` true; digest recorded |
| `exporting` | Approval recorded; turn 2 in progress or its gate being resolved; receipt not yet observed |
| `exported` | Receipt observed whose filename equals the approved candidate digest |
| `denied` | Operator denied the candidate; no export turn was sent |
| `cancel_requested` | Cancel recorded; worker cancel sent or pending |
| `cancelled` | Worker confirmed quiet after cancel |
| `blocked` | Cannot proceed without operator action; `blocked_reason` recorded |
| `failed` | Turn 1 reported a route error, or ended without a verified candidate |

Terminal states: `exported`, `denied`, `cancelled`, `failed`. `blocked` is not
terminal; its exits are `deny` and `cancel`.

Active states, for budget accounting: `dispatched`, `running`, `exporting`.

### Transition table

Every transition is a row here. The command layer refuses anything else.

| From | Event | To |
|---|---|---|
| `received` | `dispatch_committed` (thread id committed) | `dispatched` |
| `dispatched` | `run_started` (first frame received, or thread shows a live run) | `running` |
| `dispatched`, `running` | `candidate_ready` (turn 1 `done` after a passing `prepareReview` result was recorded) | `candidate_ready` |
| `dispatched`, `running` | `run_failed` (turn 1 `done` with `output.error`) | `failed` (reason `route_error`) |
| `dispatched`, `running` | `run_ended_without_candidate` (turn 1 `done` with no passing `prepareReview` recorded) | `failed` (reason `ended_without_candidate`) |
| `dispatched`, `running`, `exporting` | `unexpected_interrupt` (any pending interrupt that is not the `exportForReview` tool gate) | `blocked` (reason `unexpected_interrupt`) |
| `candidate_ready` | `approve` validated and turn 2 started | `exporting` |
| `candidate_ready`, `blocked` | `deny` validated (pending interrupt, if any, resolved with `deny`) | `denied` |
| `exporting` | `receipt_observed` (`<candidateDigest>.json` present) | `exported` |
| `exporting` | `export_unconfirmed` (turn 2 or its resume ended with `output.error`, or no receipt within the export wait) | `blocked` (reason `export_unconfirmed`) |
| any non-terminal | `cancel` recorded | `cancel_requested` |
| `cancel_requested` | `run_ended_after_cancel` (no run in flight and no pending interrupt, after resolving any pending gate with `deny`) | `cancelled` |
| `cancel_requested` | `run_ended_after_budget` (same condition, cancel was budget-triggered) | `blocked` (reason `budget_exhausted`) |
| `dispatched`, `running`, `exporting` | `budget_exhausted` | `cancel_requested` |

A premature `exportForReview` gate during turn 1 (a live model ignoring the
prompt) is resolved with `deny`, recorded as event `premature_export_denied`,
and does not change state; turn 1 continues.

Every transition increments `revision`. Writes are compare-and-swap on
`(id, revision)`; a lost race is a refused command, never a silent overwrite.

### Where the candidate digest comes from

The controller watches the turn 1 stream for the `tool_result` frame named
`prepareReview`, parses its output (an object, or a JSON string of one), and
records `candidate.receiptDigest`, `verification.passed`, and the full
candidate object as event `candidate_observed`. The digest is an identifier
for matching the receipt, not evidence of correctness; code-fixer's
`exportForReview` recomputes the digest, refuses a changed workspace, and
re-verifies before writing the receipt, so `exported` is reached only when a
file named by the approved digest appears. Rung 1 makes the controller compute
the digest itself.

### Commands

Every command takes an `operationKey` (client-supplied, or derived
deterministically by the CLI as `<command>:<workOrderId>:<revision>`). The
command layer first looks the key up in `commands`; a hit with an outcome
returns it without touching the worker; a hit without an outcome is refused
as in flight until reconciliation resolves it. A miss commits the intent in
one SQLite transaction, performs the work, then commits the outcome under the
same key. A crash between the two commits leaves a committed intent that
reconciliation inspects on restart.

| Command | Preconditions | Effect |
|---|---|---|
| `create` | task id in the allowlist (`cli-flags` only in rung 0) | Row in `received` with limits |
| `dispatch` | `received` | `POST /threads`, commit thread id (`dispatched`), start turn 1, observe it |
| `approve` | `candidate_ready`; supplied `revision` matches; not expired; supplied `candidateDigest` equals the recorded one | Approval row; `exporting`; start turn 2; resolve the `exportForReview` gate with `once`; wait for the receipt; `exported` or `blocked` |
| `deny` | `candidate_ready`, or `blocked` | Resolve any pending gate with `deny`; `denied` |
| `cancel` | any non-terminal | `cancel_requested`; `POST cancel` if a run is live; resolve any pending gate with `deny`; `cancelled` |
| `show`, `list`, `events` | none | Read-only |

`approve` requires the operator to pass the candidate digest they are
approving. This is the RFC's "approval authorizes an exact candidate", made
literal at the CLI. Approvals expire after `FACTORY_APPROVAL_TTL_MS` (default
15 minutes) measured from the moment the work order entered `candidate_ready`;
an expired work order must be denied or cancelled. `approve` returns only when
the export has been confirmed or marked unconfirmed.

### Startup reconciliation

On boot the factory walks every non-terminal work order in registry order and
applies these rules before accepting commands. It never starts turn 1 or turn
2 on its own.

1. A `commands` row with intent committed but no outcome: inspect the worker
   (`GET /threads/:id`, `pending_interrupts`, outbox) and record the outcome
   the state rules below produce. If the intent was `dispatch` and no thread id
   was committed, record the command as failed and leave the work order in
   `received`.
2. `dispatched` or `running`: if the thread shows a live run, reattach with
   `GET runs/stream` and continue observing. If the thread is idle: a recorded
   passing `prepareReview` gives `candidate_ready`; otherwise `failed` with
   `ended_without_candidate`. If `pending_interrupts` returns the
   `exportForReview` gate (premature export), resolve it with `deny` and
   re-evaluate; any other pending interrupt gives `blocked`.
3. `candidate_ready`: no worker call needed; the state stands.
4. `exporting`: if the receipt exists, `exported`. Else if the
   `exportForReview` gate is pending and an approval row for this digest
   exists, resolve it with `once` and wait for the receipt (this is the
   continuation of an already-authorized export, not a new approval). Else
   `blocked` with `export_unconfirmed`.
5. `cancel_requested`: apply the cancel rows of the transition table.
6. `blocked`: the state stands.

Reconciliation results are events like any other, so the operator can see what
the factory concluded and why.

### Budgets

Rung 0 enforces two limits per work order: `maxCandidateAttempts = 1` (there
is no repair loop, so a `failed` work order is final) and `maxActiveMs`
(default 20 minutes) counted only while the state is active. Time spent in
`candidate_ready` or `blocked` is not active time. Exceeding the active limit
triggers `cancel` with the budget flag. Token, model-call and cost limits are
not observable through the Agent Protocol and are explicitly deferred.

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
  candidate_digest text,
  candidate_verified integer,
  blocked_reason text,
  failure_reason text,
  max_candidate_attempts integer not null,
  max_active_ms integer not null,
  active_ms integer not null default 0,
  active_started_at text,
  candidate_ready_at text,
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
Schema changes ship with a migration and a version row; the factory refuses to
open a registry written by a newer schema.

## Proof

### Layer 1, always on: fake worker

An in-process fake Agent Protocol server implements the seven calls in the
worker client table with the documented status codes and SSE frames, and
nothing more. It is scripted per test through named behaviours for turn 1
(`happy`, `route_error`, `no_candidate`, `hang`, `close_midway`,
`unexpected_interrupt`, `premature_export`), turn 2 (`gate`, `route_error`,
`hang`) and resume (`receipt`, `no_receipt`, `route_error`), and it records
every request it receives. The fake is written from the protocol document, not
from what the controller happens to send, and the real HTTP worker client is
what talks to it, so the client's parsing is exercised too.

### Layer 2, Docker-gated: the real code-fixer

Boots the unchanged code-fixer with `createSubprocessApp` from
`@b4run/testing` on a private copy of its app root, pointed at `createAimock`.
Turn 1 fixtures are code-fixer's own replay script (the historical
`reference.patch` applied, `prepareReview` called) registered against the
factory's turn 1 prompt constant. After the factory reaches
`candidate_ready`, the test reads the full candidate from the
`candidate_observed` event and registers the turn 2 fixture (user message =
the turn 2 prompt for that digest, one `exportForReview` call with that
candidate) before calling `approve`. No live model is involved. The lane runs
under `B4_TEST_DOCKER=1` in `test/**/*.integration.test.ts`, mirroring
code-fixer's `vitest.sandbox.config.ts`, and requires the
`b4-code-fixer:fixture-v1` image from `pnpm code-fixer:prepare`.

Both layers execute the shared scenarios from one test module, parameterised
by the worker under test. Scenarios that need scripted misbehaviour run in
layer 1 only and are marked below.

### Invariants

| Scenario | Layers | Required outcome |
|---|---|---|
| Happy path | 1, 2 | `received` to `exported`; exactly one receipt named by the approved digest; the `thread_created` event precedes `run_started` |
| `approve` with stale revision, wrong digest, or after expiry | 1, 2 | Refused; no turn 2 started; state and revision unchanged |
| `approve` twice with the same operation key | 1, 2 | Second call returns the recorded outcome; one turn 2 and one resume on the wire (wire count asserted in layer 1) |
| `deny` from `candidate_ready` | 1, 2 | `denied`; no turn 2; outbox empty |
| Factory restarts while `candidate_ready` | 1, 2 | Reconciles without any worker write; `approve` still works |
| Factory restarts while `exporting` with the gate pending | 1 | Reconciliation resolves the gate with `once` from the recorded approval; `exported`; no second approval row |
| Factory restarts while `exporting` after the receipt was written | 1 | `exported` from the existing receipt; no worker call that mutates |
| Factory dies between intent commit and `POST /threads` | 1 | On restart the `dispatch` command is marked failed and the work order stays `received`; no thread was created |
| `cancel` while `running` | 1 | `POST cancel` reaches the worker; `cancelled` only after the run is confirmed ended |
| `cancel` while `candidate_ready` | 1, 2 | `cancelled` with no worker cancel call (nothing is running) |
| Active budget exceeded during turn 1 | 1 | Controller cancels; `blocked` with `budget_exhausted`; no further worker calls |
| Turn 1 stream closes mid-run | 1 | Registry unchanged by the disconnect; controller reattaches or reconciles |
| Turn 1 ends without `prepareReview` | 1 | `failed` with `ended_without_candidate` |
| Turn 1 reports a route error | 1 | `failed` with `route_error` |
| Premature `exportForReview` gate in turn 1 | 1 | Resolved with `deny`; event `premature_export_denied`; turn 1 continues to `candidate_ready` |
| Unexpected interrupt kind | 1 | `blocked` with `unexpected_interrupt`; never auto-resolved; `deny` resolves it and ends `denied` |
| Turn 2 or resume ends with a route error, or no receipt appears | 1 | `blocked` with `export_unconfirmed` |

### Live demonstration

Once, with a real model against `cli-flags`, the happy path is run through the
factory CLI and its event log, worker thread id, candidate digest and receipt
path are saved to a dated runbook under `docs/superpowers/runbooks/` named
`software-factory-rung0-live`, in the style of the code-fixer evaluation
ledger. It is evidence the seam works with a real worker, not a measurement of
anything.

### What the proof does not claim

Nothing about repair correctness, token budgets, multi-attempt behaviour,
authentication, or any target other than the shipped `cli-flags` fixture.

## Repository layout

```text
examples/software-factory/
  README.md                         what rung 0 is and is not; operator caveats
  server/
    package.json                    @b4-example/software-factory-server
    tsconfig.json  biome.json  vitest.config.ts  vitest.integration.config.ts
    src/
      cli.ts                        create | dispatch | approve | deny | cancel | show | list | events | serve
      http.ts                       same commands on 127.0.0.1, JSON in and out
      config.ts                     FACTORY_* environment, validated
      prompts.ts                    turn 1 prompt per task, turn 2 prompt per digest
      domain/
        states.ts                   closed union, terminal and active sets, transition table
        work-order.ts               zod schemas for rows, events, intents, outcomes
      registry/
        db.ts                       node:sqlite open, WAL, migrations, version row
        work-orders.ts              compare-and-swap writes, event append
        commands.ts                 operation-key lookup and two-phase commit
      controller/
        factory.ts                  createFactory: create, dispatch, approve, deny, cancel, reads
        turns.ts                    turn 1 and turn 2 observers over the stream
        reconcile.ts                startup reconciliation rules
        budget.ts                   active-time accounting and cancel trigger
      worker/
        wire.ts                     zod schemas for frames and responses
        sse.ts                      Server-Sent Events parser
        client.ts                   the seven Agent Protocol calls
        outbox.ts                   receipt observation by digest
    test/
      fake-worker.ts                scripted Agent Protocol fake (node:http)
      scenarios.ts                  shared invariant scenarios, parameterised by worker
      states.test.ts                transition table
      registry.test.ts              CAS, idempotency, migrations
      worker-client.test.ts         client against the fake
      controller.test.ts            layer 1, shared and fake-only scenarios
      code-fixer.integration.test.ts  layer 2, Docker-gated
```

The factory imports nothing from `examples/code-fixer` and nothing from
`@b4run/cli/runtime`. Its only b4 dependency at runtime is the wire protocol;
its only b4 dependency in tests is `@b4run/testing`. The layer 2 test reads
files from the code-fixer directory (manifest, reference patch, sample
project) to build fixtures; it does not import its modules.

## Risks accepted for rung 0

- **Shared-host outbox read.** The factory trusts a file the worker wrote.
  Acceptable only because rung 1 replaces it and code-fixer itself re-verifies
  before writing.
- **Digest from a worker tool result.** The recorded candidate digest comes
  from the worker's own `prepareReview` output. It is an identifier for
  matching the receipt, not evidence of correctness. Rung 1 makes the
  controller compute it.
- **The controller resolves the worker's export gate itself.** This is safe
  only because the gate is resolved exclusively inside `approve` (after the
  operator's recorded approval) or inside reconciliation of an `exporting`
  work order that already has an approval row for the same digest. A pending
  gate in any other state is denied, never granted.
- **Loopback without authentication.** Identical to the research example's
  documented posture. Documented in the README; not to be exposed.
- **One worker, one fixture.** Generality is not claimed.

## Success criteria for rung 0

1. All layer 1 scenarios pass in CI on every push.
2. All layer 2 scenarios pass under `B4_TEST_DOCKER=1` locally and in the
   existing `sandbox-docker` lane.
3. The live demonstration runbook exists and shows one `exported` work order
   with matching candidate digest and receipt filename.
4. `pnpm ci:validate` is green with the new workspace member included in lint,
   typecheck and test.
5. `examples/code-fixer` has no diff.
