# Software factory

A work-order controller that owns both halves of the work: a bounded **builder** route that
edits files in a container, and a **controller** process that decides whether what the builder
left behind is worth exporting. It is a rung of the
[software factory program](../../docs/superpowers/specs/2026-09-16-software-factory-rfc.md),
and the shape it has now — the controller as a b4 app of `workflow` routes, the builder
driven by a manifest — is
[the rung 3 design](../../docs/superpowers/specs/2026-09-21-software-factory-rung3-design.md).
The history is in the earlier specs: [rung 2](../../docs/superpowers/specs/2026-09-19-software-factory-rung2-design.md)
(targets and tasks), [rung 1](../../docs/superpowers/specs/2026-09-18-software-factory-rung1-design.md)
(the controller owning the verdict), and
[rung 0](../../docs/superpowers/specs/2026-09-16-software-factory-rung0-design.md).

Rung 0 asked the worker whether it had succeeded. Rung 1 stops asking.

## Packages

This example is three b4 apps that share no source:

- **`controller/`** (`@b4-example/software-factory-controller`) — the controller *as a b4 app*.
  Its mutating commands are `workflow` routes: `/work-orders/create#workflow`,
  `/work-orders/dispatch#workflow`, `/work-orders/retry#workflow`, `/work-orders/approve#workflow`,
  `/work-orders/deny#workflow`, `/work-orders/cancel#workflow` and `/reconcile#workflow`.
  It holds the task and target catalog (`targets/`, `tasks/`, `fixtures/`,
  `scripts/prepare-target.ts`), the registry, the verifier, the workspace reader, every test,
  and the `factory` CLI.
- **`server/`** (`@b4-example/software-factory-server`) — the builder: one bounded route that
  edits files in a container, and nothing else. One builder process serves every target at
  every pin. Its permissions are non-interactive: a command off a thread's list (from its work
  order's manifest: the target's build and test invocations, `node `, and the drafter's
  read-only `ls`, `cat`, `head`, `tail`, `grep`, `wc`, `sed -n`, `nl`) is a tool error the model
  reads, never a prompt parked for a person nobody assigned.
- **`drafter/`** (`@b4-example/software-factory-drafter`) — the drafter: one `intake` agent
  route with the four built-in workspace tools, run on the plain `node:24-slim` base image
  pinned by digest, with the network denied and permissions non-interactive. It reads a wide
  read-only capture of the repository and writes a task under `draft/`; it repairs nothing.

