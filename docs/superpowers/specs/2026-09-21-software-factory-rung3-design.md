# Software factory rung 3: live issues

Status: design, 2026-09-21. Amend it as execution changes it, the way rung 2's was.
Program: [the RFC](2026-09-16-software-factory-rfc.md). Predecessor:
[rung 2](2026-09-19-software-factory-rung2-design.md) and its
[handoff](../notes/2026-09-21-software-factory-rung2-handoff.md).

Rung 2 proved the controller can judge a repair against a real package in real containers.
Every builder turn was scripted, every task was hand-authored with the answer already known,
and the only way to run the factory against a model was a runbook a person follows once.
Rung 3 replaces that with the thing the program is for: **an open issue in this repository
enters the factory by an operator's command, and a verified repair for it comes out.**

The rung is not "a live model produced a patch". It is "the factory took work it had never
seen, made an oracle for it that a person approved, and refused or delivered on that oracle's
say-so".

---

## 1. Decisions taken in the design conversation

Recorded so they are not relitigated by the plan. Each was a choice among named alternatives.

| Decision | Chosen | Rejected, and why |
|---|---|---|
| Who authors the independent oracle for a live issue | **Model-drafted, human-approved.** A first model stage drafts a failing test from the issue; a person approves it before the builder sees the spec | Human-written (makes the factory a patch generator). Model-drafted with no human gate (builder and test author share a model family and nothing independent checks either) |
| Where a completed work order lands, first | **Local export**, exactly as today; the draft pull request is the following rung | Draft PR in the same rung (pulls credentials, an outbox and remote receipts into the proof of intake) |
| How an issue enters | **Operator-pulled by number**, one command per issue | Label-driven poll first (a standing credential, a queue and dedupe before intake is proven). The label path follows once one issue has gone all the way through |
| Which environment a work order runs in | **A target per package, chosen by intake and approved by the person; the pin is recorded at create time as `origin/main`'s commit** | One existing target only (almost nothing qualifies). Whole-repository target (the capture's entry, byte and portable-path limits make that a framework change first) |
| What the approver can do at the intake gate | **Approve or reject, by digest. No edits.** A rejection carries a note and, attempts permitting, starts another draft | Edit-then-approve on disk (more surface; the person becomes a co-author of the oracle). Workbench UI (pulls M2's authenticated surface forward) |
| What the controller is | **A separate b4 app whose routes are `workflow` routes** (§4) | Plain code beside the example forever (what rung 0 chose when it believed no b4 route could host it; §3 records why that belief was too broad). A `graph` or `agent` route (one-shot, or a model deciding transitions) |
| How the builder gets a task per work order | **Framework change: the workspace definition is resolved per thread** (§5) | Spawning a builder process per work order with the task in its environment. It works, and it is a lab answer: it keeps the one-task-per-process workaround alive |

---

## 2. What the code survey found

Three facts from reading `main` at `193b5759`, each of which changes the shape.

**The visible suite has no live-issue analogue.** Today a task's `checks.json` names
assertions in the *target's own* test suite that `defect.patch` makes fail. A live issue has
no such test. In rung 3 the builder is given the spec and the package's existing suite as a
regression guard; the drafted failing test is the *independent* oracle only, held by the
controller, never in the builder's capture. `visible.assertions` becomes optional. If the
builder wants a reproducer it reads the spec, not the oracle.

**The builder's workspace is one definition per app.** `SandboxConfig.workspace` is a single
`WorkspaceDefinition` (`packages/workspace/src/sandbox-types.ts`). `b4 build` captures it into
an artifact whose descriptor digest the runtime verifies on boot
(`packages/cli/src/lib/build/workspace-artifact.ts`). The factory works around this by baking
one task into the builder process through `FACTORY_TASK_ID`. A live issue has a different pin,
capture and boundaries per work order, so one built app cannot serve two work orders.

But the storage layer already models a definition **per thread**: `ManagedWorkspaceManager`
creates each thread's `WorkspaceCreateIntent` with its own `sourceDigest`, puts that source in
the installation's content store, and already has a `captureDefinition` hook it calls on first
admission (`packages/cli/src/lib/runtime/managed-workspace-manager.ts`, `getForThread`). The
hook takes no arguments. The change is to give it the thread. §5.

**A `workflow` route is what the controller is.** The rung 0 survey found that only `agent`
routes get a checkpointer, interrupts and resume, and concluded the controller had to be plain
code. That was right about parking and wrong about the controller: the controller never parks.
Every wait is a row in its registry. Each operator command is a bounded, deterministic
function against durable state, which is precisely the `workflow` entry kind
(`packages/sdk/src/route-config.ts`; executed once with `{signal, tools, fs}` in
`execute-route-core.ts`). The one long span, observing a builder run then verifying, is
minutes, runs as an Agent Protocol run on the controller's thread, and is cancelled through
the context's signal. §4.

---

## 3. Findings for the framework, on record

Rungs 1 and 2 each surfaced a framework change by pointing the factory at real code
(`--init`, the portable-path limit). Rung 3 surfaces two more before writing a line.

1. **Managed workspaces cannot vary per thread from the host's config.** The runtime and
   storage support it; the configuration surface and the build artifact do not. Fixed in §5.
2. **b4 has no durable, model-free workflow primitive** beyond a single `workflow`
   invocation. Multi-step state, journalling, idempotent commands and reconciliation are the
   application's to build. The controller's registry (`states.ts`, the event journal, the
   two-phase command log) is the best requirements list b4 has for such a primitive. This
   rung does **not** build it. It moves the controller onto `workflow` routes so the gap is
   measured from the right place, and leaves the primitive as a later program.

---

## 4. The controller as a b4 app of `workflow` routes

> **Revised 2026-09-22** after a code survey of the runtime. The first draft assumed detached
> runs, several runs per thread, and a boot hook; b4 has none of those. What follows is the
> shape that fits the runtime as it is. The findings are in §4.5.

### 4.1 Shape

`examples/software-factory/controller` is a new b4 app beside the existing `server` app, which
becomes the builder only. The controller's **mutating commands** are `workflow` routes:

```
src/app/work-orders/create/index.ts            create a work order (catalog task, later an issue)
src/app/work-orders/dispatch/index.ts          create the builder thread, observe, verify; awaits the run
src/app/work-orders/approve/index.ts           re-verify, freeze, export
src/app/work-orders/deny/index.ts
src/app/work-orders/cancel/index.ts
src/app/work-orders/approve-intake/index.ts    §6
src/app/work-orders/reject-intake/index.ts     §6
src/app/reconcile/index.ts                     the whole registry, on the controller thread
```

**Reads are not routes.** `show`, `list`, `events` and `evidence` read the registry directly,
read-only, from whatever process asks (the CLI, a test, later the Workbench). The registry is
the source of truth; a read never needed a run. Only the controller app writes the registry.

The state machine, journal, command log, verifier, workspace reader, assembly, bundle and
export code move **unchanged** into `src/lib/`. The task and target catalog moves with them,
and the builder imports nothing from it; see the as-landed note below.

> **As landed:** the packages share no source. The controller writes a JSON manifest per
> task (`factory builder-manifest`): the captured workspace, the target's image, sandbox
> policy and permissions, and the prompt. The builder's `b4.config.ts` verifies and serves
> it through the resolver form from §5, which is also how sub-project 3 will pick a task
> per thread.

> **As landed, the pins are historical.** The targets' `target.json` paths (`root`,
> `imageContext`, `lockfile`) and the target Dockerfiles' `COPY` lines name the tree at the
> **pinned commit**, where the fixtures lived under `examples/software-factory/server/`. They
> are correct exactly as long as the pin predates this move. The next re-pin to a commit at or
> after this branch must rewrite them to `examples/software-factory/controller/fixtures/...`
> in the same edit: a missed `root` fails loudly at archive time, but a missed `imageContext`
> entry silently builds a smaller image.

