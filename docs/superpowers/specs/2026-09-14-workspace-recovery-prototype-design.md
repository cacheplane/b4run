# Workspace recovery prototype

Status: proposed bounded experiment; no public API or production migration approved.

## Decision

Prove workspace creation and recovery before publishing an initializer API. This
experiment implements only immutable fixture materialization, trusted selection
of a completed storage generation, and restart reattachment. Its result is
evidence and a recommendation for a subsequent production design.

The alternatives are a generic setup command, which retains ambiguous side effects,
and immediate integration of a shared workspace control plane, which commits to
too much infrastructure before the failure model is tested. A narrow prototype is
recommended because the two code-fixer fixtures already provide bounded inputs
and a concrete edit-preservation acceptance case.

The research basis is the
[durable workspace audit](/Users/blove/.codex/worktrees/6f78c71c-8e11-4fce-847d-52818cad5f97/dawn/docs/superpowers/audits/2026-09-14-durable-workspace-research.md).
Existing scope and tool-thread identity changes remain intact.

## Boundaries

Put experimental helpers under `packages/sandbox/test/support/`, with acceptance
tests under `packages/sandbox/test/`. Do not export them, change the provider
contract, add CLI commands, or wire them into the running code-fixer application.
The prototype is not a supported alternate runtime.

Use the actual two fixture projects as input. Keep fixture selection, allowed
edits, and correctness rules outside the generic prototype. Do not copy reference
patches or hidden verification material into agent-accessible images or storage.

The first supported topology is one Docker daemon on one host with a single
active prototype coordinator. Host application restart is supported; concurrent
coordinator operation is not. Enforce this limitation with exclusive admission,
rather than merely documenting it. Do not infer that a local lock protects against
containers left running after a host process exits.

Multi-host coordination, Postgres integration, Kubernetes implementation, live
agent execution, approval, artifact export, and model calls are out of scope.
Kubernetes qualification and a production lifecycle design remain required before
claiming cross-provider workspace creation support.

## Identities and persisted state

Keep these identities distinct:

- Logical workspace: scoped installation plus selected thread/attempt identity.
- Source digest: canonical manifest of initial file bytes and normalized paths.
- Environment identity: resolved local Docker image ID used for preparation and
  attachment; a mutable tag alone is insufficient.
- Attempt identity: a fresh random ID for each private preparation generation.
- Physical resources: Docker container IDs and attempt-specific named volume.

The test coordinator owns metadata in a host directory that is not mounted in
any sandbox. Metadata records the logical workspace, source and environment,
selected generation if present, and known attempt resources. Workspace contents
are never evidence of ownership or permission to delete a resource.

Use a local SQLite file for prototype metadata with transactions and a unique
logical-workspace key. This is an experiment-specific implementation, not a new
production storage adapter or a claim about existing B4 storage interfaces.
Persist an attempt ID before provisioning. Derive its resource names from that ID
so recovery can inspect a resource even when its create acknowledgement was lost.
Verify ownership labels and recorded immutable container IDs before destructive
operations. Treat unexpected resources as conflicts, never as disposable leftovers.