**The boundary.** Neither worker imports controller code. What crosses between them is a
**manifest**: a JSON file the controller writes, one per **work order**. The builder's is
`<FACTORY_BUILDER_MANIFEST_DIR>/<workOrderId>.json`, written by `dispatch` into the builder's
manifest directory before it creates the builder thread with `{ factoryWorkOrderId }`. It
names the thread's whole sandbox: the captured workspace, and the task's target (the image
prepared at the task's pin, that pin, the sandbox policy and the permission allow-list). The
builder's `sandbox.thread` resolver loads it when the thread's first run is admitted, refuses
it by name if it is missing or malformed, verifies the workspace and hands all four to the
framework, which records them with the thread and never asks again. It carries no prompt: the
task's instructions are the run's user message. So one builder process serves every target
at every pin, and boots with no target file. Its real `b4 check` runs the Docker provider's
preflight, which is why its `build` and `check` scripts run behind `scripts/in-lane.mjs` and
skip with a notice unless `FACTORY_BUILDER_LANE=1`: the repository-wide `build` has no Docker
in hand, and the real build is the one the Docker lane runs.
The drafter's manifest is per work order too: `intake` writes
`<FACTORY_DRAFTER_MANIFEST_DIR>/<workOrderId>.json` before it creates the drafter thread, the
thread is created with `{ factoryWorkOrderId }`, and the drafter's resolver loads that file
when the thread's first run is admitted. The drafter's `b4.config.ts` needs only the
directory (`FACTORY_DRAFTER_MANIFEST_DIR`), which may be empty at boot, so its `check` and
`build` run everywhere and refusal happens per thread, by name.

## What it proves

Read "What is joined, and what is not" below before treating any of this as end-to-end: the
controller really does read a thread's workspace and turn those bytes into a verdict, a
bundle and an export, but the bytes in that lane are not yet the *builder's* own.

- **The controller owns the verdict.** It captures the baseline itself, reads the builder's
  workspace itself, diffs and digests the candidate itself, runs the checks in *its own*
  containers with a separate sandbox scope and freshly captured workspaces, and issues its own
  receipt. The builder has no channel for a verdict: no gate, no interrupt, no receipt tool.
  Prose claiming success is just prose.
- **Each suite is graded in its own container.** Verification is two sessions, not one: the
  visible suite and the independent check each get their own capture, their own container and
  their own build, and nothing crosses between them but the candidate's bytes. The candidate's
  source is imported by the visible suite, so it gets to run code in that container — and a
  detached process it leaves behind cannot touch the oracle, because the oracle runs somewhere
  else. This is the RFC's own recommendation: put the oracle in a separate trusted process.
  It is the visible suite's *test code* that is absent from the second container, not candidate
  code as such: the independent check imports the built artifact, which re-exports the
  candidate's source, so candidate code runs there too — bounded by that session's own
  before-and-after snapshot.
- **The independent checks are structurally out of reach.** They are a sibling of the
  captured `project/` directory, so they are absent from the builder's workspace rather than
  merely excluded from it, and only the session that grades them ever holds a copy — written
  from the controller's own copy, into a container the visible suite never ran in. A candidate
  that passes the visible suite and fails the independent checks cannot reach
  `awaiting_approval`.
- **A candidate cannot repair itself by editing its tests.** Each session snapshots the
  workspace before and after its suite; any persistent change the suite made is a rejection.
- **Approval binds a frozen bundle, not a digest.** The bundle fixes the work order, the
  repository, the baseline, the specification, the policy, the verifier's environment
  identity, the candidate digest, the check evidence, and the destination. Its digest is what
  `approve` takes. Change the policy or the environment and consent is invalidated **even
  when the candidate bytes are byte-identical**, because the thing consented to was the whole
  claim, not the diff.
- **The lifecycle is closed and recorded.** A closed state machine, an append-only event
  journal and a two-phase command log keyed by operation key live in `registry.sqlite`.
  Retrying a command returns the recorded outcome instead of repeating the effect. Candidate
  bytes and check output are content-addressed under `artifacts/`.
- **"We do not know" is a distinct answer.** An unreadable baseline, an unreadable workspace
  or a harness that could not run settles as `verification_inconclusive`, which blocks
  advancement and is never confused with `verification_failed`.
- **Restart never re-dispatches and never resumes a verdict.** A work order interrupted in
  `verifying` is re-verified from the controller's own baseline, because verification has no
  durable external effect until an approval is bound to a frozen bundle. `awaiting_approval`
  needs no reconciliation rule at all: the frozen bundle is already in the registry.
- **Only the approved bytes leave.** The export is named by the bundle digest and published
  with `link`, so a retry lands on the same name with the same content and a second delivery
  is impossible.

**Targets and tasks.** A *target* is an environment: a commit pin, the repository subtree the
workspace is captured from, that capture's inventory, the prepared image its dependencies live
in, and the build and test commands to run. It lives under `targets/<id>/`. A *task* is one
repair inside a target: a spec with named acceptance ids, the defect and reference patches,
and the visible and independent checks. It lives under `tasks/<id>/`. Adding either is a
directory and a prepared image, not a code change; the design is in
[the rung 2 spec](../../docs/superpowers/specs/2026-09-19-software-factory-rung2-design.md).
A target's `resources.verifierDeadlineMs` bounds one verification, and a work order's active
budget (`FACTORY_MAX_ACTIVE_MS`, fixed on the row when it is created) covers everything active
the work order does: the intake (drafter turns and oracle proofs), and each candidate attempt's
builder turn and verification. Every `dispatch` and `retry` checks what is LEFT of it: a
remainder below twice the target's verifier deadline (a verification, and as long again for the
turn) is journalled (`budget_below_verifier_deadline`, also at `create` for a fresh row) and
refused before a thread is spent. So size the budget as the intake plus
`FACTORY_MAX_CANDIDATE_ATTEMPTS` × 2 × `verifierDeadlineMs`. The `cli` target verifies for up to
an hour (3,600,000 ms), and the first live run's intake spent about 36 minutes over three
drafter attempts, so with the default two candidate attempts its work orders need
`FACTORY_MAX_ACTIVE_MS=18000000` (an hour of intake plus 2 × 2 × one hour) set on the controller
before `create`. The approval's re-verification is not charged: it runs while the row waits in
`awaiting_approval`, which is not active time.
A target may carry `draftingNotes`: at most ten one-line facts about its own code that a
drafter needs to write a check (how a fixture route exports its entry, how a run names its
route, which helper the package's own tests drive it with). The intake prompt lists them under
the target's line. They are facts true at the target's pin, never a solution, and they are not
an image input: editing them changes no image tag or environment identity and needs no
`target:prepare`. The `cli` target's notes are how attempt 4's check could have reached the
behaviour instead of failing route discovery with `B4_E1007`.

## What it does not do

No repair loop, no token budgets, no live model producing a repair, no UI, and one export
target (the local filesystem). Verification proves a focused repair policy, not arbitrary
program correctness, and the receipt says so.

**No authorization.** The controller is an HTTP app whose routes mutate the registry, and
anyone who can reach its port can create, dispatch, approve and cancel work orders; there is
no authentication and no per-caller check, which this rung scopes out. Run it on loopback and
do not expose it. And note where the trust now sits on the builder's side: whoever can write
into the builder's manifest directory chooses a thread's workspace, image, policy and
permissions, within the builder's own bounds, which no manifest can move: the network is
denied (a thread may not open what the app denies), and the permissions mode is
`non-interactive`. The image bound is narrower than "an image the factory prepared": a
manifest may name only a tag in the factory's shape (`b4-factory-<target>:<pin[:12]>-<12 hex>`,
`dockerSandbox({ images })`) whose target and pin segments are the manifest's own `targetId`
and `pin` (the manifest schema refuses any other at admission), and only an image present on
the daemon under that tag runs. Nothing proves that image is the one `target:prepare` built:
whoever can tag an image on the builder's Docker daemon can put anything behind the tag, but
that access is already root on the host, so it adds no power a manifest writer lacks. That includes the WHOLE allow-list: `permissions` is a record keyed by any
tool name, so a manifest's writer also decides the `tool` and `subagent` keys (which tools run
without approval and which subagents may be dispatched), not only `bash` and the path keys;
the builder's `non-interactive` mode means anything off that list is refused, never asked
about. Each thread's choice is recorded at its first admission and never re-resolved. That
is a stronger control point than the catalog key it replaced — a key only selected among the
target definitions in the repository, while a manifest states them outright.

**The pin is honoured, one image per pin.** The wide capture the drafter reads is taken at
the work order's pin, out of the object store; the generated `task.json` carries that pin, so
the target, the baseline, the oracle proof and the verification are all looked up at it, in the
image prepared AT that pin. A target records one image per pin it was prepared at (`images`
in `target.json`); a shipped task carries no pin and runs at its target's default `pin`. A draft
whose target has no image at the work order's pin blocks at once (`image_unprepared`, naming
the `pnpm --filter @b4-example/software-factory-controller target:prepare <id> --pin <pin>` an operator runs); no redraft can mend it. The
builder runs each task in the same image the verifier does: the work order's manifest names
the image prepared at the task's pin, so one builder runs several pins of one target at once,
each thread in its own. And intake threads accumulate on
the drafter, one per work order, since nothing sweeps a parked or blocked work order's drafter
thread yet.

