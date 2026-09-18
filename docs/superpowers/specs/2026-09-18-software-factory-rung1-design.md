# Software factory, rung 1: controller-owned verification and the review bundle

Date: 2026-09-18
Status: design approved in conversation; awaiting written review
Program document: [b4.run Software Factory RFC 001](2026-09-16-software-factory-rfc.md)
Predecessor: [rung 0](2026-09-16-software-factory-rung0-design.md), merged as `8dbc0bdb`
Source snapshot: `6d16bb1a`

## Decision

The controller stops believing the worker. Rung 0 proved the dispatch seam but
accepted two trust transfers: the candidate digest came from the worker's own
tool result, and delivery was confirmed by reading a receipt the worker wrote.
Rung 1 removes both. The controller captures the baseline itself, assembles and
digests the candidate itself, verifies it in its own container with its own
checks, freezes a review bundle, binds approval to that bundle, and writes the
approved bytes itself.

The factory also grows its own bounded builder, so verification can leave a
worker's tools without gutting `examples/code-fixer`. That example stays exactly
as it is and becomes the comparison baseline the RFC calls arm A.

This is the rung that tests RFC hypothesis 2: that independent evidence improves
acceptance quality. Its headline proof is a candidate whose visible suite passes
and whose independent checks fail, which must not be able to reach review-ready.

## Decisions taken in conversation

| Question | Decision |
|---|---|
| How far may rung 1 reach? | Framework changes allowed, landing after the current release. |
| Does the factory keep using code-fixer as its worker? | No. The factory grows its own builder route; code-fixer is left untouched as arm A. |
| How does the controller obtain the candidate bytes? | Through a new public read-only thread-workspace surface in the framework, not over the wire and not by reaching into internals. |
| Where does the controller live? | It stays an example, with module seams kept clean enough that a later extraction is mechanical. Its service shape is a rung 3 question. |

## Three authorities

Rung 1 separates by process and container, not by prompt.

**Builder.** A bounded `agent` route inside `examples/software-factory/server`,
served by its own runtime. It reads and edits its sandbox workspace. It has no
verification tool, no export tool and no approval gate, so it has no way to
report a verdict and nothing reads its opinion.

**Controller.** The existing plain-Node service. It owns the registry, captures
the baseline, reads the builder's workspace read-only once the turn ends,
assembles and digests the candidate, drives verification, freezes bundles,
records approval and exports.

**Verifier.** Not a separate process but a distinct container: the controller's
own fresh workspace under its own sandbox scope, seeded from the controller's
captured baseline plus the candidate bytes, with independent checks written in
late from the controller's own copy.

The builder's container and the verifier's container are never the same
workspace, and the independent checks never exist inside the builder's.

## Dependency, and what it does not block

Rung 1 needs a supported way for a trusted co-located process to read a thread's
workspace without disturbing it. No such surface exists today: the Agent
Protocol exposes none, and acquiring the sandbox from a second process replaces
the worker's container. That surface is being designed and implemented
separately and will arrive as its own pull request. Rung 1 does not depend on
its exact shape, only on the contract below.

The controller consumes it behind one interface:

```ts
/** Read a builder thread's workspace after its turn ends. Never mutates it. */
export interface WorkspaceReader {
  read(threadId: string, signal: AbortSignal): Promise<ReadonlyMap<string, string>>
}
```

A fake implementation backs layers 1 and 2 of the proof, so implementation
starts immediately and only the Docker-gated layer waits on the framework PR.
If that surface lands with a different shape, this interface is the only file
that changes.

The verifier needs the same treatment, for a reason worth recording. The
framework's `fakeSandbox` cannot stand in for a real container here: it exposes
no managed-workspace member, so `withWorkspace` refuses it, and no leaf
metadata, so `inspectWorkspace` throws. There is therefore no in-memory way to
exercise the real verification path, and pretending otherwise would mean a test
suite that proves nothing. So verification sits behind its own interface too:

```ts
export interface Verifier {
  verify(input: VerifyInput, signal: AbortSignal): Promise<VerificationReceipt>
}
```

Layers 1 and 2 drive a scripted fake verifier whose verdicts the test chooses,
which is what lets them assert the controller's *response* to every verdict.
Layer 3 drives the real one in a real container, which is what proves the
verdicts themselves are earned. The headline invariant is asserted in both, and
only layer 3 can claim the verdict was real.

## What moves into the controller

In the order a work order meets them.