The builder stays its own app, reached over the loopback Agent Protocol as now; the
controller is told the builder's app root so the workspace reader can address the builder's
installation store. The
factory CLI becomes an HTTP client of the controller's routes for writes, and a read-only
registry reader for reads.

### 4.2 One thread per work order

A work order's id is its controller thread id. Every mutating command for that work order
runs on that thread. This is what the runtime's rules mean for the controller:

- **Serialisation is the runtime's.** One run at a time per thread; a second command on the
  same work order while one is in flight is refused with the Agent Protocol's `run_in_flight`,
  which the CLI reports as a refusal. Commands on different work orders run concurrently.
- **`dispatch` awaits the run.** The route creates the builder thread, observes the turn,
  verifies, and returns the outcome only when the work order has left its active states. The
  CLI streams the run and prints journal events as they land; there is no fire-and-forget
  `dispatch`. If the client disconnects, the route keeps running and the work order's fate is
  recorded exactly as it would have been; reconcile covers a crash.
- **Cancel is the runtime's cancel.** `cancel` is `POST /threads/<work-order-id>/cancel`, which
  aborts the in-flight `dispatch` route's signal; the route's own cancel path records the
  outcome. A `cancel` route exists for a work order that is not mid-run (`awaiting_approval`,
  say) and for the outcome recorded after an abort.
