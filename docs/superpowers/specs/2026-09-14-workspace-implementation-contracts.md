# Workspace implementation contracts

Date: 2026-09-14
Status: implementation refinement of approved lifecycle and authoring designs

Read with [lifecycle](2026-09-14-provider-owned-workspace-lifecycle-design.md) and
[authoring](2026-09-14-workspace-authoring-api-proposal.md). This document fixes
internal ownership and persistence choices without introducing another author API.

## Identity and source

The runtime creates an installation UUID once in its durable state directory.
A workspace association key is installation ID plus thread ID. UUID operation
IDs are generated once and saved before provider mutations. Provider/account/scope
bindings are immutable fields in the association, not recomputed from model input.

Source content and materialization options have separate identities. A v1 source
bundle contains sorted regular-file entries: canonical relative path, canonical
base64 bytes, and executable boolean. Its digest is SHA256 over the UTF-8 JSON
encoding of `["b4-workspace-source-v1", entries]`; entries are ordered arrays of
`[path, base64, executable]`. No locale ordering or text decoding of file content.
Empty files and an empty source are valid. Reject empty/absolute/traversing paths,
backslashes, controls, malformed Unicode, duplicate paths, and ancestor conflicts.
Use NFC-normalized paths and reject input not already NFC; do not silently rename
files. v1 portable paths use ASCII letters, digits, dot, underscore, hyphen, and
single spaces within segments; reject leading/trailing segment spaces and trailing dots,
Windows device-name segments, and case-insensitive collisions. Leading dots are
valid except the standalone traversal segments `.` and `..`. These restrictions
are source-bundle portability rules, not thread-ID restrictions.

Creation identity additionally binds source digest, resolved environment identity,
environment links, baseline options, and provider binding using versioned canonical
encoding. Runtime code must never treat source digest alone as complete intent.
Environment links are not encoded as ordinary source files and must be rejected
when they conflict with source paths. Source-file executable metadata is separate
from Git's generated initial commit identity.

## Provider operations

Use the following method names when implementing the new managed contract:

```ts
interface ManagedWorkspaceProvider {
  readonly name: string
  resolveEnvironment(signal: AbortSignal): Promise<ResolvedEnvironment>
  create(intent: WorkspaceCreateIntent, source: SourceReader,
    signal: AbortSignal): Promise<ReadyWorkspace>
  inspectCreation(operation: CreationOperation,
    signal: AbortSignal): Promise<CreationStatus>
  reconnect(reference: WorkspaceReference, policy: SandboxPolicy,
    signal: AbortSignal): Promise<WorkspaceSession>
  release(session: WorkspaceSessionReference, signal: AbortSignal): Promise<void>
  destroy(target: WorkspaceDeletionTarget, signal: AbortSignal): Promise<void>
}
```

These names describe the target contract; the source-bundle foundation does not
export this interface yet. WorkspaceCreateIntent contains operation and installation
IDs, thread association identity, canonical creation specification, and its digest.
SourceReader is bound to one verified bundle and supplies only manifest-declared
paths/bytes. ResolvedEnvironment and WorkspaceReference carry versioned, serializable,
credential-free provider payloads and validated provider/account/scope bindings.
ReadyWorkspace contains a reference plus verified provenance, never an active tool
handle. The runtime first records readiness, then calls reconnect for a session.

CreationStatus is a discriminated union: absent, pending, ready, failed, unknown.
Ready includes the original immutable result; failed includes a structured reason
and whether resources remain. Unknown never permits creation of a new operation.
WorkspaceDeletionTarget includes the persisted creation operation and, if known,
workspace reference; this permits cleanup after a lost create acknowledgment.
WorkspaceSession contains the existing filesystem/exec backends and workspaceRoot
plus an opaque session incarnation. Release names that incarnation, not only a
thread or reusable workspace name. A stale release cannot stop a replacement
session. Destroy and reconnect operate under serialized workspace admission.

The portable API exposes no lease that expires into permission to mutate. In
the first single-runtime implementation, a lifetime installation ownership guard
and per-workspace operation serialization supply admission. Managed SDK retries
must honor operation identity; arbitrary shell commands cannot be retried after
unknown outcomes as though they were create/inspect calls.

## Storage ownership

Put portable record types in @b4run/workspace; Node content capture stays behind
its Node entry point. The CLI owns orchestration. The SQLite implementation uses
@b4run/sqlite-storage and Node's existing SQLite dependency/runtime convention;
do not introduce a general storage facade across checkpoint and permission stores.

Use `.b4/workspaces/state.sqlite` for installation identity, source bundles,
associations, and deletion progress. Store complete encoded bundles transactionally
with their digest, not independent best-effort files. Set FULL synchronous mode.
Creation-intent insertion requires its source bundle to exist in the same store.
Readback verifies the bundle digest and canonical encoding before provider use.

Association fields: installation/thread IDs, record revision, immutable creation
intent, state (creating/ready/deleting/deleted), optional ready reference and
provenance, and deletion progress. Update by expected revision and state; stale
publication cannot override deleting. Deleted rows remain tombstones for this
first slice. Reads never implicitly create missing rows.

Keep provider recovery records in a separate provider-owned table/namespace; B4's
association store does not interpret them. Docker records physical generations
and identities there. A managed service may keep its records remotely. No
transaction is claimed across B4, the service, and filesystem mutations.

A separate local admission database holds a lifetime exclusive writer transaction,
so different workspace-state transactions and concurrent threads remain usable.
Canonicalize the state location. Missing state with existing admission identity,
or inconsistent installation identity, fails closed. Guard release occurs only
after runtime work settles. Multiple hosts, network-filesystem locking, replicas,
and silent recovery from whole state-directory loss are unsupported initially.
Custom database-backed thread/checkpoint stores do not imply those deployments
support managed workspaces; boot must enforce the local ownership requirement.

## Delivery boundaries

1. Canonical source bundle construction, integrity verification, and bounded
   decoding. Internal functions only; no author-facing runtime behavior yet.
2. Declarative source capture, build artifacts, SQLite state/ownership, and
   concrete exported contracts. Require source capture limits and no-follow reads
   before accepting app filesystem input.
3. Docker provider lifecycle and manager/runtime admission integration. Preserve
   explicit unsupported behavior for unqualified providers and targets.
4. Trusted tool context, code-fixer migration, approval/restart/built-app tests,
   docs and actual blueprint. User code walkthrough before PR remains required.

Each boundary receives focused tests and review. Full repository validation and
real Docker qualification are required before declaring integration complete;
foundation tests alone cannot substantiate runtime or recovery claims.