1. **Baseline authority.** The controller captures its own fixture directory with
   the framework's own capture, and the source-bundle digest it gets back is what
   this document calls the **baseline digest**. It never asks the builder for a
   baseline. A builder workspace whose own recorded source digest differs from it
   is a `baseline_mismatch`, not a negotiation.
2. **Candidate assembly.** After the turn ends, read the builder's workspace,
   diff against the captured baseline, and enforce the policy: only paths in the
   allowed inventory may differ, no path may be added or removed, and the total
   changed bytes must be under the configured cap, which defaults to one MiB as
   rung 0's patch cap did. A cap breach fails loudly and never truncates.
3. **Digest.** The controller computes the candidate digest over its own view:
   workspace identity, its own baseline digest, and the changed bytes sorted by
   path. Canonical serialization is specified below.
4. **Verification.** The controller runs the checks in its own fresh workspace,
   seeded from its captured baseline plus the candidate bytes. The visible suite
   runs first. The workspace is snapshotted before and after each suite and any
   persistent mutation by a suite is a rejection, which is what catches a
   candidate that edits its own tests. Only then are the independent checks
   written in, from the controller's copy, and run.
5. **Receipt.** The verifier identity is assigned by the harness. A pass requires
   the expected named assertions to match exactly once each, with skipped,
   todo and missing checks rejected. A third verdict, `inconclusive`, covers an
   unavailable dependency, a timeout or a missing environment, and blocks
   advancement rather than reading as failure.
6. **Review bundle.** Frozen before approval is possible. It binds the
   repository identity, baseline digest, specification digest, policy digest,
   environment identity, candidate digest, the evidence references and the exact
   requested operation and destination. Its digest is what approval binds to.
7. **Export.** The controller writes the approved bytes itself, idempotently,
   after re-reading the bundle and re-verifying the same candidate under the same
   policy. Rung 0's read of a worker-written receipt is deleted.

Two risks rung 0 accepted are retired here: the shared-host outbox read, and the
digest originating in a worker tool result. The second also retires a latent
defect in rung 0 as shipped, because tool output above the offload threshold is
silently replaced by a preview stub and rung 0's digest read would have failed
on a large candidate.

## Identity and canonical form

Every digest in rung 1 is `sha256` over a domain-separated, canonically
serialized value, so two processes agree without coordination.

```
candidateDigest = sha256("b4-factory-candidate-v1" || canon({
  workspaceId, baselineDigest, changes: sorted by path
}))

bundleDigest = sha256("b4-factory-bundle-v1" || canon({
  workOrderId, repositoryId, baselineDigest, specificationDigest, policyDigest,
  environmentIdentity, candidateDigest, evidence: sorted by id,
  operation, destinationId
}))
```

Each input is defined, so nothing in the bundle is a placeholder:

| Input | What it is in rung 1 |
|---|---|
| `workOrderId` | Binds the bundle to the work order whose approval it authorizes. Without it, two work orders that produce identical bundles (exactly what a retried task does) collide on this digest, and the evidence disagrees about which work order was delivered |
| `repositoryId` | The fixture's task id, which names the target the factory is allowed to work on |
| `baselineDigest` | The source-bundle digest of the controller's own capture |
| `specificationDigest` | Digest of the fixture's `task.md` plus the sorted acceptance ids |
| `policyDigest` | Digest of `checks.json` plus the manifest's allowed inventory and immutable paths |
| `environmentIdentity` | The pinned image digest the verifier ran under, not a tag |
| `candidateDigest` | As computed above |
| `evidence` | Artifact references for the check output, sorted by id |
| `operation`, `destinationId` | The exact requested action; in rung 1 always a local export and its directory |

The acceptance ids are the named assertions in `checks.json`. Rung 1 does not
invent a second criteria vocabulary: a check's assertion names are the criteria,
and a receipt maps each one to its verdict.

`canon` is `JSON.stringify` over objects whose keys are inserted in sorted
order, with file contents as UTF-8 strings and paths normalized to forward
slashes. Non-UTF-8 bytes and NUL are rejected at assembly, as rung 0 already
rejects them. The prefixes exist so a candidate digest can never be mistaken for
a bundle digest or for a workspace source digest, which uses the framework's own
prefix.

## Lifecycle changes

The builder no longer parks, so approval stops being a worker interrupt.

One state is added: `verifying`, which is active for budget purposes and covers
assembly plus both suites.

`awaiting_approval` keeps its name but changes meaning: it is reached because the
controller's own receipt passed, and the row now carries the bundle digest rather
than a worker interrupt id. `deny` from there is a pure record with no worker
round trip.