**Upgrading to one builder.** Drain the builder first: let every work order in `dispatched`
or `running` settle, or `cancel` it, before stopping the per-target builders and starting the
one builder. A work order caught mid-flight fails closed, but it spends a candidate attempt:
`reconcile` finds its thread gone from the new builder and ends the attempt
`ended_without_candidate`; a verification of it cannot read the workspace
(`workspace_unreadable`, settling `verification_inconclusive`); a version 1 manifest still in
the manifest directory is refused at admission; and a thread the old builder admitted before
the app resolved sandboxes per thread, if its installation store comes along, is refused as
`conflict` (it has no per-thread record). `retry` the work order once the new builder runs,
attempts permitting.

**Upgrading across per-pin images.** The environment identity now digests the pin with the
image, so every identity changed. A bundle frozen before the upgrade and still awaiting review
refuses at `approve` ("Verification policy changed since the bundle was frozen; freeze a new
bundle"): deny it, and a new work order verifies and freezes under the new identity.

**`examples/code-fixer` is untouched by this rung.** The factory borrows its fixture image and
nothing else; rung 0 drove code-fixer as its worker, and rung 1 does not.

## What is joined, and what is not

The controller reads a builder thread's workspace through the framework's managed-workspace
read surface: `withManagedWorkspaceReader` from `@b4run/cli/workspace`, over
`ManagedWorkspaceProvider.openWorkspaceReader`. The builder's `b4.config.ts` gives it a
workspace *definition*, which makes its threads **managed workspaces**: their bytes live in a
volume named by the builder's installation and operation ids, not by the thread id, so the
reader first resolves the thread through the builder's own installation store under its app
root (read-only, without taking the builder's owner lock) and then opens that record's volume
read-only in a separate, networkless container. `controller/src/lib/worker/workspace-reader.ts` is that
join; the builder's own session is never acquired, started, stopped or replaced, and the
reader carries no exec backend and no write operation, so a mutation cannot be expressed.

- **Joined, and proven in `controller/test/end-to-end.integration.test.ts` (Docker-gated).** A real
  builder turn — the route, its tools, its permission config and its container, with only the
  model scripted — writes the repair into the builder's managed workspace. The controller
  then reads that workspace for itself while the builder sits idle between turns, diffs it
  against the baseline it captured itself, assembles and digests, verifies in its own
  container with its own copy of the independent checks, freezes a bundle, approves and
  exports under the bundle's own name. The builder's next turn still sees its own repair,
  which is the non-disturbance claim, measured. The two structural inspection options are
  exercised against real Docker in that lane rather than merely passed: the git baseline is
  excluded (while `.gitignore` survives) and the `node_modules` environment link is validated
  against its exact target instead of walked into.
- **Addressing, not authorization.** The controller needs the builder's app root as well as
  a provider of the same kind and scope; the image is in the thread's record, so the reader's
  provider has no default image and serves every target. Naming a thread id is not a claim of
  ownership; the process holding those two things is the boundary. In this example the builder
  is the sibling `server` package, which is what `FACTORY_BUILDER_APP_ROOT` names.
- **What rests on a fake elsewhere.** Layer 1 scripts the worker, the reader and the
  verifier. The end-to-end lanes dispatch through the controller to the real builder, served
  in-process, and script only its model; the builder-side test scripts the model,
  as layer 2 does; the route, tools, permission config and container there are real.
- **What the inspection options are.** They are not cosmetic: `WorkspaceInspectionOptions`
  supplies `excludeRootDirectories` and `expectedRootSymlinks` for every read, derived from
  the target rather than restated, plus the builder's own `runAsNonRoot` identity so the
  reader can read what the builder wrote. A reader without them throws on the
  dependency symlink or reports the git directory as added paths — a `scope_violation` on
  every run. `ignorePrefixes` is the target's `snapshotIgnore`: a builder that runs the
  target's build writes there legitimately, and those paths are dropped rather than reported
  as added. The verifier's tamper comparison does not share that exclusion — it compares the
  whole workspace, because each session's build finishes before that session's first snapshot
  and the independent oracle reads the build output.

**What the port rests on.** The controller is a b4 app, so it inherits the runtime's rules
rather than inventing its own. There is one run at a time per thread, and **a work order's id
is its controller thread id**: that is what serialises two commands on the same work order
(the second is refused with `run_in_flight`) while commands on different work orders run
concurrently. A `workflow` route holds its HTTP request open until it returns, so `dispatch`
*awaits* — it creates the builder thread, observes the turn, verifies, and answers only when
the work order has stopped moving; a client that disconnects does not stop it, and reconnects
by reading the registry with `show`. Cancelling a live dispatch is the runtime's own cancel,
which aborts that route's signal. And the app has no boot hook, so reconcile is a route:
nothing walks the registry after a restart unless an operator or a supervisor asks it to.

## Run it

The builder and the verifier both run in the target's prepared image, so this needs Docker:

    pnpm --filter @b4-example/software-factory-controller target:prepare cli-flags
    # builds b4-factory-cli-flags:<pin>-<dockerfile sha>, recorded as images[<pin>]

`pnpm --filter @b4-example/software-factory-controller target:prepare <id> --pin <sha>` prepares the same target at another commit and records that image beside
the others (an issue work order is pinned to `origin/main`, so a target is prepared at the pin
its work orders name). The manifest is re-read after the build and only that pin's entry is
merged, then renamed into place, so two prepares do not lose each other's entry and a running
controller never reads a half-written file. `FACTORY_TARGETS_DIR` points the script and the
catalog at another targets directory. The script refuses a pin at which any path the target
names (root, build context, lockfile, capture entries, command directory, runner
configuration) does not exist, naming the path: `cli-flags`'s fixture lived
under the server before the controller split, so it can only be prepared at its historical
pin, and `devkit` is the target that is re-pinned.

**1. Start the builder** (terminal 1), told where the controller will leave its manifests. It
needs no target file, no per-target copy and no second process. The manifest directories live
under the controller's state directory, created readable and writable by you alone: whoever
can write a manifest chooses a thread's workspace, image, policy and permissions (see "No
authorization" above), so a world-writable `/tmp` directory is the wrong home for one:

    (umask 077 && mkdir -p .factory/builder-manifests .factory/drafter-manifests)
    FACTORY_BUILDER_MANIFEST_DIR=$PWD/.factory/builder-manifests \
    OPENAI_API_KEY=... \
      pnpm --filter @b4-example/software-factory-server dev --port 4100

One builder serves every target and pin. Each work order's manifest names the image its task
is verified in, the sandbox policy and the permission allow-list; the builder records them at
the thread's first admission and runs that thread in them, and only an image the factory
prepared (`b4-factory-…`) can be named. Prepare every target (and pin) you will dispatch
(`target:prepare <id> [--pin <sha>]`) before its work orders reach the builder: the manifest
names an image, it does not build one. An upgraded controller's allow-list reaches the next
work order at once, because it travels in that work order's manifest; a thread already
admitted keeps the list it was admitted with.

Do not set `B4_PERMISSIONS_MODE` in this process: it would override the builder app's
`non-interactive` mode, and a builder that parks on a permission prompt blocks its work order
as `unexpected_interrupt`, spending a candidate attempt on a question nobody answers.

**2. Start the drafter** (terminal 2), told where the controller will leave its manifests.
It reads the repository through the capture in each manifest, never through the filesystem,
so it needs no repository path:

    FACTORY_DRAFTER_MANIFEST_DIR=$PWD/.factory/drafter-manifests \
    OPENAI_API_KEY=... \
      pnpm --filter @b4-example/software-factory-drafter dev --port 4200

`FACTORY_DRAFTER_MODEL` (default `gpt-5-mini`) picks the model. Do not set
`B4_PERMISSIONS_MODE` in this process: it would override the app's `non-interactive` mode,
and a drafter that parks on a permission prompt is a turn nobody answers.

**3. Start the controller** (terminal 3). It needs the builder pair — the builder's URL and
its *app root*, the package whose installation store the controller reads a builder thread's
workspace from — with `FACTORY_BUILDER_MANIFEST_DIR` (the directory the builder was started
with), its own state directory, and the drafter pair: the drafter's URL and its app root:

    FACTORY_WORKER_URL=http://127.0.0.1:4100 \
    FACTORY_BUILDER_APP_ROOT=$PWD/examples/software-factory/server \
    FACTORY_BUILDER_MANIFEST_DIR=$PWD/.factory/builder-manifests \
    FACTORY_DRAFTER_URL=http://127.0.0.1:4200 \
    FACTORY_DRAFTER_APP_ROOT=$PWD/examples/software-factory/drafter \
    FACTORY_DRAFTER_MANIFEST_DIR=$PWD/.factory/drafter-manifests \
    FACTORY_STATE_DIR=$PWD/.factory \
      pnpm --filter @b4-example/software-factory-controller dev --port 4300

Every target's work orders go to that one builder. `FACTORY_WORKERS` (the per-target worker
map) and `FACTORY_BUILDER_TARGET` (the per-process target file) are retired: the controller
refuses to start while either is set, naming it, rather than leave an operator believing it
still routes anything. The builder and the drafter each need their own app root, and the
controller refuses one shared between them. Each manifest directory must be the same on both
sides. Left unset, the builder's side still agrees by default: the controller's
`FACTORY_BUILDER_MANIFEST_DIR` defaults to `<FACTORY_BUILDER_APP_ROOT>/.factory/manifests`,
and the builder's `dev`, `check` and `build` scripts default theirs to `.factory/manifests`
under the same package, which is not world-writable either. The drafter has no such default
of its own, so its directory is always set on both sides. The controller creates each manifest directory at boot; `dispatch` writes
the work order's manifest there before it creates the thread, and removes it once the row
leaves `dispatched`/`running` (the resolver reads it once, at the thread's first admission;
verification reads the workspace through the reader) or a cancel has settled the thread. Without the
drafter pair the controller starts and every command works except `intake`, which refuses
before spending anything. The controller keeps every file it writes at run time under
`FACTORY_STATE_DIR` (the registry, evidence, generated tasks, and the captures it stages
under `captures/` and `verifiers/`), so its own package directory stays read-only while it
runs and `b4 dev` never restarts it mid-command.

**4. Drive it** (terminal 4). Every command above and below runs from the repository root.
The CLI's write commands are requests to the running controller
(`FACTORY_CONTROLLER_URL`); its read commands never touch the controller at all — they open
`<FACTORY_STATE_DIR>/registry.sqlite` read-only. So both variables are set:

    export FACTORY_CONTROLLER_URL=http://127.0.0.1:4300
    export FACTORY_STATE_DIR=$PWD/.factory
    alias factory='pnpm --filter @b4-example/software-factory-controller factory'

    factory create --task cli-flags
    factory create --issue 778 [--repo owner/name]         # from a GitHub issue, pinned to origin/main
    factory create --issue 714 --pin <sha>                 # replay a fixed issue at the commit before its fix
    factory intake <id>                                    # issue work orders only; awaits the draft
    factory review <id>                                    # shows the draft and its proof; type the digest's first 8 hex digits
    factory review <id> --reject --note "..."              # or send the draft back with a note
    factory dispatch <id>                                  # awaits; journal events on stderr
    factory retry <id>                                     # a candidate failure, attempts permitting; then dispatch again
    factory show <id>
    factory events <id>
    factory evidence <id>
    factory list
    factory review <id>                                    # diffs the candidate against the pin, shows receipt and bundle; type its first 8 hex digits
    factory review <id> --reject --note "..."              # or deny it
    factory cancel <id>
    factory reconcile

**Reviewing.** `factory review <id>` is how a person approves. For a draft parked in
`awaiting_intake_approval` it prints every file of the generated task (`issue.md`, `spec.md`,
`task.json`, `checks.json` and the check file) and the oracle proof's receipt with its check
output; for a bundle parked in `awaiting_approval` it prints a unified diff of each changed
file against the work order's pin, the receipt with its check output, and the frozen bundle.
The pin's files come from the object store `create` uses (`FACTORY_REPO_ROOT`, else this
checkout; a missing pin is fetched as the catalog does, unless `FACTORY_NO_FETCH=1`). When the
pin cannot be read the file is shown whole, with a line saying why. The diff is only the
display: it is of the candidate bytes the bundle covers, and the digest is the bundle's.
Each file is read once, and the digest is computed from the bytes that were printed: the task
digest over the task files, the bundle digest over the bundle payload. Every line of file
content is shown behind a `│ ` gutter, runs of more than three blank lines are collapsed into
one line saying how many, and characters a terminal would act on or not show (controls,
escapes, bidirectional overrides, zero-width characters, a byte order mark, line separators,
tag characters) are shown as `\u{…}` escapes, in titles too: no file, the third-party issue
included, can fake a title, a digest line or hide a line. If the digest is not the row's, or a
piece of evidence does not hash to its name, review refuses and sends nothing. It also refuses
when evidence it should show is not in the artifact store (the oracle proof's output for a
draft, the receipt's check output for a bundle), so a person cannot approve evidence they were
not shown; `--allow-missing-evidence` approves anyway, with a loud warning (nothing in a receipt reliably marks a verifier that never writes its output, so this
is a flag rather than a guess). At a terminal it then asks for the digest: at least its first
eight hex digits, or all of it pasted, case-insensitive; anything else sends nothing. The display is on stderr, the outcome
JSON on stdout. Without a terminal, `factory review <id> --approve --digest <sha256>` must name
the displayed digest in full (`--digest` without `--approve` is refused). `--reject --note "..."` is `reject-intake` for a draft and `deny`
for a bundle (the deny route records no note, so it is only echoed in the output). Any other
state is refused as having nothing to review. Underneath, `approve-intake <id> --revision <n>
--digest <sha256>`, `reject-intake`, `approve <id> --revision <n> --bundle <sha256>` and `deny`
remain the scripting contract, unchanged, and the routes still check at call time: a task file
edited after review displayed it is refused by `approve-intake`, which recomputes the digest
from disk.

`--pin` is the replay mode: a fixed issue, pinned at the commit before its fix, has a known
right answer, so the fix's own test grades what the factory produces without the drafter or the
builder being able to see it.

**The model key.** `OPENAI_API_KEY` must be in the environment of the builder and drafter
processes (steps 1 and 2), not the controller's or this terminal's. Both boot without it and
fail only at their first model call, as a failed turn. To load the one variable from the
repository's gitignored `.env` without printing it, in a way every shell runs (bash process
substitution, `source <(...)`, is silently ignored by macOS's bash 3.2):

    export OPENAI_API_KEY="$(sed -n 's/^OPENAI_API_KEY=//p' .env)"

**After a restart.** The controller reconciles on its first request, not when the process
starts (b4 has no boot hook), so after restarting it run `factory reconcile` before anything
else. A work order interrupted mid-intake is reconciled then: a drafter thread that is idle,
or that the restarted drafter still calls `busy` with no run behind it (a reattach answers
`live: false`; the runtime persists `busy` across a crash), has its turn treated as ended, and
its `draft/` is read and proved like any other: a missing or partial draft is refused and
spends an attempt. A builder thread in the same state is judged as a turn that ended.

**Long waits.** `dispatch`, `intake`, `reject-intake` and `approve` hold one HTTP request open
for the whole run, and Node's fetch gives up waiting for response headers after 300 seconds
while the work goes on in the controller. When the request ends that way (or the connection
drops), the command says so on stderr and follows the row in the registry until it leaves its
active state, for up to the row's active budget plus 10 minutes, then prints the row with the
same exit codes. `approve` re-verifies with the row still `awaiting_approval` at its revision
(about 20 minutes on the `cli` target), so it is followed by its journal instead: the
`approve_started` line says the request arrived, `approve_refused` ends it as a refusal, and it
exits 0 only when the row reads `exported`. Do not repeat a timed-out `approve`: the repeat is
refused `run_in_flight` while the first still runs. `FACTORY_STATE_DIR` must be set for that
fallback.

`dispatch` returns when the work order has stopped moving — including through the controller's
own `verifying` phase, which is not the builder's — and tails the journal to stderr while it
waits. If it reaches `awaiting_approval`, `factory review <id>` it (or approve with the
revision and the **bundle digest** it printed, or `deny`). `factory evidence <id>` prints the frozen candidate, receipt and
bundle: what an approver is actually being asked to consent to. `factory cancel <id>` uses
both variables: it interrupts a live dispatch through the runtime, falls back to the `cancel`
route for a work order that is not mid-run, and reads the row back.

**Intake.** A work order created with `--issue` has no task yet: `factory intake <id>` runs a
drafter turn on the drafter process and waits for it, as `dispatch` does. Before the thread
exists the controller stages the **wide capture** of the repository at the work order's pin,
out of the git object store: the root manifests (`package.json`, `pnpm-workspace.yaml`,
`pnpm-lock.yaml`, `turbo.json`, `biome.json`, `.npmrc`, `tsconfig*.json`), every
`packages/*/package.json`, `tsconfig*.json` and `README.md`, every `packages/*/src/**` and
`packages/*/test/**`, and `scripts/**` minus `scripts/release/test/fixtures/**` and any path
the framework's capture would refuse; nothing under `apps/`, `examples/` or `docs/`, no
`node_modules`, no `.git`. It is captured with the
framework's own capture, written as the work order's manifest, and served to the drafter
thread under `repo/`, with no baseline and no environment links. The drafter must write
exactly four files under `draft/` beside it — `task.json` (the target, the allowed and
immutable paths), `spec.md` (the repair, with acceptance criteria as `A<n>:` lines),
`checks.json` (the independent suite) and the one check file it names — and repairs nothing.
`repo/` is **not write-fenced**: the permission gate allows every write inside a workspace,
and the drafter could edit its copy of the repository. That is safe because nothing reads
the copy back — the controller reads the thread **re-rooted at `draft/`** (a read of a
different root, not a filter over the whole tree), the network is denied, and the capture
is the thread's own; a write under `repo/` changes what the drafter sees and nothing else.
The drafter's `immutablePaths` need not restate the target's runner configuration: the
controller fills it in after the drafter's own entries, as it fills the id and the pin, and
refuses only a draft whose allowed paths reach it (every such path named in one refusal).
The manifest lives until the work order leaves intake for good (a block, an approval, a
settled cancel): a redraft reuses the admitted thread and needs no manifest, and one is
some 20 MiB on this repository, so it is removed rather than kept. The controller validates
the draft, reads its check statically (a **pre-check**, in milliseconds, before any container:
the check must parse (skipped for a target whose checks run under a loader), import `test` or
`it` from `node:test` at run time (not `import type`), load the build only through
`join(process.cwd(), "packages/<name>/dist/...")` (or a variable holding `process.cwd()`), import
neither the package under repair by name nor an absolute `/workspace/` path, use no relative
specifier reaching outside `checks/`, and name top-level tests with exactly the `A<n>` ids
`checks.json` lists; comments, assertion messages and a spawned argv are not read as imports; a draft
that breaks any of these is refused as `intake_invalid`, every broken rule named with its line,
and spends an attempt), fits it to a prepared target, materialises it as a task directory under
`<FACTORY_STATE_DIR>/tasks/<id>/` (the four files plus `issue.md`), and then **proves the
oracle**: it runs only the drafted check, with no candidate changes, against the unpatched
baseline in the target's image, and the check must FAIL there, by a named `A<n>` assertion
failing by assertion (`ERR_ASSERTION`). A check that passes on the defect would pass on
anything, and one that cannot load (a wrong import, a syntax error) or fails only by a throw
or in a test it does not name proves nothing (`inconclusive`), so either draft is refused. The
refusal quotes each failure: which test, its error code and the first line of its message
(`A1 failed with B4_E1007 ("Route entry ... has no recognisable export (found: default)."), not
an assertion failure: ...`), or the first error line of a check file that failed to load. An
invalid draft or one that is not
an oracle starts another drafter turn on the same thread with the refusal quoted; the
attempts default to 2 (`FACTORY_MAX_INTAKE_ATTEMPTS`, fixed on the row at create), and the
last refusal blocks the work order. A blocked intake's generated task stays on disk beside the
kept refused copy; it is inert, since only an approval by digest puts a task in front of a
builder. A draft naming a package
with no prepared target blocks immediately (`no_target_for_package`), since no redraft can
prepare one, and so does a draft whose target has no image at the work order's pin
(`image_unprepared`: the prompt lists only the targets prepared at that pin, and the task's
`pin` is the controller's to fill, never the draft's). A draft that parks in
`awaiting_intake_approval` is read and approved **by digest**: `factory review <id>` prints the
task directory and digests what it printed, refusing if that is not the row's `taskDigest`, and
`approve-intake` recomputes the directory's digest at call time and refuses if either differs,
so what the person read is what the builder and the verifier are given.
`review --reject --note` (or `reject-intake --note`) journals the note and, attempts
permitting, waits for the redraft.
A refusal `intake` records under its operation key (the thread could not be created, the
manifest could not be written) is replayed to every later call at the same revision: retry
with `--key <fresh>`. A pin the repository does not hold and cannot fetch is refused before
the key is spent, so that call simply works once the pin is reachable.
Unlike `awaiting_approval`, `awaiting_intake_approval` has no expiry: the draft waits as long
as it takes, and waiting on a person is not active time.
A new work order for an issue that earlier work orders drafted carries their `reject-intake`
notes into its first drafter prompt, newest first (at most four, 1,500 characters each), as
"Maintainer decisions from earlier reviews of this issue": a decision about the issue outlives
the work order it was written on.
The review bundle later freezes the origin (issue and body digest), the pin, the approved task
digest and the oracle receipt id, so approving the export consents to all of them together.
A bundle frozen before these fields existed no longer parses, and there is no re-freeze from
`awaiting_approval`: a work order parked there across this change must be `deny`-ed and
created again.

**Retrying a candidate.** A work order blocked by a candidate failure (`unexpected_interrupt`,
`scope_violation`, `encoding_violation`, `candidate_rejected`, `verification_failed`,
`verification_inconclusive`) can be retried while it has candidate attempts left
(`FACTORY_MAX_CANDIDATE_ATTEMPTS`, default 2, fixed on the row at create; each committed
`dispatch` spends one, counted as `candidateAttempts`). `factory retry <id>` denies any prompt
still parked on the old builder thread, cancels whatever run is left on it, journals
`retry { attempt, previousBlockedReason }`, and returns the row to `received` with its thread,
interrupt, candidate, bundle and reason cleared; it does not dispatch. `factory dispatch <id>`
then writes a fresh manifest and starts a fresh builder thread from the same approved task (the
task digest is re-checked, as on any dispatch). The active-time budget is the work order's and
is not reset: `retry`, and any `dispatch` after the first, refuse before the key when what is
left (`FACTORY_MAX_ACTIVE_MS` at create, less the active time already spent, intake included)
is under twice the target's verifier deadline, naming the shortfall; the remedy is a new work
order created under a larger `FACTORY_MAX_ACTIVE_MS`. A `retry --key` whose key already holds
an outcome replays it. Every other block (an intake refusal, an exhausted budget, an unconfirmed export)
is refused, and so is a retry with no attempts left: cancel it and create a new work order. A
row created before the counter existed has it backfilled from its committed dispatches.

**The elision guard.** Before a candidate is verified, the controller refuses one whose changed
file carries an elision placeholder the baseline did not (`... (file truncated` anywhere; a line
that is nothing but a placeholder such as `// rest of the file unchanged` or `(unchanged)`) or,
from 1 KiB up, shrank below half its baseline. The work order blocks as
`candidate_rejected` in seconds, with the file and line journalled on the `assembly_rejected`
transition, instead of after a full verification; it is retryable.

**Exit codes.** A refused command and a runtime conflict (a second command while one is in
flight, a cancelled dispatch) both exit 1 with the body printed; everything else that
succeeded exits 0. A `dispatch` exits 0 only when the work order settles in
`awaiting_approval` or `exported` — `blocked`, `failed`, `cancelled`, `denied`,
`cancel_requested` and "did not settle" all exit 1, so a script cannot mistake an unfinished
work order for a shipped one. Likewise `intake` and `reject-intake` exit 0 only when the work
order settles in `awaiting_intake_approval` (a `blocked` draft, a cancel, and "did not settle"
exit 1), and `approve-intake` exits 0 only when the approval was accepted. `review` exits 1
when it refuses (nothing to review, a digest that is not the row's, a wrong prefix or
`--digest`, no terminal and no `--digest`) and otherwise with the exit code of the command it
sent.

### Environment

The controller app reads:

| Variable | Required | Meaning |
|---|---|---|
| `FACTORY_WORKER_URL` | yes | The builder's Agent Protocol base URL, `http(s)` only: the one builder, for every target and pin |
| `FACTORY_BUILDER_APP_ROOT` | yes | The BUILDER package's root, so the workspace reader can address its installation store |
| `FACTORY_WORKER_ROUTE` | no | Default `/build#agent` |
| `FACTORY_BUILDER_MANIFEST_DIR` | no | Default `<builder app root>/.factory/manifests`; must be the directory the builder process was started with |
| `FACTORY_STATE_DIR` | yes | Holds `registry.sqlite`, `artifacts/`, `exports/`, generated `tasks/`, and the `captures/` and `verifiers/` staging the controller removes after each use |
| `FACTORY_DRAFTER_URL` | for `intake` | The drafter's Agent Protocol base URL, `http(s)` only. Set with `FACTORY_DRAFTER_APP_ROOT` or not at all |
| `FACTORY_DRAFTER_APP_ROOT` | for `intake` | The DRAFTER package's root, so the controller can read a drafter thread's `draft/` through its installation store |
| `FACTORY_DRAFTER_ROUTE` | no | Default `/intake#agent`; only with the drafter pair |
| `FACTORY_DRAFTER_MANIFEST_DIR` | no | Default `<drafter app root>/.factory/manifests`; must be the directory the drafter process was started with. Only with the drafter pair |
| `FACTORY_DRAFTER_IMAGE` | no | Default: the pinned `node:24-slim` digest. Must equal what the drafter booted with, since the image is half of the provider identity the controller reads its threads by. Only with the drafter pair |
| `FACTORY_EXPORT_DIR` | no | Default `<state>/exports`; also the bundle's destination identity |
| `FACTORY_ARTIFACTS_DIR` | no | Default `<state>/artifacts`, the content-addressed evidence store |
| `FACTORY_APPROVAL_TTL_MS` | no | Default 900000 |
| `FACTORY_MAX_ACTIVE_MS` | no | Default 1200000; waiting on a person is not active time. What remains of it must be at least twice the target's `verifierDeadlineMs` at every `dispatch` and `retry`, or they refuse: size it as intake + candidate attempts × 2 × the deadline (the `cli` target, two attempts: 18000000) |
| `FACTORY_MAX_CHANGED_BYTES` | no | Default 1048576; exceeding it is a `scope_violation`, never a truncation |
| `FACTORY_MAX_INTAKE_ATTEMPTS` | no | Default 2, a positive integer: the drafter turns an issue intake may spend before its last refusal blocks it. Fixed on the row at create, like `FACTORY_MAX_ACTIVE_MS` |
| `FACTORY_MAX_CANDIDATE_ATTEMPTS` | no | Default 2, a positive integer: the builder dispatches a work order may spend, the first and one per `retry`. Fixed on the row at create |
| `FACTORY_REPO_ROOT` | no | The repository the targets pin into and the wide capture is taken from; default `git rev-parse --show-toplevel` from the package. Set by the Docker-lane tests, which copy the app outside the repository. |

The CLI's `create --issue` reads `FACTORY_GH` (default `gh`: the executable that answers
`issue view`), `FACTORY_REPOSITORY` (the `owner/name` to read from, else `--repo`, else the
checkout's `origin` remote) and `FACTORY_NO_FETCH` (`1` skips the `git fetch origin main`
before the pin is resolved from the checkout named by `FACTORY_REPO_ROOT`). With `--pin <sha>`
there is no `origin/main` to fetch or read at all: the named commit is used, fetched from
`origin` by sha only when the object store lacks it, and `FACTORY_NO_FETCH=1` refuses such a
pin, naming it, instead of fetching. `FACTORY_CLI_REQUEST_TIMEOUT_MS`,
`FACTORY_CLI_ARRIVAL_WINDOW_MS` and `FACTORY_CLI_INTERACTIVE` are test-only (they shorten the
request timeout and the arrival window the long-wait fallback measures, and let `review` ask on
a pipe as it would at a terminal); an operator sets none of them. `review` reads evidence from
`FACTORY_ARTIFACTS_DIR` when it is set, as the controller does.

