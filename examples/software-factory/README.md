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
  `/work-orders/dispatch#workflow`, `/work-orders/approve#workflow`,
  `/work-orders/deny#workflow`, `/work-orders/cancel#workflow` and `/reconcile#workflow`.
  It holds the task and target catalog (`targets/`, `tasks/`, `fixtures/`,
  `scripts/prepare-target.ts`), the registry, the verifier, the workspace reader, every test,
  and the `factory` CLI.
- **`server/`** (`@b4-example/software-factory-server`) — the builder: one bounded route that
  edits files in a container, and nothing else.
- **`drafter/`** (`@b4-example/software-factory-drafter`) — the drafter: one `intake` agent
  route with the four built-in workspace tools, run on the plain `node:24-slim` base image
  pinned by digest, with the network denied and permissions non-interactive. It reads a wide
  read-only capture of the repository and writes a task under `draft/`; it repairs nothing.

**The boundary.** Neither worker imports controller code. What crosses between them is a
**manifest**: a JSON file the controller writes naming a captured workspace, one per **work
order**. The builder's is `<FACTORY_BUILDER_MANIFEST_DIR>/<workOrderId>.json`, written by
`dispatch` into the target worker's manifest directory before it creates the builder thread
with `{ factoryWorkOrderId }`; the builder's resolver loads it when the thread's first run is
admitted, refuses one written for another target, verifies the workspace and serves it. It
carries no prompt: the task's instructions are the run's user message. What cannot vary per
thread — the provider (scope and image), the sandbox policy and the permissions are one per
app in the framework — is a second, per-process file, the **target file**
(`factory builder-target --target <id>`), which the builder's `b4.config.ts` reads from
`FACTORY_BUILDER_TARGET` at boot. So one builder process serves one target. A builder without
a target file refuses to load, which is why its `build` and `check` scripts run behind
`scripts/with-target.mjs` and skip with a notice when it is unset: the repository-wide `build`
has no target in hand, and the real build is the one the Docker lane runs after writing one.
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

## What it does not do

No repair loop, no token budgets, no live model producing a repair, no UI, and one export
target (the local filesystem). Verification proves a focused repair policy, not arbitrary
program correctness, and the receipt says so.

**No authorization.** The controller is an HTTP app whose routes mutate the registry, and
anyone who can reach its port can create, dispatch, approve and cancel work orders; there is
no authentication and no per-caller check, which this rung scopes out. Run it on loopback and
do not expose it. And note where the trust now sits on the builder's side: whoever can write
the file `FACTORY_BUILDER_TARGET` names chooses that builder's sandbox policy, resource
limits and permission allow-list, and whoever can write into its manifest directory chooses
the workspace a work order's thread starts from. That is a stronger control point than the
catalog key it replaced — a key only selected among the target definitions in the
repository, while these files state them outright.

**The pin is honoured, one image per pin.** The wide capture the drafter reads is taken at
the work order's pin, out of the object store; the generated `task.json` carries that pin, so
the target, the baseline, the oracle proof and the verification are all looked up at it, in the
image prepared AT that pin. A target records one image per pin it was prepared at (`images`
in `target.json`); a shipped task carries no pin and runs at its target's default `pin`. A draft
whose target has no image at the work order's pin blocks at once (`image_unprepared`, naming
the `target:prepare <id> --pin <pin>` an operator runs); no redraft can mend it. What is not
per pin yet is the BUILDER's sandbox image: a builder process boots from one target file,
written at the target's default pin, so a generated task at another pin is built in the
default pin's image and verified in its own. And intake threads accumulate on the drafter, one
per work order, since nothing sweeps a parked or blocked work order's drafter thread yet.

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
  a provider of the same kind, scope and image. Naming a thread id is not a claim of
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

`target:prepare <id> --pin <sha>` prepares the same target at another commit and records that
image beside the others (an issue work order is pinned to `origin/main`, so a target is
prepared at the pin its work orders name). The script refuses a pin at which the target's
root, build context or lockfile does not exist, naming the path: `cli-flags`'s fixture lived
under the server before the controller split, so it can only be prepared at its historical
pin, and `devkit` is the target that is re-pinned.