- **The budget ticker lives in the route.** While `dispatch` awaits, it owns the active-time
  clock for that work order; there is no process-wide ticker.

  > **As landed:** the ticker stays in the Factory. A process-lived Factory exists after all,
  > opened by middleware `setup` and closed by `dispose`, so the ticker, tracked runs and
  > `close()` keep their rung 2 shape; `dispatch` awaits its run through `Factory.settle`.
  > Per-command reconcile skips the reattach when an observer for that work order is already
  > live in this process (`ControllerContext.isTracked`), so it cannot evict the observer a
  > `dispatch` left running; the `reconcile` route is the boot reconcile (`reconcileAll`),
  > not a per-row loop. A `StaleRevisionError` is a refusal (`stale_revision`), not a 500.

- **Reconcile is scoped.** Every mutating route reconciles its own work order before acting.
  `reconcile` on the fixed controller thread walks the whole registry and is called by the
  operator or a supervisor after a restart; the app has no boot hook to do it unasked.
- **Refusals are return values.** A route returns the same `CommandOutcome` the Factory
  returns today (`ok`, `state`, `message`), plus a `refusal` discriminator for the cases the
  HTTP layer mapped to 400/404/409 (unknown task, unknown work order, command in flight,
  invalid input). Thrown errors reach the runtime as 500s and lose the CLI's exit-code
  contract, so nothing expected is thrown.
- **Input is validated in the route.** A workflow route receives its input verbatim; the route
  parses it with the command's zod schema. Typed-state generation does not apply.

### 4.3 What changes, and what does not

- **Idempotency is unchanged.** Every command already takes an operation key and returns the
  recorded outcome on replay; the key rides in the route's input.
- **The trust argument is unchanged.** The concern was never process separation; it was a
  model deciding transitions. Workflow routes are code. The builder has four workspace tools
  and a denied network and no channel to the controller's routes.
- **Single writer by construction.** Only the controller app opens the registry for writing.
  The CLI's write commands are HTTP calls; its read commands open the registry read-only. A
  second controller process against the same registry is an operator error the registry does
  not detect (SQLite WAL permits it); recording an owner is a follow-up, not this rung.
- **The Factory object stays per-process** *(as landed; the draft said per-route)*. There is
  one Factory for the controller process, opened by the app's middleware `setup` hook — the
  only lifecycle hook b4 gives an app — and closed in `dispose`. Routes reach it through the
  runtime singleton rather than constructing anything of their own, and the verifier and the
  workspace reader are constructed once, inside it. Tracked runs, the budget ticker and
  `close()` therefore keep their rung 2 shape (see §4.2).
- **Nothing here needs a live model.** The port lands green on the scripted proofs.

### 4.4 Proof

The rung 2 unit suite (fake worker, fake verifier, fake reader) passes against the ported
controller with the CLI replaced by route calls and direct reads; the Docker lane passes
unchanged; the registry produced by a run is byte-compatible with rung 2's schema (a rung 2
registry opens and reconciles under rung 3). The adversarial cases (tamper, delayed writer,
weak repair) are re-run, not assumed. A cancelled `dispatch` records the same outcome as
today's cancel, and a client that disconnects mid-`dispatch` leaves a work order that a later
`show` reports as finished, not stuck.

### 4.5 What the survey found, on record

- A run on a `workflow` route holds its HTTP request open until the route returns; there is no
  accept-then-poll mode, and an abandoned route keeps running with its run slot held.
- One run at a time per thread; the thread id is the concurrency unit and the cancel target.
- No boot hook. Middleware `setup` runs lazily before the first request it gates and is
  retried on rejection; `dispose` runs on SIGTERM on Node targets only.
