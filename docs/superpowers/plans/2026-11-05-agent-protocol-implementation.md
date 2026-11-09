# Coordinated Agent Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved B4/b4app Agent Protocol replacement through reviewable components and one qualified release.

**Architecture:** Shared pinned contracts lead into coordinated storage/execution and thin standard/native bindings. Store remains an independent authoritative domain transaction, while b4app owns a durable local projection and gated mirror activation. An integration branch contains the incomplete replacement until exact cross-repo candidates satisfy release gates.

**Tech Stack:** TypeScript/pnpm/Node, SQLite/Postgres, LangGraph/LangChain, AG-UI, Swift/Xcode, Rust hub, existing release/site/chart tooling.

---

**Status:** Implementation plan prepared from Brian's written-spec approval on
2026-11-05. The [independent plan review](../reports/2026-11-05-agent-protocol-plan-review.md) is recorded separately; no implementation, live testing,
publish, deployment, project upgrade or data reset has been performed by writing it.

**Approved design entry:** [coordinated specification](../specs/2026-11-05-agent-protocol-coordinated-design.md).
The wire/runtime/client and unchanged approved Store specs govern behavior. This
plan chooses source-file/task boundaries, not new public protocol policies.

## 1. Component plans and execution order

| Component | Tasks | Requires | Output |
| --- | --- | --- | --- |
| [Contracts](2026-11-05-agent-protocol-contracts.md) | C1–C5 | P0 | Frozen schema/corpus hashes, DTO exports, validation/catalog/authority |
| [Runtime/storage](2026-11-05-agent-protocol-runtime-storage.md) | R1–R12 | C contracts | Actual SQLite/Postgres coordination, executor, state and recovery services |
| [Bindings/consumers](2026-11-05-agent-protocol-bindings-consumers.md) | B1–B7 | Relevant C/R services | 27+6 routes, real transports, native compatibility and first-party consumers |
| [Store/memory](2026-11-05-agent-protocol-store-memory.md) | S1–S6 | C1/C2/C5; B1 composition | Generic Store, transactional managed projection/review and all writer/client paths |
| [b4app](2026-11-05-b4app-agent-protocol.md) | A1–A10 | C2 first; matching B/R artifacts for integration | Standard/generic+B4 client, durable projection and safe v2 sync activation |
| [Docs/release](2026-11-05-agent-protocol-release.md) | L1–L6 | P0 for prep; all component exits for qualification | Current guidance, site hold, exact candidates, live evidence and authorized cutover |

Execution waves:

1. P0; C1/C2 establishes the immutable shared contract before dependent interfaces.
2. C3–C5 and R1–R3; S1–S3 and A1/A2 can start against frozen corpus without guessing live runtime behavior.
3. R4–R12, S4 and A3–A7 complete service/storage and fixture-backed client work.
4. B1–B7, S5/S6, A8/A9 and L1/L3 finish bindings/native/consumer/host/profile work. B1 waits for R9–R11; S5 composition waits for B1.
5. L2/L4 exact packed integration and A10 live/packaged/device evidence; fix failures and rerun affected gates.
6. L5 presents the complete release candidate/runbook; L6 runs only on the user's final concrete release instruction.

Overlapping work uses distinct files/owned branches, with interface changes
coordinated before editing callers. Normally keep at most two maintainer-managed
full CI submissions active, accounting for main; do not cancel release runs or
add global serialization. Every worker must start on its intended checked-out
branch, never a detached or unrelated worktree HEAD.

## 2. P0: Prepare isolated implementation worktrees and refresh the map

**Files:** Approved specs/plans in both repos; create a private execution log and
candidate-source manifest under a task-specific temporary directory. Update plan
path references only for verified drift, retaining an explicit mapping.

- [ ] Inspect both original worktrees/branches/status without switching them. Preserve the existing unrelated changes. Read the implementation revision's AGENTS.md and applicable nested instructions before edits.
- [ ] Fetch/read current remote main refs, compare to audit baselines B4 c1e1796556d0863da735e47822014bafa015ef3f and b4app e15c113d4d8d5fca17475b42f34cbef7914791d4, and record exact selected SHAs. Do not silently replace normative upstream protocol pins.
- [ ] Use @superpowers:using-git-worktrees to create fresh B4 integration/agent-protocol-v1 and b4app implementation worktrees from selected main; verify local worktree directories are ignored. Import only the approved spec/plan documentation commits, not the old dirty checkout's unrelated branch history.
- [ ] Inventory `git ls-tree -r --name-only` and `rg` for each plan's Modify/Test paths, actual package names/scripts, current migration numbers, callback/adapter interfaces and new collisions. Resolve path drift before assigning a task; do not create a second file merely because its old name moved. Record exact destinations for dynamically discovered consumer call sites.
- [ ] Install with each repo's locked/current toolchain and run baseline gates: B4 `pnpm install --frozen-lockfile`, `pnpm ci:validate`; b4app prerequisite fetch, formatting/build/tests and current app/Rust CI lanes. Build B4 before any dist consumer. If a failure occurs, use @superpowers:systematic-debugging and distinguish environment/setup from source failure; don't weaken assertions.
- [ ] Record baseline outcomes, source/corpus/package/toolchain hashes and private scratch paths. No real account store, existing .b4 tree, credential dump or external production resource is a test fixture. Only after prerequisites/interface ownership are clear begin C1.