**1. Write the builder's target file.** A builder process serves one target, and the
controller writes that target's file from the catalog. This command needs no controller and
no registry (the manifests need no step: `dispatch` and `intake` write one per work order):

    pnpm --filter @b4-example/software-factory-controller \
      factory builder-target --target cli-flags --out /tmp/factory-builder

**2. Start the builder** (terminal 1), pointed at that file and at the directory the
controller will leave its manifests in:

    FACTORY_BUILDER_TARGET=/tmp/factory-builder/cli-flags.target.json \
    FACTORY_BUILDER_MANIFEST_DIR=/tmp/builder-manifests \
    OPENAI_API_KEY=... \
      pnpm --filter @b4-example/software-factory-server dev --port 4100

A second target is a second builder process, with its own target file, manifest directory,
port **and app root**. The app root is where the process keeps its installation store
(`.b4/workspaces`, one per process), so two processes over one package directory would each
take the other's threads for their own: give each builder its own copy of the `server`
package (what the Docker lanes' `isolatedApp` does), and the controller refuses a worker map
in which two builders, or a builder and the drafter, share one. For `cli-flags` and
`devkit`, say:

    for t in cli-flags devkit; do
      rsync -a --exclude node_modules --exclude .b4 --exclude .factory \
        examples/software-factory/server/ /tmp/builder-$t/
      ln -s $PWD/examples/software-factory/server/node_modules /tmp/builder-$t/node_modules
    done
    pnpm --filter @b4-example/software-factory-controller \
      factory builder-target --target devkit --out /tmp/factory-builder
    # terminal 1a
    cd /tmp/builder-cli-flags && FACTORY_BUILDER_TARGET=/tmp/factory-builder/cli-flags.target.json \
      FACTORY_BUILDER_MANIFEST_DIR=/tmp/builder-manifests/cli-flags \
      OPENAI_API_KEY=... pnpm exec b4 dev --port 4100
    # terminal 1b
    cd /tmp/builder-devkit && FACTORY_BUILDER_TARGET=/tmp/factory-builder/devkit.target.json \
      FACTORY_BUILDER_MANIFEST_DIR=/tmp/builder-manifests/devkit \
      OPENAI_API_KEY=... pnpm exec b4 dev --port 4101

Each copy shares only the package's dependencies, through the `node_modules` symlink, and
starts with no installation store of its own. The controller's
`FACTORY_WORKERS` then names both, with each process's manifest directory (step 4).

**3. Start the drafter** (terminal 2), told where the controller will leave its manifests.
It reads the repository through the capture in each manifest, never through the filesystem,
so it needs no repository path:

    FACTORY_DRAFTER_MANIFEST_DIR=/tmp/drafter-manifests \
    OPENAI_API_KEY=... \
      pnpm --filter @b4-example/software-factory-drafter dev --port 4200

`FACTORY_DRAFTER_MODEL` (default `gpt-5-mini`) picks the model. Do not set
`B4_PERMISSIONS_MODE` in this process: it would override the app's `non-interactive` mode,
and a drafter that parks on a permission prompt is a turn nobody answers.

**4. Start the controller** (terminal 3). It needs a *worker map* — which builder process
serves which target — its own state directory, and the drafter pair: the drafter's URL and
its *app root*, the package whose installation store the controller reads `draft/` from. For
one builder process, the legacy pair `FACTORY_WORKER_URL` + `FACTORY_BUILDER_APP_ROOT` is that
map, with `FACTORY_BUILDER_TARGET` (the same target file that builder booted from, which is
how the controller knows the one target it serves) and `FACTORY_BUILDER_MANIFEST_DIR` (the
directory it was started with):

    FACTORY_WORKER_URL=http://127.0.0.1:4100 \
    FACTORY_BUILDER_APP_ROOT=$PWD/examples/software-factory/server \
    FACTORY_BUILDER_TARGET=/tmp/factory-builder/cli-flags.target.json \
    FACTORY_BUILDER_MANIFEST_DIR=/tmp/builder-manifests \
    FACTORY_DRAFTER_URL=http://127.0.0.1:4200 \
    FACTORY_DRAFTER_APP_ROOT=$PWD/examples/software-factory/drafter \
    FACTORY_DRAFTER_MANIFEST_DIR=/tmp/drafter-manifests \
    FACTORY_STATE_DIR=$PWD/.factory \
      pnpm --filter @b4-example/software-factory-controller dev --port 4300

The legacy pair is one entry, keyed by the id in that target file: a work order of any
other target has no worker, and `dispatch` refuses it (`no worker for target <id>`) before
spending its key or a thread. With one builder process per target, `FACTORY_WORKERS` replaces
the pair: a JSON object from target id to `{ "url", "appRoot", "route"?, "manifestDir"? }`,
where `manifestDir` (default `<appRoot>/.factory/manifests`) is that process's
`FACTORY_BUILDER_MANIFEST_DIR`. For the two builders above:

    FACTORY_WORKERS='{
      "cli-flags": { "url": "http://127.0.0.1:4100", "appRoot": "/tmp/builder-cli-flags",
                     "manifestDir": "/tmp/builder-manifests/cli-flags" },
      "devkit":    { "url": "http://127.0.0.1:4101", "appRoot": "/tmp/builder-devkit",
                     "manifestDir": "/tmp/builder-manifests/devkit" }
    }' \
    FACTORY_DRAFTER_URL=http://127.0.0.1:4200 \
    FACTORY_DRAFTER_APP_ROOT=$PWD/examples/software-factory/drafter \
    FACTORY_DRAFTER_MANIFEST_DIR=/tmp/drafter-manifests \
    FACTORY_STATE_DIR=$PWD/.factory \
      pnpm --filter @b4-example/software-factory-controller dev --port 4300