- A workflow route sees no thread id, run id or route params; identity rides in its input.
- Errors thrown from a route are 500s with the message in the body.
- The registry takes no process lock.

These are the concrete requirements list for the durable workflow primitive named in §3.

---

## 5. Framework: a workspace definition resolved per thread

### 5.1 The change

`SandboxConfig.workspace` accepts either the existing static `WorkspaceDefinition` or a
**resolver**:

```ts
export interface WorkspaceResolverInput {
  readonly threadId: string
  /** Client metadata recorded when the thread was created, reserved keys stripped. */
  readonly metadata: Readonly<Record<string, unknown>>
  /** Aborted when the admitting run is cancelled. Pass it to any I/O the resolver does. */
  readonly signal: AbortSignal
}
export type WorkspaceResolver = (
  thread: WorkspaceResolverInput,
) => Promise<WorkspaceDefinition | CapturedWorkspaceDefinition>

interface SandboxConfig {
  readonly workspace?: WorkspaceDefinition | WorkspaceResolver
  ...
}
```

> **As landed:** the input carries the admitting run's abort signal (a resolver does I/O and
> runs inside the thread's admission critical section), and the return is `Promise` only.

The resolver is called **once per thread, at first admission**, from
`ManagedWorkspaceManager.getForThread` where `captureDefinition` is called today. Its result
is captured (or verified, if already captured), its source is put in the installation's
content store, and the thread's `WorkspaceCreateIntent` records the source digest exactly as
it does now. Later admissions of the same thread never call the resolver again: the intent is
the record. This keeps the property the storage layer already has, that a thread's workspace
is fixed at creation and readable by digest afterwards.

`openWorkspaceReader` and the factory's `withManagedWorkspaceReader` need no change: they
resolve a thread's record and its published source, which is per thread already.

### 5.2 Where the thread's metadata comes from

Thread metadata is client-supplied at `POST /threads` and stored with the thread
(`runtime-fetch-core.ts`, `stripReservedThreadMetadata`). The factory already passes
`{ factoryWorkOrderId }` there. The resolver receives that record, so a builder app resolves
its task from the work order the thread was created for: read the generated task directory
the controller wrote, build the `WorkspaceDefinition` with `targetWorkspace(task, "builder")`.

The thread's metadata reaches the sandbox acquisition through a new optional
`sandboxThreadMetadata` on the execution options, populated by the Agent Protocol server from
the thread store next to the existing `sandboxThreadId`. Subagent threads inherit the parent's
metadata; they do not get a fresh resolution.

> **As landed:** there is no `sandboxThreadMetadata` option. Admission takes a
> `WorkspaceAdmissionContext` whose `metadata(signal)` is a lazy loader; the runtime passes one
> that reads the thread from the threads store and strips the reserved key, and the manager
> invokes it only for a thread with no workspace record, keyed by the sandbox key, so a subagent
> resolves through its parent's thread. What the resolver sees: the stored metadata with the
> reserved key stripped; on the server run endpoints `route` is present and server-authoritative
> because the runtime stamps it before admission; every other key is client-writable and must
> never be an authorization input. `POST /threads` assigns the thread id, so metadata is attached
> at create and the returned id used. `b4 run` mints a fresh thread per invocation, so the
> resolver runs on every run with empty metadata. The metadata object is a frozen shallow copy.

### 5.3 The build artifact

`b4 build` captures a static definition into an artifact and verifies its descriptor digest on
boot, so a deployed app's workspace cannot be swapped under it. A resolver cannot be captured
at build time. The artifact therefore records **which** it is:

```ts
type WorkspaceBuildArtifact =
  | { version: 1; descriptorDigest: string; workspace: CapturedWorkspaceDefinition }  // static, unchanged
  | { version: 2; kind: "resolver" }                                                  // nothing to capture
```

Boot verification is unchanged for the static form. For a resolver, boot verifies the artifact is
the resolver form and the loaded config is a function; the "configuration changed; rebuild"
error fires on a mismatch in either direction. A version-1 artifact is accepted for the static
form (no forced rebuild).

> **As landed:** the resolver form is a tagged version-2 record, not a digest of the string
> `"resolver"`, so the two forms cannot be confused by a digest collision on a constant.

The property lost, stated plainly: for a resolver, the *content* of a thread's workspace is
decided at run time by host code, not fixed at build time. The property kept: it is decided by
**host** code the operator deployed, never by the client or the model, and each thread's
result is recorded by digest before use. `b4 check` reports the form in its route list.