Use the repository's existing `node:sqlite` approach. Hold `BEGIN IMMEDIATE` on a
separate admission database for the coordinator's lifetime, with no busy wait;
another coordinator must receive an explicit busy result. Keep lifecycle records
in a second database so their transactions can commit while admission remains
held. Use a fixed canonical local state directory per prototype installation;
network filesystems and multiple state directories for the same installation are
unsupported. Do not implement stale-lock deletion based on PID files or elapsed
time. Test actual process termination and subsequent admission. SQLite transaction
semantics are documented in [Transactions](https://www.sqlite.org/lang_transaction.html).

## Preparation and publication

For each fixture, construct a deterministic manifest from its visible project
files, task text, and generated baseline material. Dependencies can remain in the
prepared environment. Reject absolute paths, traversal, duplicate normalized
paths, and source links escaping the materialized tree. Restrict the first format
to regular files with explicit executable flags; do not invent an archive format.

Allocate a new attempt-specific volume. Run the trusted bounded materializer in a
preparation container with no network and no agent processes. It copies only the
manifested files, constructs the required baseline, and validates the resulting
initial tree against the expected source manifest. The validator must account
explicitly for generated Git metadata and the dependency link rather than ignore
arbitrary extra files.

Stop the preparation container and confirm it is stopped before publication.
Confirming stopped state is necessary even when a command reported successful
exit. Publish the selected volume and provenance in one SQLite transaction.
Only a selected generation may be attached for ordinary filesystem operations.
No agent or editable session is admitted to a private generation.

Publication does not transactionally include volume writes. The protocol avoids
that requirement by making a verified, stopped generation the input to metadata
selection. Test interruption immediately before and after that selection.

## Recovery rules

On coordinator restart, acquire exclusive admission and read metadata before
creating anything. For an unpublished attempt, inspect its recorded/derived
resources, terminate its preparation container by physical identity, and confirm
termination. Then discard only that attempt's owned resources and prepare a new
generation. The initial experiment deliberately favors safe replacement over
trying to resume a partial copy.

If inspection or termination is uncertain, stop with an explicit unavailable
result. Never publish or delete storage while a possible preparer is unresolved.
Do not use lease expiry to infer termination.

For a published workspace, verify resource identity and storage existence, then
attach the selected volume using its recorded environment. Do not run seeding or
compare current mutable contents to the initial manifest. Expected user edits
must not make a workspace look corrupt. Missing storage is a lost-workspace
result; missing metadata with existing resources is a conflict.

Changing default source or environment applies to new logical workspaces. A
reconnect request uses stored provenance. An explicit create request for an
existing logical identity with different source/environment fails as conflicting
intent. It must neither silently ignore the request nor reset the workspace.

## Release and cleanup

Release stops/removes only the attached compute container. It retains selected
storage and metadata. Explicit destruction first records a deleting state,
blocks attachment, removes owned compute, confirms absence, removes owned storage,
and records completion. Retain enough deletion state to retry after interruption.
Do not reuse physical names or IDs across generations.

Cleanup errors are separate outcomes and must not replace the original failure.
The acceptance harness records the primary result and any cleanup failure, then
reports both. Unknown provider state is never treated as not found.

This prototype supports no concurrent active run or automatic takeover of an
editing session. Restart tests end the editing process before reconnecting;
abandoned preparation containers are the explicitly supported recovery case.
The production design must separately resolve ongoing tools, child processes,
idle reaping, and distributed writer admission.

## Acceptance evidence

Use deterministic injected failures for every boundary and real Docker for
materialization, termination, persisted edits, and resource cleanup. Run both
fixture inputs. No paid model runs are required.

| Case | Required assertion |
|---|---|
| Existing seeded-provider restart | A regression test demonstrates source reset or setup failure/destruction on retained storage; preserve it as evidence of the original defect. |
| Normal fresh create | Selected tree matches expected initial source; preparer stopped before editable attachment. |
| Release and reacquire | Edited file and original baseline survive; no seed operation occurs. |
| Coordinator process restart | Metadata and selected storage reconnect; edit survives fresh JS module state. |
| Crash during copy | Partial volume is never attached; stopped/owned abandoned attempt is replaced. |
| Crash after validation, before publication | Recovery discards only unpublished generation and creates a complete replacement. |
| Crash after publication, before response | Retry returns selected workspace without reseeding. |
| Lost resource-create acknowledgement | Derived attempt identity discovers only its owned resource; no unrelated deletion. |
| Competing coordinator | Second independent process receives explicit busy/unavailable before provisioning. |
| Unknown inspect/stop outcome | No publication or destructive cleanup until state is known. |
| Storage missing after publication | Explicit lost-workspace outcome; no fresh source substitution. |
| Resource identity mismatch | Conflict; foreign resource remains untouched. |
| Default source/environment changes | Existing reconnect preserves provenance; explicit conflicting create fails. |
| Interrupted deletion | Restart continues deletion and does not attach the deleting workspace. |

The original-regression test is evidence, not a failing test left in a required
suite: assert the observed unsafe old behavior in a clearly labeled diagnostic,
then assert the desired preservation behavior for the prototype. Do not weaken
the production contract to make a regression test pass.

Record commands, fixture digests, resolved image ID, host/daemon versions, fault
points, outcomes, and residual resources. Measure preparation and reattachment
separately. No vendor performance comparison or production SLA is implied.

## Exit decision

Proceed to a production API design only if the prototype preserves edits across
real process restarts, prevents partial publication, and fails safely on uncertain
ownership or termination. Publish its limitations alongside passing evidence.

The next design must assign the durable record to an existing runtime lifecycle
owner, define a supported persistence interface, specify active-run admission and
retention, and qualify Docker plus Kubernetes. The prototype's SQLite schema,
test helper names, and single-host lock are not automatically the production API.
If the experiment requires a large coordinator simply to materialize bounded
files, revisit provider-owned lifecycle services before expanding B4.