There is no wildcard entry: a key is a target id, one URL serves one target, and no two
entries (nor an entry and the drafter) share an app root; each is refused by name. The two
forms are exclusive; setting both (or `FACTORY_BUILDER_TARGET` or
`FACTORY_BUILDER_MANIFEST_DIR` beside the map) is refused by name. The controller creates each manifest directory at boot; `dispatch` writes
the work order's manifest there before it creates the thread, and removes it once the row
leaves `dispatched`/`running` (the resolver reads it once, at the thread's first admission;
verification reads the workspace through the reader) or a cancel has settled the thread. Without the
drafter pair the controller starts and every command works except `intake`, which refuses
before spending anything.

**5. Drive it** (terminal 4). Every command above and below runs from the repository root.
The CLI's write commands are requests to the running controller
(`FACTORY_CONTROLLER_URL`); its read commands never touch the controller at all — they open
`<FACTORY_STATE_DIR>/registry.sqlite` read-only. So both variables are set:

    export FACTORY_CONTROLLER_URL=http://127.0.0.1:4300
    export FACTORY_STATE_DIR=$PWD/.factory
    alias factory='pnpm --filter @b4-example/software-factory-controller factory'

    factory create --task cli-flags
    factory create --issue 778 [--repo owner/name]         # from a GitHub issue, pinned to origin/main
    factory intake <id>                                    # issue work orders only; awaits the draft
    ls $FACTORY_STATE_DIR/tasks/<id>/                      # task.json spec.md checks.json checks/ issue.md
    factory approve-intake <id> --revision <n> --digest <sha256>   # or: factory reject-intake <id> --note "..."
    factory dispatch <id>                                  # awaits; journal events on stderr
    factory show <id>
    factory events <id>
    factory evidence <id>
    factory list
    factory approve <id> --revision <n> --bundle <sha256>   # or: factory deny <id>
    factory cancel <id>
    factory reconcile