### 5.4 Permissions

`permissions.allow` is also static per app and the factory derives it from the target's
commands. Rung 3 keeps permissions static and makes them the **union** over the targets the
builder app may be asked to serve, computed by the builder's `b4.config.ts` from the target
catalog. This is wider than one target's allow-list. It is acceptable because every command in
it is one the verifier would run anyway, and because narrowing permissions per thread is a
second framework change this rung does not need. Recorded as a follow-up.

### 5.5 Proof

- Unit: a resolver is called once per thread and never on re-admission; two threads with
  different metadata get different source digests; a resolver that throws leaves no
  association and surfaces the error to the run; a resolver result that fails
  `verifyCapturedWorkspaceDefinition` is rejected before any provider call.
- Artifact: static definitions round-trip as before; a resolver app builds; swapping a built
  resolver app's config to a static definition, or the reverse, fails boot with the rebuild
  error.
- Sandbox lane: a two-thread run of the factory builder app where each thread's workspace is a
  different task, read back through the byte channel.

> **As landed:** the sandbox-lane proof belongs to sub-project 3, which owns the builder's
> resolver; sub-project 1 proves two threads through the Agent Protocol with the fake managed
> provider, in development and from a built artifact.

### 5.6 What it does not do

No per-thread permissions, no per-thread sandbox policy, no per-thread provider. One
resolver per app; the resolver is host code and receives only the thread's identity and
client metadata.

---

## 6. Intake: an issue becomes a task

> **Decisions of 2026-09-22, before execution.** Sub-project 3 is two plans. **3a** builds the
> intake lifecycle in the controller and proves it with the scripted fakes: states, registry,
> `create --issue`, generated tasks, draft validation and fit, the oracle proof, the two gate
> routes, reconcile rules. **3b** builds the drafter for real: its own app and fixed image (a
> third process, because a builder process serves one target and intake runs before a target
> is chosen), the wide read-only capture staged under the drafter's root, the re-rooted
> `draft/` read, a per-target worker map in the controller's config, the builder's per-thread
> resolver keyed by the work order, and per-pin images with `target:prepare --pin` and an
> `image_unprepared` block. TypeSafe AI's Jev was researched as an intake aid and deferred to
> a later phase: it cannot run in the network-denied drafter, and as a controller-side gate a
> planted fact in its state moves its verdict; see the research report of 2026-09-22.

### 6.1 Lifecycle

Intake is a prefix on the existing lifecycle, not a fork.

```
received ──intake_started──▶ intake_running ──intake_drafted──▶ awaiting_intake_approval
                                    │                                   │
                                    │ draft invalid / oracle passed     │ approve_intake
                                    │ on baseline / attempts left       ▼
                                    └──────▶ intake_running        received' ──dispatch──▶ (rung 2 lifecycle)
                                                                        │
                                                    reject_intake + note, attempts left ──▶ intake_running
                                                    attempts exhausted ──▶ blocked
```

New states: `intake_running`, `awaiting_intake_approval`. New blocked reasons:
`intake_invalid`, `oracle_did_not_fail`, `intake_attempts_exhausted`, `no_target_for_package`.
`awaiting_intake_approval` is not active time. A catalog-task work order skips intake
entirely: `create --task` lands in `received` as today.

### 6.2 The work-order row

```ts
origin: { kind: "catalog" } | { kind: "issue"; repository: string; number: number; bodyDigest: string }
pin: string | null            // 40-hex, recorded at create, never moves
targetId: string | null       // chosen by intake, approved by the person
taskDigest: string | null     // digest of the generated task directory
intakeAttempts: number
maxIntakeAttempts: number     // 2
```

### 6.3 `create --issue`

The operator runs `factory create --issue 774`. The CLI fetches the issue with the operator's
own credentials (`gh issue view --json`), resolves `origin/main` to a commit, and calls the
`create` route with `{ origin, pin, issue: { title, body } }`. The route writes
`issue.md` (exact title and body) into a fresh generated task directory under the controller's
state, records `bodyDigest` on the row, and journals `created`. No standing credential is
held by the controller. Idempotent on the operation key like every create.

### 6.4 The intake route