Added blocked reasons: `baseline_mismatch`, `scope_violation`,
`verification_failed`, `verification_inconclusive`.

Removed blocked reasons: `candidate_digest_unknown` and `interrupt_vanished`,
both of which existed only because the gate did. `unexpected_interrupt` stays,
because permission gates can still fire on the builder's bash and write tools,
and the controller must refuse to resolve a prompt it did not expect.

The main flow:

```
received -> dispatched -> running -> verifying
  -> awaiting_approval          receipt passed, bundle frozen
  -> blocked                    mismatch, scope, failed or inconclusive
  -> failed                     the turn produced no candidate at all
awaiting_approval -> exporting -> exported
awaiting_approval -> denied
```

Only these rows change or are added; every other row in rung 0's transition
table stands unaltered.

| From | Event | To |
|---|---|---|
| `running` | `turn_ended_with_workspace` | `verifying` |
| `running` | `turn_ended_without_changes` | `failed` (`ended_without_candidate`) |
| `verifying` | `receipt_passed` (bundle frozen in the same transaction) | `awaiting_approval` |
| `verifying` | `assembly_rejected` | `blocked` (`baseline_mismatch` or `scope_violation`) |
| `verifying` | `receipt_failed` | `blocked` (`verification_failed`) |
| `verifying` | `receipt_inconclusive` | `blocked` (`verification_inconclusive`) |
| `awaiting_approval` | `approve` (bundle digest matches) | `exporting` |
| `awaiting_approval` | `deny` | `denied`, with no worker call |

`candidate_interrupt` and `candidate_interrupt_without_digest` are deleted with
the gate. `verifying` is an active state for budget accounting.

Cancel, budget and reconciliation otherwise keep rung 0's shape. Reconciliation
gains one rule: a work order found in `verifying` has no durable external effect to adopt,
so it is re-verified from the recorded candidate rather than resumed, and a
candidate that can no longer be reproduced is `blocked`.

## Registry additions

Rung 0's tables stand. Three additions:

```sql
create table candidates (
  digest text primary key,
  work_order_id text not null references work_orders(id),
  baseline_digest text not null,
  changed_paths text not null,          -- JSON array
  bytes integer not null,
  artifact_digest text not null,        -- the changed bytes in the artifact store
  assembled_at text not null
);

create table receipts (
  id text primary key,
  work_order_id text not null references work_orders(id),
  candidate_digest text not null,
  verifier_identity text not null,
  policy_digest text not null,
  environment_identity text not null,
  verdict text not null,                -- pass | fail | inconclusive
  checks text not null,                 -- JSON: per check id, acceptance ids, verdict, evidence refs
  issued_at text not null
);

create table bundles (
  digest text primary key,
  work_order_id text not null references work_orders(id),
  candidate_digest text not null,
  receipt_id text not null references receipts(id),
  payload text not null,                -- the canonical bundle, verbatim
  frozen_at text not null
);
```

`approvals` gains `bundle_digest`. Approval binds to the bundle, not the
candidate alone, so a policy or environment change invalidates consent even when
the bytes are unchanged.

Evidence larger than a configured inline limit goes to a content-addressed
directory the controller owns, `<stateDir>/artifacts/<sha256>`, written with an
exclusive create and referenced by digest. The registry never holds megabytes of
check output.

## The builder route

A single `agent` route in the factory package. Its configuration, not its prompt,
is what bounds it:

- Its sandbox uses the factory's own scope and its own pinned image.
- Its workspace is the factory's captured fixture, with the allowed inventory and
  the immutable paths declared as data.
- Its tools are the built-in read, list, write and bash tools only. No custom
  tool, so there is no channel for a verdict.
- Permission patterns needed to run the fixture's own test command are
  pre-approved in configuration, so an interrupt means something unexpected
  happened and the controller treats it as such.
- Its prompt is an exported constant, so static fixtures can key to it.

The independent checks and the checks policy live in the factory's fixture data
and are never inside the builder's capture root, so they are structurally absent
from its workspace rather than merely excluded.

## Proof

### Layer 1: fake worker and fake sandbox, always on

Rung 0's scripted Agent Protocol fake, plus the fake `WorkspaceReader` and the
scripted `Verifier`. Covers the state machine, command idempotency, budget,
cancel and reconciliation as rung 0 did, and adds the adversarial cases that are
rung 1's point. Assembly, the digest and the bundle are exercised for real here,
because they are pure functions over bytes and need no container.

### Layer 2: the real builder under static fixtures, always on