`dispatch` returns when the work order has stopped moving — including through the controller's
own `verifying` phase, which is not the builder's — and tails the journal to stderr while it
waits. If it reaches `awaiting_approval`, approve with the revision and the **bundle digest**
it printed, or `deny`. `factory evidence <id>` prints the frozen candidate, receipt and
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
The manifest lives until the work order leaves intake for good (a block, an approval, a
settled cancel): a redraft reuses the admitted thread and needs no manifest, and one is
some 20 MiB on this repository, so it is removed rather than kept. The controller validates
the draft, fits it to a prepared target, materialises it as a task directory under
`<FACTORY_STATE_DIR>/tasks/<id>/` (the four files plus `issue.md`), and then **proves the
oracle**: it runs only the drafted check, with no candidate changes, against the unpatched
baseline in the target's image, and the check must FAIL there. A check that passes on the
defect would pass on anything, so that draft is refused. An invalid draft or one that is not
an oracle starts another drafter turn on the same thread with the refusal quoted; the
attempts default to 2, and the last refusal blocks the work order. A draft naming a package
with no prepared target blocks immediately (`no_target_for_package`), since no redraft can
prepare one, and so does a draft whose target has no image at the work order's pin
(`image_unprepared`: the prompt lists only the targets prepared at that pin, and the task's
`pin` is the controller's to fill, never the draft's). A draft that parks in
`awaiting_intake_approval` is read on disk and approved **by digest**: `show` prints the
row's `taskDigest`, `approve-intake` recomputes the directory's digest at call time and refuses
if either differs, so what the person read is what the builder and the verifier are given.
`reject-intake --note` journals the note and, attempts permitting, waits for the redraft.
A refusal `intake` records under its operation key (the thread could not be created, the
manifest could not be written) is replayed to every later call at the same revision: retry
with `--key <fresh>`. A pin the repository does not hold and cannot fetch is refused before
the key is spent, so that call simply works once the pin is reachable.
Unlike `awaiting_approval`, `awaiting_intake_approval` has no expiry: the draft waits as long
as it takes, and waiting on a person is not active time.
The review bundle later freezes the origin (issue and body digest), the pin, the approved task
digest and the oracle receipt id, so approving the export consents to all of them together.
A bundle frozen before these fields existed no longer parses, and there is no re-freeze from
`awaiting_approval`: a work order parked there across this change must be `deny`-ed and
created again.

**Exit codes.** A refused command and a runtime conflict (a second command while one is in
flight, a cancelled dispatch) both exit 1 with the body printed; everything else that
succeeded exits 0. A `dispatch` exits 0 only when the work order settles in
`awaiting_approval` or `exported` — `blocked`, `failed`, `cancelled`, `denied`,
`cancel_requested` and "did not settle" all exit 1, so a script cannot mistake an unfinished
work order for a shipped one. Likewise `intake` and `reject-intake` exit 0 only when the work
order settles in `awaiting_intake_approval` (a `blocked` draft, a cancel, and "did not settle"
exit 1), and `approve-intake` exits 0 only when the approval was accepted.

### Environment

The controller app reads:

| Variable | Required | Meaning |
|---|---|---|
| `FACTORY_WORKERS` | one of the two | The worker map: JSON from target id to `{ "url", "appRoot", "route"?, "manifestDir"? }`, one builder process (URL and app root of its own) per target; `manifestDir` defaults to `<appRoot>/.factory/manifests`. Exclusive with the pair below |
| `FACTORY_WORKER_URL` | one of the two | The legacy pair, with `FACTORY_BUILDER_APP_ROOT` and `FACTORY_BUILDER_TARGET`: one builder, for the one target its target file names. `http(s)` only |
| `FACTORY_BUILDER_APP_ROOT` | with `FACTORY_WORKER_URL` | The BUILDER package's root, so the workspace reader can address its installation store |
| `FACTORY_BUILDER_TARGET` | with `FACTORY_WORKER_URL` | The target file that builder boots from (`factory builder-target`); the controller keys the entry by its `target.id`. Missing or unreadable is a boot error naming it |
| `FACTORY_WORKER_ROUTE` | no | Default `/build#agent`; only with the legacy pair |
| `FACTORY_BUILDER_MANIFEST_DIR` | no | Default `<builder app root>/.factory/manifests`; must be the directory the builder process was started with. Only with the legacy pair |
| `FACTORY_STATE_DIR` | yes | Holds `registry.sqlite`, `artifacts/` and `exports/` |
| `FACTORY_DRAFTER_URL` | for `intake` | The drafter's Agent Protocol base URL, `http(s)` only. Set with `FACTORY_DRAFTER_APP_ROOT` or not at all |
| `FACTORY_DRAFTER_APP_ROOT` | for `intake` | The DRAFTER package's root, so the controller can read a drafter thread's `draft/` through its installation store |
| `FACTORY_DRAFTER_ROUTE` | no | Default `/intake#agent`; only with the drafter pair |
| `FACTORY_DRAFTER_MANIFEST_DIR` | no | Default `<drafter app root>/.factory/manifests`; must be the directory the drafter process was started with. Only with the drafter pair |
| `FACTORY_DRAFTER_IMAGE` | no | Default: the pinned `node:24-slim` digest. Must equal what the drafter booted with, since the image is half of the provider identity the controller reads its threads by. Only with the drafter pair |
| `FACTORY_EXPORT_DIR` | no | Default `<state>/exports`; also the bundle's destination identity |
| `FACTORY_ARTIFACTS_DIR` | no | Default `<state>/artifacts`, the content-addressed evidence store |
| `FACTORY_APPROVAL_TTL_MS` | no | Default 900000 |
| `FACTORY_MAX_ACTIVE_MS` | no | Default 1200000; waiting on a person is not active time |
| `FACTORY_MAX_CHANGED_BYTES` | no | Default 1048576; exceeding it is a `scope_violation`, never a truncation |
| `FACTORY_REPO_ROOT` | no | The repository the targets pin into and the wide capture is taken from; default `git rev-parse --show-toplevel` from the package. Set by the Docker-lane tests, which copy the app outside the repository. |