`examples/software-factory/server/src/app/intake/index.ts` is an `agent` route beside
`/build`, same four workspace tools, model from `FACTORY_INTAKE_MODEL` (default `gpt-5-mini`).
Its workspace, resolved per thread by §5, is a **read-only wide capture** of the repository at
the work order's pin (`targets/repo-readonly`: root manifests, `packages/*/src`,
`packages/*/test`, `scripts`; no commands; never verified in) plus an empty writable `draft/`.
Its prompt asks for exactly four files under `draft/` and nothing else:

- `task.json`: `target`, `allowedSourcePaths`, `immutablePaths`
- `spec.md`: the repair, with acceptance ids `A1..An`
- `checks.json`: the independent suite's runner, file and assertion ids
- `checks/<name>.test.ts`: a test that fails on the current code and passes when the issue is
  fixed, importing the built artifact by root-relative path, depending on no repository test

It does not repair anything.

### 6.5 What the controller does with the draft

`src/lib/controller/intake.ts`, mirroring `verify.ts`:

1. Read `draft/` through the byte channel with the intake inspection options.
2. Parse against `TaskSchema`, `ChecksSchema` and the spec's acceptance ids. Failure:
   `intake_invalid`.
3. `loadTarget(task.target, { pin })`. No such target: `no_target_for_package`.
   `assertTaskFitsTarget` as today.
4. Materialise the generated task directory (same shape as `tasks/<id>/`, plus `issue.md`) and
   digest it.
5. **Prove the oracle.** Capture the baseline for the generated task and run **only the
   independent suite** against it in a verifier container. Verdict not `fail`:
   `oracle_did_not_fail`. This is the one change to `Verifier.verify`: a `suites` option.
6. Transition to `awaiting_intake_approval` with `targetId` and `taskDigest`.

A failure at 2, 3 or 5 with attempts remaining journals the reason and starts another intake
turn on the same thread with the failure text as the note. On the last attempt it blocks.
Nothing the model wrote is trusted at any step; it is validated, fitted, and shown to fail.

### 6.6 The gate

```
approve-intake  { id, revision, taskDigest }   digest of the directory on disk must equal the row's
reject-intake   { id, note }                   journals the note; attempts permitting, redrafts
```

Approve transitions to `received` and the rung 2 lifecycle proceeds; `dispatch` creates the
builder thread with `{ factoryWorkOrderId }` and the builder's resolver (§5) reads the
generated task. The review bundle gains `origin`, `pin` and `taskDigest`, so approving the
export consents to the issue text, the approved task and the candidate together.

### 6.7 Targets

"A target per package" means intake **chooses among prepared targets**. Preparing a target
(image, measured resources, commands) stays an operator action with `target:prepare`, because
it needs a Docker build and a measurement. Rung 3 prepares targets for the packages the
candidate issues touch (§8) and blocks cleanly on the rest.

