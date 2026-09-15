# Provider-owned workspace lifecycle

Date: 2026-09-14
Status: revised architectural direction approved; contract proposal for review

## Decision and scope

B4 defines the workspace lifecycle contract; the provider implements it. A
managed provider delegates to its service. Docker and Kubernetes adapters can
share internal recovery machinery where their mechanisms overlap. Providers do
not have to implement Docker volumes, preparer containers, or B4's prototype
SQLite schema to satisfy the contract.

This document specifies the boundary and qualification requirements. It is not
an implementation plan or a claim that managed providers are qualified. The next
design increment defines concrete TypeScript types, source packaging, and the
code-fixer configuration together. Do not implement a broad provider platform
from this architectural document alone.

First delivery targets Docker and one active B4 runtime per installation, with
concurrent independent threads. This is the recommended scope assumption, not a
new multi-replica guarantee. Kubernetes and managed adapters require separate
qualification before advertising the same durability. Existing Kubernetes
support must remain explicitly distinguished from the new recovery capability;
an unsupported managed-workspace request must fail before tools run.

Breaking API changes are authorized. No compatibility adapter that silently
falls back to name-based creation or reseeding is required.

## Alternatives

1. **Provider owns workspace lifecycle (selected).** One behavioral contract,
   different implementations. Fits managed services without duplicating their
   control systems; requires strong adapter conformance tests.
2. **Runtime owns every physical transition.** Straightforward for our Docker
   prototype, but forces remote services into inappropriate intermediate states
   and creates two competing lifecycle controllers.
3. **Application setup callback.** Small initial surface, but leaves durable
   preparation, retries, and cleanup in example code. Does not meet the approved
   library adoption goal.

## Responsibility boundary

| Owner | Responsibilities |
| --- | --- |
| B4 runtime | Authenticate and authorize thread operations; admit runs; persist thread/workspace association, creation intent, expected provenance, and deletion intent; prevent tools from using unpublished workspaces; reconcile outstanding operations on restart. |
| Provider adapter | Resolve environment identity; prepare source; establish readiness; persist or recover provider operations; attach compute; retain files; stop or suspend execution; inspect and delete owned physical resources. |
| Provider service | Perform whatever lifecycle and storage operations its documented API guarantees. The adapter fills remaining gaps or declares the contract unsupported. |
| Application | Choose initial project content and policy; define task semantics, allowed edits, correctness checks, and review output. |

There is one authority per fact. B4's record owns which workspace belongs to a
thread and whether that association is usable or being deleted. Provider records
own physical provisioning and recovery. B4 must not persist a second copy of
every provider state or infer physical readiness from its own timestamps.

Thread IDs and resource names are addressing, not authorization. Provider scope,
account/project identity, and physical incarnation must be bound to the trusted
association. Model-supplied identifiers cannot select another workspace.

## Contract operations

The following are semantic operations, not final exported method names:

| Operation | Required behavior |
| --- | --- |
| Resolve environment | Resolve mutable configuration to an immutable provider identity before persisting creation intent. Never re-resolve a changed tag during recovery of that intent. |
| Create | Accept a stable operation ID and immutable creation specification. Return a ready workspace reference and provenance only after preparation is validated. Repeating the same operation recovers its original outcome; conflicting specifications are rejected. |
| Inspect creation | Reconcile a persisted operation ID after an unknown outcome, including a lost creation acknowledgment. Distinguish pending, ready, failed, absent, and unknown. Absence must be authoritative before retry creates physical resources. |
| Reconnect | Open the exact recorded workspace incarnation. Return usable filesystem/exec backends or a typed failure. Never recreate from original source when retained state is missing. |
| Release | Stop or suspend writable compute and retain the promised filesystem state. Return only when the outcome is confirmed; otherwise preserve an uncertain/retryable operation. Successful release invalidates the old local handle. |
| Destroy | Idempotently remove resources exclusively owned by the workspace, including owned recovery artifacts in the declared deletion scope. Support cleanup by creation operation ID when no workspace reference was returned. Do not delete shared base images or snapshots. |

Create and inspect-creation are logically distinct even if a service exposes an
idempotent operation that implements both. No unbounded polling or automatic
new operation ID on retry. Cancellation ends the caller's wait; it does not prove
that a remote mutation stopped or failed.

A provider reference is opaque, serializable, versioned, and credential-free.
It identifies an incarnation, not merely a reusable name. The adapter validates
its provider/account/scope binding on use. Credentials remain in provider
configuration. Reference schemas and operation storage require migration rules
when their formats change, even though legacy public API compatibility is not
required for this initial change.

## Creation and publication

Before invoking create, B4 durably records its operation ID, source identity,
immutable environment identity, provider binding, and full recoverable source
reference. A digest alone cannot recover files. The source artifact must remain
available through preparation and reconciliation; its backing storage and build
packaging are requirements of the next concrete API design.

The provider prepares an unpublished workspace and validates materialization.
It must prevent stale preparers from mutating a workspace admitted to tools.
Docker may use disposable generations and confirmed preparer termination. A
managed service may use an immutable prepared snapshot or another qualified
mechanism. Generic callback completion is not evidence of crash-safe publication.

B4 conditionally records the provider's ready reference and provenance against
the original operation. Only then may tools receive the backends. If B4 crashes
after provider creation but before recording readiness, inspection recovers the
same result. If the thread is already deleting, reconciliation cleans up the
operation instead of publishing it.

