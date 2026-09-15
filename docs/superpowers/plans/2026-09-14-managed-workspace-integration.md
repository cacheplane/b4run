# Managed Workspace Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Ship the approved provider-owned workspace lifecycle through normal Node runtime/build flows and the runnable code-fixer example, qualify the integration, and open a PR.

**Architecture:** Declarative source bundles and creation options form persisted intents in the installation store. The CLI owns associations/admission; providers own physical creation/recovery/session/destruction. Docker implements the qualified lifecycle. Source artifacts are captured at build time, verified at startup, and imported into durable storage. Trusted tool provenance comes from the admitted association. The app owns domain verification and approval-bound export only.

**Tech Stack:** TypeScript, Node SQLite, Docker CLI, Vitest, pnpm monorepo, GitHub CLI.

---

Read the approved provider-owned lifecycle, authoring API, and implementation contracts in `docs/superpowers/specs/`. User now explicitly authorizes proceeding through full integration testing to a PR; provide the code walkthrough with the finished review handoff. No automatic merge requested in this turn.

## Concrete integration contracts

Keep ordinary sandbox support available for providers without managed workspaces. Add a `workspaces` capability on `SandboxProvider`, containing the approved `ManagedWorkspaceProvider` methods; this avoids ambiguous overloaded release/destroy methods between thread IDs and durable references. `dockerSandbox(...)` supplies it automatically. Authors configure only `sandbox.workspace` and their existing provider. Providers without the capability reject workspace configuration before provisioning.

`WorkspaceDefinition` contains `source: WorkspaceSourceDefinition`, optional `environmentLinks: readonly {path,target}[]` and optional `baseline: "git"`. Environment links use portable relative workspace paths and absolute immutable environment paths; deny overlap with sources, each other and generated .git metadata. A resolved environment has provider binding plus immutable image/service identity. Creation intent binds installation/thread/operation IDs, verified source digest, environment, links and baseline through canonical versioned hashing. References and provenance are credential-free serializable records, validated against the persisted intent before use.

The SQLite installation owner exposes association methods, not a raw connection. Insert intent only when source exists. CAS transitions use revision and state; creating -> ready -> deleting -> deleted, with creating -> deleting allowed. Tombstones prevent recreation. Deletion resumes physical cleanup before checkpoint/thread removal and marks deleted only after those finish.

Docker uses deterministic operation-scoped resource names and immutable ownership labels. Preparation is unpublished: partial volumes may be discarded and rebuilt under the same operation only before readiness publication. Publish verified provenance in a provider-owned control resource inaccessible to agent tools. Once published, missing/mismatched physical resources fail closed. Reconnect creates a new session incarnation and release targets only that incarnation. Foreign resources are never adopted or deleted. Image tags resolve to IDs before intent capture. Agent sessions have a read-only image filesystem so declared dependency links remain immutable.

## Task 1: Shared workspace contracts and durable associations

Files: new `packages/workspace/src/managed-workspace.ts` and Node validation helpers; update workspace barrels/sandbox-types; new sqlite association store under `src/workspace/`; extend installation owner and package barrel; corresponding package tests and API docs.

- [x] Write failing contract/canonical identity and transition tests, run focused tests to observe RED.
- [x] Implement validated source/options/intent/reference/provenance contracts, immutable snapshots, bounded serialization and strict canonical identity.
- [x] Implement source-backed intent insertion, state/revision CAS, ready binding validation, and deletion tombstones. Extend installation schema validation without silently repairing established missing tables.
- [x] Run package tests and typechecks; build shared packages before downstream consumers.

## Task 2: Docker managed lifecycle

Files: `packages/sandbox/src/docker/managed-workspace.ts` plus focused helpers/tests; wire `docker-sandbox.ts`; Docker qualification tests under package test and root integration harness.

- [x] Test environment pinning, foreign-resource rejection, interrupted unpublished preparation, lost ready acknowledgement, reconnect preserving edits, missing ready volume failure, stale session release, and resumable destroy before implementation.
- [x] Implement provider lifecycle with explicit inspected status; no arbitrary initializer callback or app state access. Verify every Docker command result. Unknown inspection errors never imply absence.
- [x] Prepare exact binary source with executable modes, immutable links and deterministic Git baseline using fixed author/time, disabled ambient config/hooks and explicit file inventory. Read back exact content/modes and baseline before publishing.
- [x] Test cancellation/partial preparation, Docker unavailability, exact scope/installation/operation/image binding and cleanup.
- [x] Review spec compliance then quality; resolve findings before integration.

## Task 3: Build and Node runtime integration

Files: CLI build command/Node target, config loading and sandbox resolution, sandbox manager, runtime-fetch core/direct route execution, SDK tool context and execution materialization, check command, package tests.

- [x] Write failing tests for capture-before-provision, invalid config refusal, unsupported providers/targets, absent workspace marker, built startup without source directories, and changed deployment source applying only to new threads.
- [x] Capture/validate before cleaning or emitting build artifacts. Include complete verified source + canonical options in versioned Node artifact. Verify built artifacts at startup and import into the owned installation store. Never recapture missing built sources.
- [x] Resolve ownership once at Node startup; close only after run drain and provider session release. Direct route execution must enforce the same required-workspace boundary.
- [x] Persist intent before provider calls. Inspect pending creation; never retry an unknown operation as new. Publish ready reference before reconnect/tool exposure. Bind every result to the persisted intent.
- [x] Hold per-thread run use through settlement so idle reaping cannot terminate active tools. Serialize create/reconnect/release/delete per thread. Different threads remain concurrent.
- [x] Persist deleting before provider cleanup; checkpoint/thread cleanup follows physical cleanup; retain tombstones and resume interrupted deletion.
- [x] Add readonly permission-bound `ctx.workspace` identity/provenance and `readInitialFile`; no raw provider handles or caller-selectable identities.
- [x] Run focused runtime/build/permissions/approval tests; review and resolve findings.

