# Workspace Source Capture and Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture explicitly declared app files as immutable source bundles and persist/retrieve those bundles in SQLite after the checkout disappears.

**Architecture:** Node capture consumes declarative source descriptors and the existing canonical bundle primitive. A separate SQLite source-table component uses the same verifier on insert and read, and can later participate in the workspace association store's transactions. Neither component creates a sandbox or implicitly opens a runtime installation.

**Tech Stack:** TypeScript, Node filesystem/SQLite, existing workspace bundles, Vitest, pnpm.

---

## Scope and decisions

Implements the source capture and source-table portion of delivery stage 2 in
`docs/superpowers/specs/2026-09-14-workspace-implementation-contracts.md` and the
approved authoring proposal. Build/config integration, installation ownership,
association CAS/deletion, provider records, and code-fixer migration remain
dependent follow-on work. Do not claim this source table enforces runtime ownership.

Keep the current branch/worktree; no PR or push. Run commands at repo root.

### Source descriptor and capture

Create `packages/workspace/src/source-capture.ts`:

```ts
interface WorkspaceSourceDefinition {
  readonly directory: string
  readonly include: readonly string[]
  readonly excludeDirectories?: readonly string[]
  readonly files?: readonly (
    | { readonly path: string; readonly file: string }
    | { readonly path: string; readonly text: string; readonly executable?: boolean }
  )[]
}
function captureWorkspaceSource(
  appRoot: string,
  definition: WorkspaceSourceDefinition,
  options?: { readonly signal?: AbortSignal },
): Promise<SourceBundle>
```

directory/file references are relative to appRoot; include/exclusion paths are
relative to directory. No glob syntax. directory `.` is valid. All other paths
use the portable bundle path rules; parent traversal and absolute references are
rejected. Canonicalize appRoot once (allow its existing platform symlink spelling),
then reject symlinks in every descendant directory/file. Source files are regular
files only. Include is an exact required inventory; exclusions are explicit
directory subtrees, validated as directories without following symlinks. An
excluded path overlapping an included path is invalid. Exclusion paths must exist;
use none when the source directory has no excluded directories. Empty include is
valid only when the remaining inventory is empty. Extra file entries cannot
collide with included targets or one another.

Validate descriptor shape/counts/paths and inline UTF-8 roundtrip before touching
the filesystem. Reject getters, unknown fields, ambiguous file/text variants,
duplicate exclusions, directory casing ambiguity, and malformed arrays. Inline
text must preserve BOM and reject lone surrogates rather than replace them.
Source captures preserve filesystem executable bits. Referenced extra files also
preserve those bits; inline text defaults executable false.

Use opened file handles with O_NOFOLLOW and O_NONBLOCK, then fstat and bounded
reads. Check inode/device, size, mode, mtime and ctime before/after reading; check
directory identity and exact inventory before and after capture. Reject detected
changes. Never claim an atomic filesystem snapshot or protection against a
hostile host process repeatedly swapping ancestor directories: Node's portable
path API does not supply descriptor-relative openat traversal. This capture reads
a trusted app tree, not an agent-writable directory. No provider runs until a
successful immutable capture is persisted.

Bound traversal using opendir iteration (not unbounded recursive readdir): at most
10,000 visited entries including directories, path/segment limits from bundles,
10,000 resulting files, 16 MiB per file and 64 MiB total. Reject sizes before
allocating; read at most the verified size plus a one-byte growth probe, never
unbounded readFile on a mutable file. Check abort before IO and during traversal/
reads. All file/directory handles close on success, failure, and cancellation.

Factor reusable limits/path validation out of source-bundle into an internal
module if needed, preserving all existing bundle tests and encoding. Only Node
entry-point exports may contain capture/crypto runtime functions. Main barrel may
export types only. Add a patch changeset for the new Node source utilities.

### SQLite source table

Create `packages/sqlite-storage/src/workspace/source-store.ts` with internal
`makeWorkspaceSourceStore(db: DatabaseSync)` returning synchronous put/get methods:

```ts
interface WorkspaceSourceStore {
  put(bundle: SourceBundle): void
  get(digest: string): SourceBundle | undefined
}
```