The builder app reads `FACTORY_BUILDER_MANIFEST_DIR` (required: the manifest directory,
which may be empty; its `check` and `build` scripts default it to `.factory/manifests`) and
`FACTORY_BUILDER_MODEL` (default `gpt-5-mini`); its `check` and `build` scripts also read
`FACTORY_BUILDER_LANE` (`1` runs them, anything else skips them with a notice). The drafter app reads
`FACTORY_DRAFTER_MANIFEST_DIR` (required: the manifest directory, which may be empty),
`FACTORY_DRAFTER_IMAGE` (default: the pinned digest in `drafter/src/drafter-image.ts`) and
`FACTORY_DRAFTER_MODEL` (default `gpt-5-mini`). The CLI reads `FACTORY_CONTROLLER_URL` for
writes and `FACTORY_STATE_DIR` for reads; `builder-manifest` needs
neither. `builder-manifest --task <id> --out <dir> [--work-order <id>]` writes one work
order's manifest (named by the task id by default) for driving a builder without a
controller; it stages its capture under `FACTORY_STATE_DIR` when that is set (as the
controller does) and otherwise under a temporary directory it removes, never under the
controller package. `target:prepare` builds from a temporary archive and writes only the
target's `target.json` (under `FACTORY_TARGETS_DIR` when set), so run it before a `b4 dev`
controller starts or point it at another targets directory.