The factory's own builder route driven in process by static model fixtures that
script file writes, with the scripted verifier standing in for the container.
This is the offline lane rung 0 had to defer, and it is buildable now precisely
because the builder only edits files. It needs a copied application root, the
way code-fixer's own harness tests do, because the harness runs typegen against
whatever root it is given.

### Layer 3: real containers, Docker-gated

The controller's real verifier in a real container, behind the same environment
gate the repository already uses for Docker suites. This layer waits on the
framework surface; nothing else does.

### Invariants

| Scenario | Required outcome | Layer |
|---|---|---|
| Visible suite passes, independent checks fail | Never reaches `awaiting_approval`; blocked `verification_failed` | 1, 3 |
| Builder claims success in prose or a file | Ignored; nothing reads a builder verdict | 1, 2 |
| Builder edits a test or a check | Rejected by the snapshot comparison; no pass receipt | 1, 3 |
| Builder writes outside the allowed inventory | Blocked `scope_violation` before any container starts | 1, 2 |
| Builder adds or removes a path | Blocked `scope_violation` | 1 |
| Builder's workspace reports a different source digest | Blocked `baseline_mismatch` | 1 |
| Changed bytes exceed the cap | Blocked `scope_violation`, never truncated | 1 |
| A check is skipped, todo, or missing from the expected set | Not a pass | 1, 3 |
| A dependency is unavailable or a suite times out | `inconclusive`, blocks advancement, distinct from failure | 1, 3 |
| Candidate changes after the bundle is frozen | The old approval cannot export the new bytes | 1 |
| Policy or environment changes after freezing | Approval invalid; a new bundle is required | 1 |
| Approve twice, or retry any command with one key | Recorded outcome returned; one export | 1 |
| Restart in `verifying` | Re-verified from the recorded candidate, never resumed | 1 |
| Restart in `exporting` | Receipt decides; approved bytes exported exactly once | 1 |
| Candidate attempts path traversal or network access | Denied at the real isolation boundary | 3 |
| Budget exhausted during verification | Cancelled, blocked `budget_exhausted`, no further work | 1 |

### What the proof does not claim

Nothing about repair quality beyond the fixtures, nothing about token or cost
budgets, no authentication, and no target other than the factory's own fixtures.
Verification proves a focused repair policy, not arbitrary program correctness,
and the receipt says so.

## Repository layout

```text
examples/software-factory/server/
  b4.config.ts                     NEW: the app gains a route, so it gains config
  fixtures/<taskId>/
    manifest.json                  allowed inventory, immutable paths, task id
    checks.json                    visible and independent suites, named assertions
    checks/                        independent check sources, never captured
    project/                       the baseline the controller captures
    task.md
  src/
    app/build/index.ts             NEW: the bounded builder route
    fixtures/catalog.ts            NEW: directory-scanning catalog, zod-validated
    verification/
      assemble.ts                  NEW: read, diff, policy, digest
      verify.ts                    NEW: fresh workspace, both suites, snapshots
      receipts.ts                  NEW: receipt shape and issuance
      checks-runner.ts             NEW: named-assertion policy
    review/
      bundle.ts                    NEW: freeze and digest
    delivery/
      export.ts                    NEW: idempotent local export of approved bytes
    storage/
      artifacts.ts                 NEW: content-addressed evidence store
    worker/
      workspace-reader.ts          NEW: the interface above and its real adapter
    controller/                    rung 0, extended
    registry/                      rung 0, plus the three new tables
    domain/                        rung 0, plus the new states and reasons
```

`src/worker/outbox.ts` is deleted with the receipt read it existed for.

## Risks accepted for rung 1

- **Same host.** The controller and builder still share a machine, and the
  workspace read depends on that. Distribution is not in scope.
- **No authentication.** Unchanged from rung 0 and documented in the README.
- **The verifier trusts its own image.** A pinned image digest is the boundary;
  an untrusted candidate could still observe its runtime. Higher-risk work would
  need the oracle in a separate process, as the RFC notes.
- **One fixture class.** Generality is not claimed until rung 2 retargets at the
  monorepo.

## Success criteria

1. Layer 1 and layer 2 pass in CI on every push.
2. Layer 3 passes under the Docker gate once the framework surface lands.
3. A candidate that passes the visible suite and fails the independent checks
   cannot reach `awaiting_approval`, demonstrated in both layer 1 and layer 3.
4. Only the exact approved bytes export, and a candidate that changes after
   freezing cannot be exported under the old approval.
5. `examples/code-fixer` has no diff.
6. `pnpm ci:validate` is green with the factory's new route and tests included.