The caller owns connection lifetime and installation admission. Constructor
requires an already opened connection with synchronous FULL (refuse NORMAL/OFF;
do not silently change another store's settings). Initialize a namespaced schema
version and source table transactionally, and reject future schema versions. Use
SAVEPOINTs so insertion/schema setup compose with an outer caller transaction;
rolling back that transaction must also roll back source insertion.

Store the full canonical serialized bundle with its primary-key digest. Verify
inputs before SQL; verify stored data before returning or treating a duplicate put
as success. Same digest and canonical content is idempotent. Corrupted rows must
not be overwritten as repair. A lookup must cross-check requested key against the
verified payload digest. Missing lookup returns undefined without creating data.
Validate digest spelling before SQL. Reject excessive stored payload size using
SQL byte-length selection before loading/parsing payload (96 MiB maximum encoded
record, sufficient for the bundle's existing limits), then verify strict record
shape/digest. No bundle eviction, deletion, or garbage collection in this slice.

Use a namespaced version table distinct from existing schema_version. Do not
modify checkpoint/thread schema. Add @b4run/workspace workspace dependency and
consume verifier/types from its supported Node entry point; no cross-package
source imports. Keep this connection-level storage factory internal until the
installation store is complete. Package source changes receive a patch changeset
without claiming a public managed-workspace store exists.

## Task 1: Capture implementation (independent after bundle foundation)

Files: create source-capture.ts, test/source-capture.test.ts; optionally create
internal source-validation.ts and update source-bundle.ts to reuse it. Modify
workspace/src/node.ts for Node exports and workspace/src/index.ts for types only.

- [ ] Add failing capture tests: exact files/BOM/binary/modes, generated text and
  external declared TASK.md, appRoot-relative resolution with changed cwd, strict
  missing/extra inventory, exclusions, traversal, links at every level, special
  files, descriptor conflicts, abort, limits, and detected mutation.
- [ ] Observe RED with `pnpm --filter @b4run/workspace exec vitest run test/source-capture.test.ts`.
- [ ] Implement bounded capture; add tests showing snapshot independence after
  changing/removing original source, plus descriptor rejection before IO.
- [ ] Run capture and existing bundle tests, then the workspace package suite,
  typecheck, and scoped Biome. Report exact results; do not commit other work.

## Task 2: Source-table implementation

Files: create sqlite-storage/src/workspace/source-store.ts and
sqlite-storage/test/workspace-source-store.test.ts; root owns package dependency,
lockfile, changeset, and documentation edits.

- [ ] Add failing SQLite tests: close/reopen retention, idempotent put, tampered
  payload/key, invalid inputs, oversized stored record, missing lookup with no
  insert, caller rollback, independent migration namespace, FULL requirement,
  future version refusal, and preserved corrupt rows after duplicate put.
- [ ] Build before running cross-package consumers: `pnpm build` after root adds
  dependency/Node exports and updates the lockfile. Do not consume stale dist.
- [ ] Observe RED, implement table component with prepared SQL and savepoints,
  rerun focused tests, then package suite/typecheck/scoped lint.

## Task 3: Cross-package verification and review

- [ ] Add an integration test in sqlite-storage that captures a temporary declared
  source, saves it, closes the DB, removes the source tree, reopens the DB, and
  reads exact original bytes. Use the supported workspace Node import.
- [ ] Root updates package READMEs to document the supported source capture
  utilities and the internal status of workspace persistence. Add patch changeset
  entries for workspace/sqlite-storage; update pnpm lockfile normally.
- [ ] Obtain independent spec review, then code-quality review; address findings
  with regression tests. Check symlink/TOCTOU claims match actual guarantees.
- [ ] Run both package suites/typechecks, scoped lint, build-cache check, docs
  check, changeset check, and full build. Run full repository validation before
  integrating the completed runtime feature, not as a claim for this partial stage.
- [ ] Commit reviewed files and record exact results below. Retain pending work
  explicitly: build/config source-artifact integration, durable installation and
  association ownership, providers/runtime, trusted context, and example correction.

## Results

Pending execution.
