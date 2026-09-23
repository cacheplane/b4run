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
>
> **As landed (3b, half B, Task 6):** the builder's input is split in two. A per-process
> **target file** (`factory builder-target --target <id>`, read from `FACTORY_BUILDER_TARGET`
> at boot) carries the target's scope, image, sandbox policy and permissions, which the
> framework fixes per app; a per-work-order **manifest**
> (`<FACTORY_BUILDER_MANIFEST_DIR>/<workOrderId>.json`: `workOrderId`, `taskId`, `targetId`,
> `workspace`, no prompt) is written by `dispatch` into the target worker's manifest
> directory before it creates the thread, and the builder's resolver loads it by
> `metadata.factoryWorkOrderId`, refusing one whose `targetId` is not its own. One builder
> process per target; the prompt is the run's user message, and the route's system prompt is
> fixed.

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
>
> **As landed (3b, Task 6):** the sandbox lane is the controller's
> `builder.integration.test.ts`: one served builder process for `cli-flags`, two work
> orders' manifests (the second with one file more), two threads created with their own
> `factoryWorkOrderId`, each association's `intent.sourceDigest` equal to its manifest's and
> each listing showing its own workspace; a thread with no manifest, and one with another
> target's, refused by name at admission. The two end-to-end builder lanes dispatch through
> the controller to the served builder, so the thread is admitted with the manifest
> `dispatch` wrote.

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
`intake_invalid`, `oracle_did_not_fail`, `intake_attempts_exhausted`, `no_target_for_package`,
and `intake_run_failed` (the drafter turn ended without a draft or its stream was lost).
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

**As landed.** The CLI validates the issue number, reads the issue and resolves the pin
BEFORE the controller is asked, so a refused create spends no operation key. The fetch is a
plain `git fetch origin <branch>`, never `--depth=1`, which would turn the operator's full
clone (shared by every linked worktree) into a shallow one. `bodyDigest` is over the raw
body, so an edit is never hidden; only `issue.md` is normalised to LF, since a web-authored
GitHub body arrives CRLF. `issue.md`
is written only when absent, so a replayed key rewrites nothing and a crash between the row
insert and the write is repaired by the replay.

**As landed (sub-project 4).** `create --issue <n> --pin <sha>` replays an issue at a named
commit: `resolvePin` is skipped, so `origin/main` is neither fetched nor read. A full sha goes
through `ensurePin` (label `Issue <n>'s replay pin`): fetched from `origin` by sha when the
object store lacks it, refused by name under `FACTORY_NO_FETCH=1`. A short sha is accepted only
when the checkout resolves it (`git rev-parse --verify <sha>^{commit}`), since a short sha
cannot be fetched. `--pin` with `--task` is refused. The row and the journal record the pin like
any other; the origin is still the issue, with no field saying the pin was chosen.

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

**As landed (3a).** The drafter is the builder process's own route, `FACTORY_INTAKE_ROUTE`
(default `/intake#agent`), and its thread runs in the workspace of the catalog task
`FACTORY_INTAKE_TASK`, not in a wide capture: the drafter app, its image and the capture are
3b. The route is configurable and exercised only by the test fake; the builder app ships no
`/intake` route, so `factory intake` against the real builder ends `blocked
(intake_run_failed)` until 3b implements it. The draft omits `id` and `visible` — the controller fills the work order's id and a
`vitest` regression guard over the target's whole suite — and carries exactly one check file,
the one `checks.json` names. A generated task needs no `reference.patch` (optional in the
catalog now). Acceptance ids are the `A<n>:` lines of `spec.md`, and the independent check's
assertion names must start with those ids and be set-equal to them.