The CLI's `create --issue` reads `FACTORY_GH` (default `gh`: the executable that answers
`issue view`), `FACTORY_REPOSITORY` (the `owner/name` to read from, else `--repo`, else the
checkout's `origin` remote) and `FACTORY_NO_FETCH` (`1` skips the `git fetch origin main`
before the pin is resolved from the checkout named by `FACTORY_REPO_ROOT`).

The builder app reads `FACTORY_BUILDER_TARGET` (required: the target file `factory
builder-target` writes), `FACTORY_BUILDER_MANIFEST_DIR` (required: the manifest directory,
which may be empty; its `check` and `build` scripts default it to `.factory/manifests`) and
`FACTORY_BUILDER_MODEL` (default `gpt-5-mini`). The drafter app reads
`FACTORY_DRAFTER_MANIFEST_DIR` (required: the manifest directory, which may be empty),
`FACTORY_DRAFTER_IMAGE` (default: the pinned digest in `drafter/src/drafter-image.ts`) and
`FACTORY_DRAFTER_MODEL` (default `gpt-5-mini`). The CLI reads `FACTORY_CONTROLLER_URL` for
writes and `FACTORY_STATE_DIR` for reads; `builder-target` and `builder-manifest` need
neither. `builder-manifest --task <id> --out <dir> [--work-order <id>]` writes one work
order's manifest (named by the task id by default) for driving a builder without a
controller.

A work order whose worker has left the map — the drafter pair unset while a draft is in
flight, a target's entry removed while its build runs — waits where it is, journalling
`worker_unavailable` (and `reconcile_failed`) until the map is restored and the controller
reconciles. `cancel` is the operator's escape when the worker is gone for good: with nowhere
to send the cancel and nothing to deny, it settles the row as `cancelled` with the fact
journalled.

Unknown keys are stripped rather than rejected, so an old service file keeps starting. Rung 0's
`FACTORY_WORKER_OUTBOX` and `FACTORY_RECEIPT_WAIT_MS` name nothing now — the trust transfer
they existed for is gone. Neither does anything rung 2 used to configure the standalone CLI's
port or the builder's task: the controller is an app with its own port, and the builder's task
is whichever one each work order's manifest names. `FACTORY_BUILDER_MANIFEST`, the builder's
old single-manifest variable, is gone the same way: the builder refuses to boot without
`FACTORY_BUILDER_TARGET`. The scripted intake's `FACTORY_INTAKE_ROUTE` and
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
app for `cli-flags` from a private copy and proves its resolver: two work orders on one
process, each thread admitted with its own manifest's workspace, and a thread with no
manifest or another target's refused by name; the two end-to-end builder lanes dispatch
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
target images (`target:prepare cli-flags` and `target:prepare devkit`), writes the builder's
target file for `cli-flags` and runs the **builder's** own `check` and `build` against it and
an empty manifest directory — the only place either runs, since a target file exists nowhere
else — pulls the drafter's base image
by the digest in `drafter/src/drafter-image.ts`, runs the drafter's `check` and `build`
against an empty manifest directory, and then runs the controller's `test:sandbox`, which
serves the drafter in both of its drafter lanes.