Provenance describes initial content, not current edited files. Application
rollouts or changes to default fixtures apply to new workspaces. Reconnect uses
the recorded intent/reference without calling source selection again.

## Retention, execution, and failure semantics

The minimum managed-workspace contract preserves files across successful release
and reconnect. Process-memory preservation is optional and explicitly described.
Pause/resume can restore running processes; it must not be treated as equivalent
to killing them. B4 must settle or explicitly terminate run-owned commands before
release so that a resumed session cannot revive an abandoned writer unnoticed.

Retention limits and expiry behavior are part of provider qualification. B4 must
not advertise indefinite retention when the service provides expiring snapshots.
The concrete API must expose the applicable retention policy and any known
deadline. Missing or expired retained state yields lost-workspace, requiring an
explicit new-workspace decision. The provider cannot transparently substitute a
fresh workspace under the recorded identity.

Typed failure categories must distinguish lost/expired workspace, identity
conflict, unsupported policy/capability, retryable unavailability, and uncertain
operation outcome. Failed stop, snapshot, inspection, or deletion must not be
converted into success or absence. Provider SDK automatic retries and auto-resume
must be audited so they cannot revive a released handle or replay an uncertain
non-idempotent shell command without a defined execution contract.

Successful ordinary stop/restart documentation does not establish crash durability
of every acknowledged write. Qualification must document the persistence boundary
and test the required failure cases. Providers that only restore an older snapshot
must disclose that limitation rather than claim continuous durable writes.

## Runtime integration

Extend the existing SandboxManager and runtime boot path. Do not introduce a
second application runner. Retain the existing permission-gated filesystem and
exec backend integration. A missing or invalid required workspace configuration
must fail closed rather than silently activate local filesystem fallbacks.

Workspace use is held for the entire admitted run, through cancellation and
actual command settlement. Idle reaping cannot release active work. Concurrent
different threads remain supported. A local runtime ownership guard must prevent
two runtime processes from independently admitting runs for the same installation;
its concrete implementation is part of the next design. A managed provider's
workspace lock does not coordinate B4 checkpoints or approvals across replicas.

Thread deletion first authorizes and excludes competing runs, then durably marks
deletion and blocks new admissions. Provider cleanup, checkpoint deletion, and
thread removal are retryable steps, not a cross-system transaction. Retain enough
trusted association/intent data until all steps complete; restart resumes deletion.
No thread identifier reuse can bypass an outstanding tombstone. Cleanup failure
must remain visible and actionable rather than losing ownership records.

All supported entry points, including normal development, built Node runtime,
and test/eval execution, must use the same ownership and lifecycle rules. Edge
targets that do not support workspace execution continue to reject that feature.

## Code-fixer consequences

The agent remains an ordinary agent() route using existing workspace tools.
Configuration declares initial fixture content, environment, and provider policy.
The exact author syntax follows the concrete source/packaging design; this
document does not invent a route input schema or a new discovery marker.

Remove application-owned seeding lifecycle, global single-attempt handles,
in-memory initialization flags, and physical cleanup journals when the library
capability is implemented. Fixture selection, independent verifier execution,
allowed-change assertions, and approval-bound candidate export remain application
responsibilities. Trusted baselines and review receipts remain outside writable
workspace content. No paid model execution is needed for lifecycle qualification.

## Qualification and delivery

Define reusable behavioral tests around the contract, with provider-specific
fault injection. Require: independent threads; duplicate create operation;
conflicting intent; interrupted preparation; lost create acknowledgment; restart
after publication; edits across release/reconnect; missing retained state; foreign
resource identity; uncertain stop; interrupted deletion; source availability;
expiry; and no tool access before publication or during deletion.

Add runtime tests for idle reaping during a long run, cancellation settlement,
deletion/admission races, and restart reconciliation. Include a fake managed
provider whose physical states do not resemble Docker, demonstrating that the
runtime depends on guarantees rather than Docker implementation details.

The completed test-only Docker prototype supplies evidence and reusable test
ideas, not production code to promote wholesale. First write the concrete API
and storage/source design, then plan and implement Docker plus runtime integration,
then simplify code-fixer and walk through its code with the user before any PR.
Kubernetes qualification and real managed adapters follow separately. Do not
claim feature parity from the fake-provider tests.

## Research basis

Official documentation reviewed September 14, 2026; no live managed-provider
qualification was performed.

- [Daytona persistence](https://www.daytona.io/docs/en/persistence/): retained
  identity/filesystem, archive/restore, and sandbox-class differences support
  delegating lifecycle rather than reproducing it in B4.
- [E2B persistence](https://docs.e2b.dev/sandbox/persistence): pause/resume retains
  state; timeout defaults and process restoration need explicit adapter policy.
- [Vercel persistence](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes):
  automatic persistence and named operations support delegation, but getOrCreate
  recreates a sandbox with an expired source snapshot. Reconnect must avoid that
  behavior. Setup hooks alone do not establish our crash-recovery contract.
- [Vercel snapshots](https://vercel.com/docs/sandbox/concepts/snapshots): snapshots
  can outlive sandbox deletion, requiring explicit owned-artifact cleanup scope.
- [Modal snapshots](https://modal.com/docs/guide/sandbox-snapshots): the documented
  workflow requires the caller to trigger snapshots and persist their IDs;
  remote infrastructure is not necessarily a complete workspace lifecycle owner.
- [Prior research](../audits/2026-09-14-durable-workspace-research.md) and
  [prototype evidence](../evidence/2026-09-14-workspace-recovery-prototype.md).
