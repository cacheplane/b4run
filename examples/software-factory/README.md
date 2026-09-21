# Software factory (rung 1)

A work-order controller that owns both halves of the work: a bounded **builder** route that
edits files in a container, and a **controller** process that decides whether what the builder
left behind is worth exporting. It is the second rung of the
[software factory program](../../docs/superpowers/specs/2026-09-16-software-factory-rfc.md);
the rung 1 design is in
[its spec](../../docs/superpowers/specs/2026-09-18-software-factory-rung1-design.md), and
rung 0's is [here](../../docs/superpowers/specs/2026-09-16-software-factory-rung0-design.md).

Rung 0 asked the worker whether it had succeeded. Rung 1 stops asking.

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

No authentication (loopback only; do not expose it). No repair loop, no token budgets, no
live model producing a repair, no UI, and one export target (the local filesystem).
Verification proves a focused repair policy, not arbitrary program correctness, and the
receipt says so.

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
read-only in a separate, networkless container. `src/worker/workspace-reader.ts` is that
join; the builder's own session is never acquired, started, stopped or replaced, and the
reader carries no exec backend and no write operation, so a mutation cannot be expressed.

- **Joined, and proven in `test/end-to-end.integration.test.ts` (Docker-gated).** A real
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
  ownership; the process holding those two things is the boundary. In this example the
  builder is this package, so the command line uses its own root.
- **What rests on a fake elsewhere.** Layer 1 scripts the worker, the reader and the
  verifier. The end-to-end lane keeps only the Agent Protocol worker fake — pointed at the
  thread whose workspace the controller reads — and the builder-side test scripts the model,
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

## Run it

The builder and the verifier both run in the target's prepared image, so this needs Docker:

    cd examples/software-factory/server
    pnpm target:prepare cli-flags   # builds b4-factory-cli-flags:<pin>-<dockerfile sha>

Terminal 1, the builder — **this package**, not code-fixer:

    OPENAI_API_KEY=... pnpm dev --port 4100

Terminal 2, the controller:

    cd examples/software-factory/server
    export FACTORY_WORKER_URL=http://127.0.0.1:4100
    export FACTORY_WORKER_ROUTE=/build#agent
    export FACTORY_STATE_DIR=$PWD/.factory
    pnpm factory create --task cli-flags
    pnpm factory dispatch <id> --wait
    pnpm factory approve <id> --revision <n> --bundle <sha256>
    pnpm factory evidence <id>
    pnpm factory events <id>

`dispatch --wait` returns when the work order has stopped moving — including through the
controller's own `verifying` phase, which is not the worker's. If it reaches
`awaiting_approval`, approve with the revision and the **bundle digest** it printed, or `deny`.
`pnpm factory evidence <id>` prints the frozen candidate, receipt and bundle: what an approver
is actually being asked to consent to. `pnpm factory serve` exposes the same commands as JSON
on 127.0.0.1.

### Environment

| Variable | Required | Meaning |
|---|---|---|
| `FACTORY_WORKER_URL` | yes | The builder's Agent Protocol base URL, `http(s)` only |
| `FACTORY_STATE_DIR` | yes | Holds `registry.sqlite`, `artifacts/` and `exports/` |
| `FACTORY_WORKER_ROUTE` | no | Default `/build#agent` |
| `FACTORY_EXPORT_DIR` | no | Default `<state>/exports`; also the bundle's destination identity |
| `FACTORY_ARTIFACTS_DIR` | no | Default `<state>/artifacts`, the content-addressed evidence store |
| `FACTORY_APPROVAL_TTL_MS` | no | Default 900000 |
| `FACTORY_MAX_ACTIVE_MS` | no | Default 1200000; waiting on a person is not active time |
| `FACTORY_MAX_CHANGED_BYTES` | no | Default 1048576; exceeding it is a `scope_violation`, never a truncation |
| `FACTORY_HTTP_PORT` | no | Default 4300, for `serve` |
| `FACTORY_REPO_ROOT` | no | The repository the targets pin into; default `git rev-parse --show-toplevel` from the package. Set by the Docker-lane tests, which copy the app outside the repository. |
| `FACTORY_TASK_ID` | no | Which task `b4.config.ts` configures the builder for; default `cli-flags` |
| `FACTORY_BUILDER_MODEL` | no | Default `gpt-5-mini`, read by the builder route |

Rung 0's `FACTORY_WORKER_OUTBOX` and `FACTORY_RECEIPT_WAIT_MS` name nothing now — the trust
transfer they existed for is gone — but unknown keys are stripped rather than rejected, so an
old service file keeps starting.

## Tests

    pnpm test           # layer 1: every invariant, against a scripted worker, reader and verifier
    pnpm test:sandbox   # layers 2 and 3: the real builder and the real verifier, Docker required

Layer 1 is the only always-on lane. Layers 2 and 3 are Docker-gated and run in CI's
`sandbox-docker` job, after the step that prepares the factory's target images
(`target:prepare`). Layer 2 needs Docker even though its model is scripted: the app configures a sandbox, so the run acquires a
real container — which is the point, since the permission config and `runBash` are exactly
what that layer exists to exercise. Both fail rather than skip when Docker is absent.