**As landed (3b, half A).** The drafter is its own app, `examples/software-factory/drafter/`
(`@b4-example/software-factory-drafter`), not a route on the builder: one `intake` agent
route, model from `FACTORY_DRAFTER_MODEL` (default `gpt-5-mini`), the four workspace tools
and nothing else. Its **image** is the plain `node:24-slim` base pinned by digest
(`drafter/src/drafter-image.ts`, the one copy CI pulls by grepping the literal), not a built
image: the drafter runs no build and no tests, so `targets/repo-readonly` as a prepared
target never existed. Its workspace is the **wide capture** staged by the controller
(`controller/src/lib/targets/wide-capture.ts`: root manifests, `packages/*` manifests,
READMEs, `src/**` and `test/**`, `scripts/**` minus the release fixtures and any path the
framework's capture would refuse; never `apps/`, `examples/` or `docs/`), read out of the git
object store at the work order's pin, captured with the framework's own capture and served
under `repo/` with **no baseline** and no environment links; `draft/` is not pre-created, the
drafter makes it. The capture reaches the drafter as a **manifest per work order**:
`intake` writes `<FACTORY_DRAFTER_MANIFEST_DIR>/<id>.json` (default
`<drafter app root>/.factory/manifests`) before it creates the thread with
`{ factoryWorkOrderId }`, the drafter's resolver (`sandbox.workspace` as a function of the
thread) loads and verifies it at first admission, and the controller removes it when the
work order leaves intake for good. **Permissions are non-interactive** with a short
allow-list of command starts (`ls`, `cat`, `head`, `tail`, `grep`, `wc`): nobody is watching
a drafter turn, so a command off the list is denied rather than parked. The controller reads
the thread **re-rooted at `draft/`** (`WorkspaceReadOptions.root`), which is what makes the
wide capture readable at all: `repo/` holds executables and more bytes than an inspection
admits, and is never walked. The controller's configuration is a **worker map**
(`FACTORY_WORKERS`, or the legacy `FACTORY_WORKER_URL` + `FACTORY_BUILDER_APP_ROOT` pair as
the `*` entry) plus the drafter pair (`FACTORY_DRAFTER_URL` + `FACTORY_DRAFTER_APP_ROOT`,
with `_ROUTE`, `_MANIFEST_DIR` and `_IMAGE` only beside them); `FACTORY_INTAKE_ROUTE` and
`FACTORY_INTAKE_TASK` are gone. Proof: the controller's `drafter-resolver.integration.test.ts` serves the drafter and admits two threads with
two captures through the resolver and refuses a third by name; the controller's
`drafter-end-to-end.integration.test.ts` runs one real drafter turn against the wide capture
and proves the oracle in the target's image. What half A does not do: the pin is captured
for the drafter but the oracle proof and verification still run in the target's prepared
image at the pin it was prepared from, and the builder still resolves one manifest per
process (§6.7, half B).

**As landed (3b, half B, Task 6).** The builder resolves its workspace per work order the
same way (§4.1's as-landed note): `dispatch` writes the manifest into
`workerFor(row).manifestDir` (a `FACTORY_WORKERS` entry's `manifestDir`, or
`FACTORY_BUILDER_MANIFEST_DIR` beside the legacy pair; default
`<appRoot>/.factory/manifests`) after the key is begun and before `createThread`, journals
`builder_manifest_written { path, sourceDigest }`, and refuses under the key with
`builder_manifest_failed` if it cannot. The prompt lookup, which is where the target's pin is
fetched into a shallow checkout, now runs before the key, so its refusal is unspent. The
manifest is removed (`builder_manifest_removed`, failures journalled and never fatal, outside
any transaction) when the row leaves `dispatched`/`running` for anything but a cancel, by a
settled cancel of a builder thread, and when thread creation fails or the thread is orphaned
(those two only while the row holds no thread or this command's own). The worker map has no
wildcard: the legacy pair is keyed by the target in `FACTORY_BUILDER_TARGET`, so a work order
no builder serves is refused before its key is spent.

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

   **As landed.** `Verifier.verify` gains `mode: "independentOnly"` (default `full`). In that
   mode a tamper is reported under check id `tamper` (full mode keeps `visible` and
   `independent`), so that only a genuine failing assertion under id `independent` proves an
   oracle. A build failure, a tamper or a deadline is `proven: false` with `checkId` naming
   the deciding check, and the proof refuses a receipt whose `candidateDigest` is not the
   baseline it asked for.
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

**As landed.** `approve-intake` recomputes the directory's digest at call time and its default
operation key carries that disk digest alongside the caller's, so a refusal over an edited
file does not replay to the call after the file is restored. The approved task is bound until
dispatch: `intake` refuses a `received` row that already holds a task digest, and `dispatch`
re-reads the directory and refuses a digest that no longer matches. The bundle also carries
`oracleReceiptId`, the receipt of the proof the approved draft was parked on (the journal's
last `oracle_receipt`), and `approve` compares the origin, the pin and the task on disk
against the frozen ones with the same `bundle_invalidated` refusal as the policy and the
baseline. `reject-intake` awaits the redraft it starts, so the caller sees where it settled.

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

> **As landed (3b, half B).** `target.json` records `images: Record<pin, Image>`; the 3a
> single `image` is read as `images[pin]` (a migration on read; the shipped manifests were
> rewritten and the prepare script writes only `images`). `pin` stays the target's DEFAULT
> pin. `loadTarget(id, { pin })` selects `images[pin]` BEFORE `ensurePin` (an unprepared pin
> is refused without a fetch) and returns a single-valued target (`pin` the chosen one,
> `image` its image), so `imageTag`, the archive and the providers did not change. No image at
> the pin is `ImageUnpreparedError` ("has no image prepared at <pin>: run pnpm --filter
> @b4-example/software-factory-controller target:prepare <id> --pin <pin>", one spelling,
> `prepareCommand`); a target with no image at all is its subclass `TargetUnpreparedError`
> ("has not been prepared"), and an unknown target is `UnknownTargetError`. `target:prepare <id> --pin
> <sha>` builds at that commit and keeps every other pin's entry; it first refuses, by path, a
> pin at which `root`, an `imageContext` entry or the `lockfile` does not exist
> (`git cat-file -e`). The generated `task.json` carries `pin` (key order `id, target, pin,
> allowedSourcePaths, immutablePaths`; the drafter may not write one: the draft schema omits
> it, strictly), so the task digest binds it and `loadTask` passes it to `loadTarget`: every
> lookup (policy, baseline, verifier, builder manifest) is at the work order's pin with no
> signature change; a shipped task carries no pin. A draft whose target has no image at the
> pin is refused `image_unprepared`, never retried; `preparedTargets(pin)` lists only the
> targets prepared at it. `environmentIdentity` folds the pin (`b4-factory-environment-v2`),
> so two pins with identical image inputs are two environments; bundles frozen before this
> change carry the v1 identity and no longer approve (examples; acceptable). `approve`
> asserts a generated task's frozen `pin` equals the policy's. `cli-flags`'s historical paths
> (the fixture under `server/`) cannot be re-pinned past the controller move, so `devkit` is
> the per-pin target. A builder has a pin: `factory builder-target --target <id> [--pin
> <sha>]` writes the image at that pin and records `pin` in the target file (both schema
> copies); the controller takes a worker's pin from that file (legacy pair) or the
> `FACTORY_WORKERS` entry's optional `pin` (default: the target's default pin). One builder
> serves one pin at a time. Before the key, `dispatch` compares the task's pin (a generated
> task's own, a catalog task's target default) with the WORKER's: the same pin needs nothing;
> different pins whose images agree on `lockfileSha256`, `baseManifestDigest` and
> `dockerfileSha256` proceed with `builder_environment_differs { builderPin, taskPin,
> lockfileDiffers, baseDiffers, dockerfileDiffers }`; anything else is refused unspent with
> the remedy (prepare at the task's pin, restart the builder from `builder-target --pin`, set
> the pin on its worker entry; or cancel). The controller's builder reader addresses the
> worker's pin image, the one the builder process runs. After `approve_intake` a `received`
> row still holds its intake thread, which no longer keeps a failed dispatch's builder
> manifest; a manifest a crashed or cancelled command never handed to a thread is removed by
> reconcile (`dispatch_incomplete`, an open `intake`) and by a cancel from `received`. Review fixes: the prepare script
> re-reads the manifest after the build, merges only `images[pin]`, formats through Biome's
> stdin and renames into place (`recordImage`, `storage/atomic-file.ts`); it checks every
> path the target names at the pin (capture entries, `commands.cwd` and `runnerConfig`
> under the root too); `FACTORY_TARGETS_DIR` redirects the catalog so a lane prepares a copy.
> `parseDraft` maps an unreadable manifest or an unfetchable pin to `intake_run_failed` (no
> attempt spent), `no_target_for_package` only to a missing target directory.

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
  is asked to write only under `draft/`, but `repo/` is not write-fenced: the permission gate
  allows every write inside a workspace, so the drafter can edit its copy of the repository.
  The boundary is the read, not the write: the controller reads the thread re-rooted at
  `draft/`, the network is denied, and the capture is that thread's own, so a write under
  `repo/` changes what the drafter sees and nothing else; and its output is never trusted
  without the steps in §6.5.
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
- **Intake threads are never swept (3a).** Each work order's drafter thread stays on the
  worker after the draft parks or the intake blocks; a redraft reuses it, nothing removes it.
  Follow-up: a sweep of the threads of terminal and approved work orders.