The pin is recorded per work order. `loadTarget(id, { pin })` overrides the manifest's pin;
`ensurePin` fetches a missing commit; the image tag binds pin and Dockerfile hash, so a new pin
whose image is absent is a `target:prepare --pin <sha>` before dispatch (the script takes only
the manifest's pin today; the flag is part of sub-project 3), surfaced as a blocked reason
rather than a silent rebuild inside the controller.

### 6.8 Proof

- Unit: the state table with the new rows; `parseDraft` on good and bad drafts; digest
  binding on approve; the attempt bound; the skip of intake for catalog tasks.
- Sandbox lane, scripted intake route: a draft whose check fails on baseline parks; a draft
  whose check passes on baseline blocks with `oracle_did_not_fail`, asserted on the evidence
  text; a draft naming a package with no target blocks with `no_target_for_package`; a reject
  with a note produces a second turn whose prompt contains the note.
- Live: the first operator-pulled issue, recorded as evidence **in the work order**, not in a
  runbook. The runbook form is retired for rung 3.

---

## 7. Sub-projects and order

Each is its own spec-or-plan, PR and proof. 1 and 2 are independent and may run in parallel
worktrees. 3a needs both; 3b needs 3a. 4 needs 3b. 5 is rung 4.

| # | Sub-project | Depends on | Proof |
|---|---|---|---|
| 1 | Per-thread workspace resolver in `@b4run/workspace` + `@b4run/cli` (§5) | — | §5.5 |
| 2 | Controller ported to a b4 app of `workflow` routes (§4) | — | §4.3 |
| 3a | Intake lifecycle with a scripted drafter (§6) | 1, 2 | §6.8's scripted lanes |
| 3b | The drafter for real (§6) | 3a | A two-thread run of the builder app plus one intake turn against the wide capture, Docker lane |
| 4 | First live issue, operator-pulled, local export | 3b, a model key, prepared targets | The work order's own evidence |
| 5 | Draft pull request delivery through an outbox (rung 4) | 4 | Its own spec |

This spec is the design for 1, 2, 3a and 3b. Each gets its own implementation plan under
`docs/superpowers/plans/`. Sub-project 1 is the first plan to write.

---

## 8. Candidate first issues

From the open issues on 2026-09-21, the ones whose fix plausibly lives inside one package with
a preparable target, and which a test can fail on:

- **#774** check-docs fails on main: `B4_E5402` is on the errors page but not in the registry.
  Fix lives under `scripts/` or `packages/sdk` errors; a registry test can fail on it.
- **#778** recording a turn whose assistant message is empty produces a fixture aimock rejects.
  Lives in `@b4run/testing`; the issue carries a runnable reproduction, so the oracle is
  nearly written.
- **#775** capture.mjs targets the untitled-thread row, not the rail's create button. Harness
  code; testable only through a browser, so a poor first oracle.

#774 or #778 first. Neither touches `templates/`, so neither hits the portable-path limit.

---

## 9. Risks accepted

- **The oracle is model-drafted.** The human gate and the fail-on-baseline proof are the two
  checks on it. A test that fails on baseline for the wrong reason and passes after an
  unrelated change is a false oracle a person must catch. Mitigation: the approver sees the
  failing run's output in the evidence, not only the verdict.
- **Wide read capture for intake.** Intake sees more of the repository than the builder. It
  writes only to `draft/` and its output is never trusted without the steps in §6.5.
- **Union permissions on the builder app** (§5.4) until per-thread permissions exist.
- **No per-package target exists yet** for most packages. Rung 3 prepares two or three and
  blocks on the rest with a named reason.
- **Orphan source rows.** The workspace manager puts a thread's source into the installation's
  content store before `provider.resolveEnvironment`; an admission that fails or aborts there
  leaves a row no association references, and nothing reclaims `workspace_sources`. Pre-existing
  for the development recapture hook; a per-thread resolver makes the rows vary per thread.
  Fix is a reclaim of digests referenced by no association, or putting the source after a
  successful `resolveEnvironment`. Follow-up in `@b4run/sqlite-storage` and the manager.
- **The development recapture hook loads metadata it ignores.** A static definition in an
  unbuilt app sets the recapture hook, so first admission performs one threads-store read per
  new thread and discards it. Harmless; the hook could signal it needs none.
- **The runtime's 409 bodies carry `code` under `details`.** `runtime-fetch-core.ts` passes
  `{ code }` as `createRequestErrorBody`'s second positional argument (`details`) for the
  `run_in_flight` and `run_cancelled` 409s, so the body is
  `{ error: { details: { code }, kind, message } }` and the documented top-level `error.code`
  (with its docs URL) is never set. Every client of those two conflicts must read
  `error.details.code`; the factory CLI does. Follow-up: fix in `@b4run/cli` as its own PR,
  after which the CLI can read either.
- **The registry has no owner record.** A second controller process against the same registry
  is an operator error nothing detects — SQLite's WAL permits it, and the single-writer claim
  rests on convention. Follow-up: a `controller_owner` row with a heartbeat, refused on open
  while another owner is live.
- **Rung 2's residuals stand**: candidate code runs in the oracle's container because the
  check imports the built artifact; the second-identity execution follow-up is still the fix.
- **`review` is red repo-wide** while the Anthropic credits are exhausted. Every PR in this
  rung will need a deliberate decision to land without the advisory review, as the last six
  did. The release process is being handled in a separate thread.
- **3a runs verification in the target's prepared image, not at the work order's pin.** The
  pin is recorded on the row and in the bundle; 3b honours it with per-pin images. Until then
  a work order created against a newer `origin/main` is verified in the environment the target
  was last prepared at, and the bundle says both.

---

## 10. Out of scope

Label-driven intake, the Workbench for approvals, per-thread permissions or policy, the
durable workflow primitive (§3 item 2), any delivery beyond local export, widening the
portable-path charset, and the second-identity execution follow-up.