The documentation branches used to author this plan are not execution branches.
They are based on the audited revisions plus documentation commits; current main
may contain newer work. Do not reset/replace those originals or change current
release automation simply to make a feature branch publishable.

## 3. Shared coding and verification loop

Each implementation task has focused RED → minimal implementation → GREEN →
review → commit steps. Use @superpowers:test-driven-development for substantive
features/bug fixes and @superpowers:verification-before-completion before claims.
A failing test must demonstrate the named behavior, not unrelated missing setup;
a passing command must actually collect its new tests. Tests importing built
workspace dependencies need a fresh build after relevant source/export changes.

Commit each cohesive task with explicit file staging and a relevant fixed-group
patch Changeset for user-facing B4 package changes. Reuse deterministic fixtures
and actual storage/transport boundaries; do not write mirror-of-implementation
unit tests or new tests solely for reversible prose edits. Run existing docs/link/
render checks for prose instead. New backend/security/failure behavior needs
meaningful invariant tests and effect counters.

Scope Biome to changed files or use repo scripts; never bare biome check --write.
Source imports use .js and tests .ts in B4. Honor exactOptionalPropertyTypes.
Examples/scaffolds keep supported default models (gpt-5-mini). Preserve release
script/data pins and their reviewed snapshots if an affected file is in the
release reachability graph; an intentional pin update is reviewed, not bypassed.

For tests with new shared helpers, create the helper in the owning task first,
and make it call actual services/backends. Do not invent a product implementation
inside a fixture. New root test directories get an explicit runner/config include
so `pnpm test`/CI collects them; a zero-test successful command is a failure.

## 4. Invariants every component reviewer checks

- Authorized accepted-receipt lookup precedes mutable pause/head checks and the
  idle/resume/inject branch of run.start. An exact retry cannot become a second
  run, new injection or fresh approval because the server state changed.
- Grant batch/continuation/receipt/admission is all-or-nothing; external effects
  and remembered-rule I/O are never falsely included in a DB transaction.
- Started-before-invoke boundary and stale-writer fences preserve uncertainty;
  a retired task is not proof an external action never happened.
- Public status/result/command/lifecycle maps obey the pinned closed schemas;
  B4 metadata/custom carriers remain explicit extensions.
- Thread snapshot/projection/cursor is coherent; local application/cursor commits
  atomically; filtered gaps are legal and stale history cannot resurrect deletion.
- Native arbitrary strings/lifecycle/protobuf/SSE remain valid; discovery comes
  from standard Agent resources and generic peers require no B4 marker.
- No independent writer bypasses memory coordination, grant/privacy filtering
  or owner-device scope. New-kind sync is gated, not filtered and marked synced.
- Old execution data/cached history and independent memory/workspace/config/
  secrets/rules remain preserved; no legacy API stack, alias or automatic importer.

## 5. Review and integration checkpoints

After each task, review against its spec and test evidence. At each component
exit, run its required scoped/actual-backend tests, then current repo checks.
Use @superpowers:requesting-code-review for substantive components and resolve
findings before integrating dependent code. If using subagent-driven execution,
follow its separate spec-compliance and quality review stages per task.

Topic PRs target the dedicated integration branch. Keep main current/public
behavior coherent while components are incomplete; no normal production publish
from integration. Keep consumer/docs changes with their implementing components
and complete the final current-guidance audit in L1. Do not revive old routes
behind a compatibility flag to make intermediate consumers pass.

Final release qualification requires all current repository gates plus the
approved contract/fault/storage/native/generic/app/live/device matrix. Required
environment skips remain blocked, not N/A. Profile-specific exclusions are only
for honestly unadvertised optional host features; full Node SQLite/Postgres,
Store and native behavior cannot be waived by a mock or missing credential.

## 6. Handoff and completion records

Track task IDs, exact commits, commands/outcomes, review status and affected
schema/corpus versions in the execution log. Cross-repo consumer manifests pin
matching artifacts. Keep B4 and canonical b4app client plan/spec copies byte-
identical when changing shared documentation; schema changes require a reviewed
contract delta, not independent Swift interpretation.

Implementation is complete when all component exits and required prepublication
gates pass. Publication is a separate concrete checkpoint. The coordinated
release is complete only after L6's required actual postpublication/install/site/
project checks. Missing mandatory access/resources leaves the relevant gate open
and must be reported; never claim successful deployment or device behavior from
source review/build/fixtures.

This plan is saved for task-by-task execution. The handoff offers fresh-task
subagents with review between tasks (recommended) or inline batches through
@superpowers:executing-plans. Do not start implementation while merely documenting
or reviewing the plan.