- **A drafter that parks on a gate is a failed run, and the gate stays parked (3a).** The
  intake turn rules block an interrupt as `intake_run_failed` and leave the prompt pending
  on the thread; only a `cancel` denies it (`denyPending`), and the drafter needs no gate
  today. Follow-up: deny on block, or a `denyPending` route, before a real drafter can ask.
- **The 3a inspection constraint** (resolved in 3b, half A). The drafter thread's workspace
  was read through `FACTORY_INTAKE_TASK`'s provider and inspection options, so the drafter
  could only run in exactly that builder's static workspace; the drafter app, its own
  provider and the re-rooted `draft/` read removed it.
- **The wide capture holds no `examples/`.** A target whose root is a fixture project under
  `examples/` (the shipped `cli-flags`) can be verified but not drafted from the capture: a
  drafter would find no source to read. The two real repository targets the program is
  about (`packages/*`) are in it; a fixture target is for the lanes.
- **3a ran verification in the target's prepared image, not at the work order's pin**
  (resolved in 3b, half B). The generated task carries the pin and every lookup is at it, in
  the image prepared at it (§6.7 as landed); a pin with no image blocks `image_unprepared`.
  A builder runs at one pin (its target file's, recorded on its worker entry); `dispatch`
  refuses a task whose pin's environment differs from the builder's and names the remedy
  (restart the builder at the task's pin), so one target serves one pin at a time.
  Remaining follow-ups: per-(target, pin) builders, the drafter thread sweep, and orphaned
  capture sources.
- **3a manifests are migrated on read.** A `target.json` with the single `image` is read as
  `images[pin]`. Remove the migration at rung 4, once no 3a manifest can remain.

---

## 10. Out of scope

Label-driven intake, the Workbench for approvals, per-thread permissions or policy, the
durable workflow primitive (§3 item 2), any delivery beyond local export, widening the
portable-path charset, and the second-identity execution follow-up.