## Task 4: Correct the runnable app and blueprint

Files: examples/code-fixer/server config, src/app/fix tool(s), ordinary fixture/verification modules replacing src/blueprint runtime architecture, eval/replay scripts/tests, README and actual b4-add guide/docs.

- [x] Test ordinary route execution with both fixture definitions; remove attempt-context/global handle/baseline maps, seeded/owned provider wrappers and custom agent runner dependence.
- [x] Use declarative source helper, library-managed workspace and trusted provenance. Keep independent hidden verifier inputs outside agent source/image. Preserve limits and candidate-byte binding.
- [x] Separate prepare-review verification from approval-gated export if needed: approval must bind the exact verified bytes, and resume must reject changed candidates. Do not perform approval-bound effects before approval.
- [x] Update runnable commands and the actual blueprint guide; migrate evaluation support without rewriting historical evidence.
- [ ] Walk through concise final example code as part of PR handoff.

## Task 5: Full integration qualification and PR

Progress/check outcomes after this committed snapshot are tracked in
https://github.com/cacheplane/b4run/pull/655. The PR is draft while remaining
local and CI gates run; unchecked items below describe this snapshot.

- [x] Independent final spec/code review; apply fixes with regression tests.
- [x] Add patch changesets for affected packages; update API contract registries, docs inventories, necessary release pins only if touched.
- [ ] Run `pnpm ci:validate`, changeset checks, and required real Docker qualification for normal runtime, built Node without source, restart/SIGKILL, concurrent threads, active-run idle handling, interrupted delete, permission/approval-resume and both fixture evals. No paid model calls unless needed; use deterministic replay/model stubs to test actual execution paths.
- [ ] Verify no leftover owned test Docker resources. Record exact evidence and any material boundary limits; do not substitute old prototype results.
- [ ] Inspect upstream divergence and active CI load; rebase/resolve only as needed, rerun affected validation after changes. Commit with explicit files, push branch, create reviewable PR with problem/behavior/testing and code walkthrough.
- [ ] Observe PR required checks and report actual status. No merge until green and authorized for this finished PR.

## Reviewed protocol refinements

Docker publication uses an operation-scoped, stopped control container (`b4-ws-record-<hash>`) with immutable labels holding a bounded, versioned ready record (reference and provenance). It is never mounted into or controlled from agent sessions. Workspace volume and preparation container names use the same operation hash; labels bind installation, scope, provider account, operation, source and complete intent identity. A create retry inspects the ready record first. A matching record is authoritative; missing referenced storage is lost, never reinitialized. Without a record, inspect and forcibly remove the owned preparation container and confirm absence before removing a partial owned volume or starting a replacement preparer. Foreign labels or uncertain inspection prohibit mutation. Preparation writes/checks all source and baseline, then the preparer is removed and confirmed absent BEFORE creating the ready control container. That container's successful creation is the publication point; lost acknowledgement is recovered by inspection. Destroy confirms all owned session/preparation containers gone, removes owned workspace volume, then removes the ready control container last. Missing resources are success only during persisted deletion. Test process death with a live preparer, lost publication acknowledgement, and interruption between every destructive step.

Shared types include `CreationStatus` (absent/pending/ready/failed/unknown), operation-based deletion without a reference, opaque session incarnation references, and retention semantics. First Docker retention is explicit indefinite filesystem retention until destroy, with disposable compute; remote adapters may declare expiry/deadline and memory retention in ready provenance. Typed lifecycle failures distinguish lost, expired, conflict, unsupported, retryable and uncertain. Unknown outcomes never become absence or automatic recreation.

Qualification additionally requires a fake managed provider with independently modeled physical states (not a Docker shell emulator); duplicate/conflicting intent; uncertain release; cancellation where a process survives; deletion/admission races; unauthorized deletion; no tool access before ready publication or while deleting; denied initial-source reads; and cross-thread provenance isolation. Reaping/release must wait for actual execution settlement, not merely abort delivery. Managed-provider transport/API retries may recover their own operation; arbitrary agent commands are never replayed after unknown outcomes.

The independent verifier needs a disposable workspace without copying lifecycle
code back into the app. Add `withWorkspace({appRoot,stateRoot,provider,workspace,
policy,signal}, callback)` to the Node CLI surface. It reuses the same installation
store and managed controller, cleans up unfinished records before admitting a
new callback, and persists deletion before cleanup. `stateRoot` is a dedicated,
private durable directory with one invocation at a time; different directories
permit concurrent verifier jobs. The callback receives ordinary sandbox backends,
not provider lifecycle authority. The app supplies only its fixture descriptor,
verification commands, candidate content and a stable verifier-state namespace.
Tests must cover success/failure cleanup, interrupted prior-run cleanup before
callback, concurrent-owner refusal and uncertain cleanup retaining deletion state.

Docker operation resource names are keyed by provider binding, installation and
operation identity only. The complete intent digest is an immutable label to
validate, not an addressing component; conflicting retries must find and reject
the original operation rather than select a new resource namespace.
