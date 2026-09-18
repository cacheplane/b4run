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

- **The controller owns the verdict.** It captures the baseline itself, reads the builder's
  workspace itself, diffs and digests the candidate itself, runs the checks in *its own*
  container with a separate sandbox scope and a freshly captured workspace, and issues its own
  receipt. The builder has no channel for a verdict: no gate, no interrupt, no receipt tool.
  Prose claiming success is just prose.
- **The independent checks are structurally out of reach.** They are a sibling of the
  captured `project/` directory, so they are absent from the builder's workspace rather than
  merely excluded from it, and the verifier writes them in only after the visible suite has
  had its turn, from the controller's own copy. A candidate that passes the visible suite and
  fails the independent checks cannot reach `awaiting_approval`.
- **A candidate cannot repair itself by editing its tests.** The verifier snapshots the
  workspace before and after each suite; any persistent change a suite made is a rejection.
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

## What it does not do

No authentication (loopback only; do not expose it). No repair loop, no token budgets, one
task (`cli-flags`), no UI, and one export target (the local filesystem). Verification proves a
focused repair policy, not arbitrary program correctness, and the receipt says so.

**Both example directories are used as shipped.** `examples/code-fixer` is untouched by this
rung; the factory only borrows its fixture image.

## The dependency that is not met yet

The controller needs a supported way for a trusted co-located process to read a builder
thread's workspace without disturbing it. That surface is
`SandboxProvider.openWorkspaceReader`, **proposed in pull request #731 and still open**. It is
not in this build.

What that means, exactly:

- **Works today.** Everything the controller does with bytes it already has: assembly,
  digests, the policy, bundle freezing, approval binding, export, the whole state machine and
  reconciliation — all of it against a scripted `WorkspaceReader` in tests. The *real*
  verifier also works today, in a real container, against candidate bytes a test hands it:
  that is what earns the independent-checks and self-repair invariants.
- **Inconclusive as a result.** The end-to-end path — builder runs, controller reads *its*
  workspace, verifies, freezes, exports — is not exercised anywhere. Run the command line
  against a real builder and every work order settles as `verification_inconclusive` with a
  `workspace_unreadable` event, because `createThreadWorkspaceReader` throws. The CLI prints
  this on stderr at startup on every command, so the cause is known before the first dispatch
  rather than inferred from the journal afterwards.
- **What changes when #731 lands.** `createThreadWorkspaceReader` becomes
  `createHandleWorkspaceReader` over the new surface — one function in
  `src/worker/workspace-reader.ts`, which already exists and is tested. Nothing else moves.
  Two workarounds were considered and rejected as worse than an honest absence: acquiring the
  builder's sandbox from the controller process would *replace* its container, and deriving
  the volume name from `resourceScope` is unexported addressing, not an ownership check.

## Run it

Both lanes need Docker and the fixture image, because the app configures a sandbox:

    pnpm --filter @b4-example/code-fixer-server sandbox:prepare   # builds b4-code-fixer:fixture-v1

Terminal 1, the builder — **this package**, not code-fixer:

    cd examples/software-factory/server && OPENAI_API_KEY=... pnpm dev --port 4100

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
| `FACTORY_SANDBOX_IMAGE` | no | Default `b4-code-fixer:fixture-v1`, run by both the builder and the verifier |
| `FACTORY_TASK_ID` | no | Which fixture `b4.config.ts` configures the builder for; default `cli-flags` |
| `FACTORY_BUILDER_MODEL` | no | Default `gpt-5-mini`, read by the builder route |

Rung 0's `FACTORY_WORKER_OUTBOX` and `FACTORY_RECEIPT_WAIT_MS` name nothing now — the trust
transfer they existed for is gone — but unknown keys are stripped rather than rejected, so an
old service file keeps starting.

## Tests

    pnpm test           # layer 1: every invariant, against a scripted worker, reader and verifier
    pnpm test:sandbox   # layers 2 and 3: the real builder and the real verifier, Docker required

Layer 1 is the only always-on lane. Layers 2 and 3 are Docker-gated and run in CI's
`sandbox-docker` job, after the step that builds `b4-code-fixer:fixture-v1`. Layer 2 needs
Docker even though its model is scripted: the app configures a sandbox, so the run acquires a
real container — which is the point, since the permission config and `runBash` are exactly
what that layer exists to exercise. Both fail rather than skip when Docker is absent.