A work order whose worker has left the map — the drafter pair unset while a draft is in
flight — waits where it is, journalling
`worker_unavailable` (and `reconcile_failed`) until the map is restored and the controller
reconciles. `cancel` is the operator's escape when the worker is gone for good: with nowhere
to send the cancel and nothing to deny, it settles the row as `cancelled` with the fact
journalled.

Unknown keys are stripped rather than rejected, so an old service file keeps starting. Rung 0's
`FACTORY_WORKER_OUTBOX` and `FACTORY_RECEIPT_WAIT_MS` name nothing now — the trust transfer
they existed for is gone. Neither does anything rung 2 used to configure the standalone CLI's
port or the builder's task: the controller is an app with its own port, and the builder's task
is whichever one each work order's manifest names. `FACTORY_BUILDER_MANIFEST`, the builder's
old single-manifest variable, is gone the same way. Two retired variables are refused rather
than stripped, because each used to decide where a work order went or what it ran with:
`FACTORY_WORKERS` and `FACTORY_BUILDER_TARGET` (and the `factory builder-target` command that
wrote the latter's file is gone). The scripted intake's `FACTORY_INTAKE_ROUTE` and
`FACTORY_INTAKE_TASK` are gone the same way: the drafter is its own process now, and
`intake` refuses by name when the drafter pair is unset.

## Tests

The controller owns every factory test; the builder owns the tests for its own route and
config.

    # the controller
    pnpm --filter @b4-example/software-factory-controller test
    pnpm --filter @b4-example/software-factory-controller target:prepare cli-flags
    pnpm --filter @b4-example/software-factory-controller test:sandbox

    # the builder
    pnpm --filter @b4-example/software-factory-server test

    # the drafter (its base image, pulled by digest, is what the controller's
    # test:sandbox serves it on)
    pnpm --filter @b4-example/software-factory-drafter test
    docker pull "$(grep -o 'node:24-slim@sha256:[a-f0-9]*' examples/software-factory/drafter/src/drafter-image.ts)"

The controller's `test` is layer 1: every invariant, against a scripted worker, reader and
verifier, and it is the only always-on lane. `test:sandbox` is layers 2 and 3 — the real
builder, the real drafter and the real verifier — and needs Docker plus the `target:prepare`
step above, which builds the target images it runs in, and the drafter's base image pulled
by digest. Layer 2 needs Docker even though its model is scripted: the app configures a
sandbox, so the run acquires a real container — which is the point, since the permission
config and `runBash` are exactly what that layer exists to exercise. Both fail rather than
skip when Docker is absent. The controller's `builder.integration.test.ts` serves the builder
app from a private copy and proves its resolver: two work orders on one process, each thread
admitted with its own manifest's workspace; a `cli-flags` thread and two `devkit` threads at
two pins on that same process, each thread's intent recording its own target's image at its
own pin and its session running that image under its target's memory limit; and a thread
with no manifest, or naming an image the factory did not prepare, refused by name; the two end-to-end builder lanes dispatch
through the controller to the served builder, so the manifest `dispatch` wrote is what the
thread was admitted with. The controller's `drafter-resolver.integration.test.ts` serves
the drafter app from a private copy and proves its resolver: two threads for two work
orders each admitted with their own capture, and a thread with no manifest refused by name
(it lives with the controller's lanes so the drafter needs no test-only dependencies). The
controller's `drafter-end-to-end.integration.test.ts` is the whole intake for real: the wide capture
staged at a pin, a scripted drafter turn in the drafter's own process and image, the
re-rooted `draft/` read, and the oracle proof in the target's image.

In CI, all three packages' always-on lanes run inside `source-validate`'s `pnpm test`, which
the `validate` gate aggregates. The Docker work is the `sandbox-docker` job: it prepares both
target images (`target:prepare cli-flags` and `target:prepare devkit`), runs the
**builder's** own `check` and `build` (`FACTORY_BUILDER_LANE=1`) against an empty manifest
directory — the only place either runs, since `check` needs Docker — pulls the drafter's base image
by the digest in `drafter/src/drafter-image.ts`, runs the drafter's `check` and `build`
against an empty manifest directory, and then runs the controller's `test:sandbox`, which
serves the drafter in both of its drafter lanes. The `cli` target's lane
(`target-cli.integration.test.ts`) is opt-in and skips there: it needs the `cli` image (2 GB)
and runs about 70 minutes, so it runs by hand with
`pnpm --filter @b4-example/software-factory-controller target:prepare cli` and then
`pnpm --filter @b4-example/software-factory-controller test:sandbox:cli`
(`FACTORY_TEST_CLI_TARGET=1`).
